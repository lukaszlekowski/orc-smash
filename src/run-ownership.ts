import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import {
  createLeaseClock,
  leaseExpired,
  observeLease,
  resetLeaseClockForTests as resetLeaseClockState,
  type LeaseClockState
} from './lease-clock.js';
import {
  resolveProcessIdentity,
  START_TOLERANCE_MS
} from './process-identity.js';

// Historical callers import these identity helpers from run-ownership. Keep
// the exports while process-identity remains their purpose-owned home.
export { getProcessCommand, getProcessStartTime } from './process-identity.js';

/**
 * Durable ownership state. This module owns the records and admission
 * lifecycle; process-group signalling is intentionally delegated to the
 * adapter runtime and its single kill gate.
 */

export const CURRENT_SCHEMA_VERSION = 1;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const ControlSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    runId: z.string(),
    ownerTokenHash: z.string(),
    projectRoot: z.string(),
    hostInstanceId: z.string(),
    leaseIssuedMs: z.number(),
    leaseTtlMs: z.number(),
    leaseExpiresMs: z.number(),
    issuerRevision: z.number()
  })
  .strict();
export type ControlRecord = z.infer<typeof ControlSchema>;

export const GroupIdentitySchema = z
  .object({
    pgid: z.number().int().positive(),
    leaderPid: z.number().int().positive(),
    sessionId: z.number().int().positive(),
    leaderStartMs: z.number(),
    /** Human-readable diagnostic command retained for status only. */
    command: z.string(),
    /** Bootstrap executable path; never used as sole kill authority. */
    bootstrapExecutablePath: z.string().optional(),
    /** Expected provider executable path. */
    executablePath: z.string().optional(),
    /** Linux incarnation evidence; intentionally omitted on macOS. */
    argvFingerprint: z.string().optional()
  })
  .strict();
export type GroupIdentity = z.infer<typeof GroupIdentitySchema>;

export const ActiveSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    cliIdentity: z.object({
      pid: z.number().int().positive(),
      startMs: z.number(),
      command: z.string()
    }).strict(),
    groups: z.array(GroupIdentitySchema),
    state: z.enum(['starting', 'running', 'stopping', 'completed', 'failed', 'stopped']),
    reason: z.string().optional(),
    recoveryAtMs: z.number().optional(),
    cliRevision: z.number().int().nonnegative()
  })
  .strict();
export type ActiveRecord = z.infer<typeof ActiveSchema>;

export const ProjectSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    currentRunId: z.string(),
    runDir: z.string(),
    pid: z.number().int().positive(),
    startMs: z.number(),
    state: z.string()
  })
  .strict();
export type ProjectRecord = z.infer<typeof ProjectSchema>;

export const LockSchema = z
  .object({
    schemaVersion: z.literal(CURRENT_SCHEMA_VERSION),
    runId: z.string(),
    pid: z.number().int().positive(),
    startMs: z.number(),
    runDir: z.string(),
    command: z.string(),
    projectRoot: z.string().optional()
  })
  .strict();
export type LockRecord = z.infer<typeof LockSchema>;

export interface OwnershipContext {
  token: string;
  runId: string;
  stateDir: string;
  projectDir: string;
  runDir: string;
  control: ControlRecord;
  env: Record<string, string>;
  leaseClock?: LeaseClockState;
  /** Sticky compatibility field; leaseClock is the source of truth. */
  hasObservedExpired?: boolean;
}

export type OwnershipRecordKind = 'control' | 'active' | 'project' | 'lock';

class OwnershipRecordError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'OwnershipRecordError';
    this.code = code;
  }
}

export function unsupportedRecordError(filePath: string, detail = 'missing, malformed, or unsupported schemaVersion'): OwnershipRecordError {
  return new OwnershipRecordError('unsupported-record', `unsupported-record: ${detail} (${filePath})`);
}

function stateRoot(baseDir?: string): string {
  return path.resolve(baseDir ?? process.env['ORC_RUN_STATE_DIR'] ?? os.tmpdir());
}

export function getBaseStateDir(override?: string): string {
  return stateRoot(override ?? process.env['ORC_RUN_STATE_DIR'] ?? process.env['XDG_RUNTIME_DIR'] ?? os.tmpdir());
}

function validateRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`Invalid run id: ${runId}`);
  }
}

export function getProjectDir(projectRoot: string, baseDir?: string): string {
  const canonicalRoot = fs.realpathSync(projectRoot);
  const hash = crypto.createHash('sha256').update(canonicalRoot).digest('hex');
  return path.join(getBaseStateDir(baseDir), 'orc-smash', 'projects', hash);
}

export function getRunDir(runId: string, baseDir?: string): string {
  validateRunId(runId);
  return path.join(getBaseStateDir(baseDir), 'orc-smash', 'runs', runId);
}

function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

export function secureMkdir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  fs.chmodSync(dirPath, 0o700);
}

export function verifyDirectoryPermissions(dirPath: string): void {
  const stat = fs.lstatSync(dirPath);
  if (!stat.isDirectory()) throw new Error(`Ownership state path is not a directory: ${dirPath}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`Directory permissions are too loose: ${dirPath}`);
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`Directory is not owned by the current user: ${dirPath}`);
}

export function verifyFilePermissions(filePath: string): void {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error(`Ownership state path is not a regular file: ${filePath}`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`File permissions are too loose: ${filePath}`);
  const uid = currentUid();
  if (uid !== undefined && stat.uid !== uid) throw new Error(`File is not owned by the current user: ${filePath}`);
}

function fsyncDirectory(dirPath: string): void {
  const fd = fs.openSync(dirPath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Exclusive temp-file + file fsync + rename + parent-directory fsync. */
export function writeJsonAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  secureMkdir(dir);
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`
  );
  const fd = fs.openSync(tempPath, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(data));
    fs.fchmodSync(fd, 0o600);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tempPath, filePath);
    fsyncDirectory(dir);
  } catch (error) {
    try { fs.unlinkSync(tempPath); } catch { /* preserve the original failure */ }
    throw error;
  }
}

function readRecord<T>(filePath: string, schema: z.ZodType<T>, kind: OwnershipRecordKind): T {
  try {
    verifyDirectoryPermissions(path.dirname(filePath));
    verifyFilePermissions(filePath);
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw unsupportedRecordError(filePath, `${kind} record is not a JSON object`);
    }
    const schemaVersion = (raw as { schemaVersion?: unknown }).schemaVersion;
    if (schemaVersion !== CURRENT_SCHEMA_VERSION) {
      throw unsupportedRecordError(filePath, `${kind} record schemaVersion is not ${CURRENT_SCHEMA_VERSION}`);
    }
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof OwnershipRecordError) throw error;
    if (error instanceof z.ZodError || error instanceof SyntaxError) {
      throw unsupportedRecordError(filePath, `${kind} record failed schema validation`);
    }
    throw error;
  }
}

export function readControl(runDir: string): ControlRecord {
  const result = readRecord(path.join(runDir, 'control.json'), ControlSchema, 'control');
  // Importing the pure validator here would create no runtime cycle, but the
  // lease clock is the canonical tuple rule and is applied when a context is
  // opened/observed. This catches malformed issuer records at the boundary.
  createLeaseClock(result);
  return result;
}

export function readActive(runDir: string): ActiveRecord {
  return readRecord(path.join(runDir, 'active.json'), ActiveSchema, 'active');
}

export function writeActive(runDir: string, record: ActiveRecord): void {
  writeJsonAtomic(path.join(runDir, 'active.json'), ActiveSchema.parse(record));
}

export function readProjectIndex(projectDir: string): ProjectRecord {
  return readRecord(path.join(projectDir, 'project.json'), ProjectSchema, 'project');
}

export function writeProjectIndex(projectDir: string, record: ProjectRecord): void {
  writeJsonAtomic(path.join(projectDir, 'project.json'), ProjectSchema.parse(record));
}

export function readLock(projectDir: string): LockRecord {
  return readRecord(path.join(projectDir, 'project.lock'), LockSchema, 'lock');
}

function withSchema<T extends object>(record: T): T & { schemaVersion: typeof CURRENT_SCHEMA_VERSION } {
  return { schemaVersion: CURRENT_SCHEMA_VERSION, ...record };
}

function commandMatches(expected: string, observed: string): boolean {
  return expected === observed || path.basename(expected) === path.basename(observed);
}

export function verifyIdentity(tuple: { pid: number; startMs: number; command: string }): boolean {
  const observed = resolveProcessIdentity(tuple.pid);
  if (observed.status !== 'verified') {
    // See the current-pid fallback in process-identity.ts. It keeps local
    // admission tests usable in sandboxes that hide process tables without
    // ever treating a foreign pid as live.
    if (tuple.pid !== process.pid) return false;
    const start = Date.now() - Math.round(process.uptime() * 1000);
    return Math.abs(start - tuple.startMs) <= START_TOLERANCE_MS && commandMatches(tuple.command, process.execPath);
  }
  if (Math.abs(observed.startEvidence.value - tuple.startMs) > START_TOLERANCE_MS) return false;
  return commandMatches(tuple.command, observed.executablePath);
}

function identityIsLive(identity: { pid: number; startMs: number; command: string }): boolean {
  return verifyIdentity(identity);
}

function lockRecordFor(lockRecord: LockRecord): LockRecord {
  return LockSchema.parse(withSchema(lockRecord));
}

function readProjectLockIfPresent(projectDir: string): LockRecord | null {
  const lockPath = path.join(projectDir, 'project.lock');
  if (!fs.existsSync(lockPath)) return null;
  verifyDirectoryPermissions(projectDir);
  return readLock(projectDir);
}

/**
 * Acquire project admission with the same O_EXCL primitive on first launch and
 * stale reclaim. A rejected/ambiguous reconciliation retains the old lock.
 */
export async function acquireProjectLock(projectDir: string, inputRecord: LockRecord): Promise<void> {
  secureMkdir(projectDir);
  const record = lockRecordFor(inputRecord);
  const lockPath = path.join(projectDir, 'project.lock');
  let acquired = false;

  try {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fsyncDirectory(projectDir);
    acquired = true;
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
  }

  if (!acquired) {
    const current = readProjectLockIfPresent(projectDir);
    if (!current) throw new Error(`Ownership admission lock disappeared: ${lockPath}`);
    if (identityIsLive({ pid: current.pid, startMs: current.startMs, command: current.command })) {
      throw new Error(`Another live run owns this canonical project (PID: ${current.pid})`);
    }

    try {
      await reconcileOnStart(current.runDir);
    } catch (error: any) {
      throw new Error(
        `Stale run reconciliation failed, terminal ownership-failure state retained; operator recovery required: ${error?.message ?? String(error)}`
      );
    }

    // The stale holder is now reconciled. Reclaim through unlink + O_EXCL. If
    // another launcher wins, re-read and reject/ retry rather than overwriting.
    const maxAttempts = 8;
    for (let attempt = 0; attempt < maxAttempts && !acquired; attempt++) {
      try {
        fs.unlinkSync(lockPath);
        fsyncDirectory(projectDir);
      } catch (error: any) {
        if (error?.code !== 'ENOENT') throw error;
      }
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(record));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fsyncDirectory(projectDir);
        acquired = true;
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        const contender = readProjectLockIfPresent(projectDir);
        if (!contender) continue;
        if (identityIsLive({ pid: contender.pid, startMs: contender.startMs, command: contender.command })) {
          throw new Error(`Another live run owns this canonical project (PID: ${contender.pid})`);
        }
      }
    }
    if (!acquired) throw new Error(`Failed to reclaim project admission lock after ${maxAttempts} attempts`);
  }

  const projectRecord: ProjectRecord = withSchema({
    currentRunId: record.runId,
    runDir: record.runDir,
    pid: record.pid,
    startMs: record.startMs,
    state: 'starting'
  });
  writeProjectIndex(projectDir, ProjectSchema.parse(projectRecord));
}

/** Remove only a lock and project pointer belonging to the requested run. */
export function releaseProjectLock(projectDir: string, runId: string): boolean {
  const lockPath = path.join(projectDir, 'project.lock');
  const projectPath = path.join(projectDir, 'project.json');
  if (!fs.existsSync(lockPath)) return false;

  const lock = readLock(projectDir);
  if (lock.runId !== runId) return false;
  let project: ProjectRecord | null = null;
  if (fs.existsSync(projectPath)) project = readProjectIndex(projectDir);
  if (project && (project.currentRunId !== runId || project.runDir !== lock.runDir)) return false;

  if (project) fs.unlinkSync(projectPath);
  // Remove the pointer before the lock. If the second unlink fails (or the
  // process crashes between them), the lock still retains admission and can be
  // recovered explicitly; removing the lock first would lose the gate.
  fs.unlinkSync(lockPath);
  fsyncDirectory(projectDir);
  return true;
}

// --- Lease transition / admission gates -------------------------------------

export function isExpired(expiresMs: number, ctx?: OwnershipContext, now = Date.now()): boolean {
  if (ctx?.leaseClock) {
    const expired = leaseExpired(ctx.leaseClock, now);
    ctx.hasObservedExpired = expired;
    return expired;
  }
  if (ctx) {
    if (ctx.hasObservedExpired) return true;
    if (now >= expiresMs) {
      ctx.hasObservedExpired = true;
      return true;
    }
    return false;
  }
  return now >= expiresMs;
}

export function resetLeaseClock(): void {
  resetLeaseClockState();
}

export function mayStartStep(
  control: ControlRecord,
  active: ActiveRecord,
  now = Date.now(),
  ctx?: OwnershipContext
): boolean {
  if (ctx?.leaseClock && leaseExpired(ctx.leaseClock, now)) return false;
  if (isExpired(control.leaseExpiresMs, ctx, now)) return false;
  return !['completed', 'failed', 'stopped'].includes(active.state);
}

export function tokenMatches(token: string, hash: string): boolean {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (!/^[0-9a-f]{64}$/i.test(hash)) return false;
  return crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(hash));
}

export async function authorizeLiveRunSignal(
  _handle: unknown,
  options: { liveToken: string },
  control: ControlRecord
): Promise<boolean> {
  return tokenMatches(options.liveToken, control.ownerTokenHash);
}

export async function authorizeReconcileSignal(
  _handle: unknown,
  cliIdentity: { pid: number; startMs: number; command: string },
  runDir: string
): Promise<boolean> {
  try {
    if (identityIsLive(cliIdentity)) return false;
    verifyFilePermissions(path.join(runDir, 'active.json'));
    return true;
  } catch {
    return false;
  }
}

function activeWithState(record: ActiveRecord, state: ActiveRecord['state'], reason?: string): ActiveRecord {
  return {
    ...record,
    state,
    ...(reason === undefined ? {} : { reason }),
    cliRevision: record.cliRevision + 1
  };
}

/**
 * Restart reconciliation never reconstructs fresh authority. On macOS the
 * durable gate therefore rejects every registered group and retains admission.
 */
export async function reconcileOnStart(priorRunDir: string): Promise<void> {
  const activePath = path.join(priorRunDir, 'active.json');
  if (!fs.existsSync(activePath)) return;
  const record = readActive(priorRunDir);
  if (['completed', 'failed', 'stopped'].includes(record.state)) return;

  if (record.groups.length === 0) {
    writeActive(priorRunDir, activeWithState(record, 'failed', 'reconciled-stale-run'));
    return;
  }

  const { terminateProcessGroup, isProcessGroupAbsent } = await import('./adapters/process-group.js');
  const retired: GroupIdentity[] = [];
  for (const group of record.groups) {
    const result = await terminateProcessGroup({
      pgid: group.pgid,
      leaderPid: group.leaderPid,
      sessionId: group.sessionId,
      leaderStartMs: group.leaderStartMs,
      bootstrapExecutablePath: group.bootstrapExecutablePath ?? process.execPath,
      executablePath: group.executablePath ?? group.command,
      argvFingerprint: group.argvFingerprint
    }, 2000, 'durable');

    if (result.outcome === 'rejected' || !(await isProcessGroupAbsent({
      pgid: group.pgid,
      leaderPid: group.leaderPid,
      sessionId: group.sessionId,
      leaderStartMs: group.leaderStartMs,
      bootstrapExecutablePath: group.bootstrapExecutablePath ?? process.execPath,
      executablePath: group.executablePath ?? group.command,
      argvFingerprint: group.argvFingerprint
    }, 'durable'))) {
      const failed = activeWithState(
        record,
        'failed',
        `terminal ownership-failure: stale group ${group.pgid} could not be verified for safe cleanup`
      );
      writeActive(priorRunDir, failed);
      throw new Error(`terminal ownership-failure: stale group ${group.pgid} retained for operator recovery`);
    }
    retired.push(group);
  }

  writeActive(priorRunDir, {
    ...activeWithState(record, 'failed', 'reconciled-stale-run'),
    groups: record.groups.filter((group) => !retired.some((item) => item.pgid === group.pgid)),
    cliRevision: record.cliRevision + 2
  });
}

export function registerGroup(runDir: string, handle: GroupIdentity): void {
  const record = readActive(runDir);
  if (['completed', 'failed', 'stopped'].includes(record.state)) {
    throw new Error(`Cannot register a group for terminal active record: ${runDir}`);
  }
  if (record.groups.some((group) => group.pgid === handle.pgid && group.leaderPid === handle.leaderPid)) return;
  writeActive(runDir, {
    ...record,
    state: 'running',
    groups: [...record.groups, GroupIdentitySchema.parse(handle)],
    cliRevision: record.cliRevision + 1
  });
}

export async function confirmGroupClosed(runDir: string, handle: GroupIdentity): Promise<void> {
  const { isProcessGroupAbsent } = await import('./adapters/process-group.js');
  const absent = await isProcessGroupAbsent({
    pgid: handle.pgid,
    leaderPid: handle.leaderPid,
    sessionId: handle.sessionId,
    leaderStartMs: handle.leaderStartMs,
      bootstrapExecutablePath: handle.bootstrapExecutablePath ?? process.execPath,
      executablePath: handle.executablePath ?? handle.command,
    argvFingerprint: handle.argvFingerprint
  }, 'fresh');
  if (!absent) throw new Error(`ownership-failure: process group ${handle.pgid} still exists`);

  const record = readActive(runDir);
  const groups = record.groups.filter((group) => group.pgid !== handle.pgid || group.leaderPid !== handle.leaderPid);
  if (groups.length === record.groups.length) return;
  writeActive(runDir, { ...record, groups, cliRevision: record.cliRevision + 1 });
}

function terminalRecord(runDir: string, state: ActiveRecord['state'], reason?: string): ActiveRecord {
  const record = readActive(runDir);
  if (record.groups.length > 0) throw new Error(`Cannot ${state} run: active groups remain in active.json`);
  return activeWithState(record, state, reason);
}

export function completeRun(runDir: string, projectDir: string, runId: string): void {
  writeActive(runDir, terminalRecord(runDir, 'completed'));
  releaseProjectLock(projectDir, runId);
}

export function failRun(runDir: string, projectDir: string, runId: string, reason: string): void {
  writeActive(runDir, terminalRecord(runDir, 'failed', reason));
  releaseProjectLock(projectDir, runId);
}

export function stopRun(runDir: string, projectDir: string, runId: string, reason: string): void {
  writeActive(runDir, terminalRecord(runDir, 'stopped', reason));
  releaseProjectLock(projectDir, runId);
}

export function writeControl(runDir: string, control: ControlRecord): void {
  const parsed = ControlSchema.parse(control);
  createLeaseClock(parsed);
  writeJsonAtomic(path.join(runDir, 'control.json'), parsed);
}

// --- In-flight watcher and completion fence ---------------------------------

function contextLeaseClock(ctx: OwnershipContext): LeaseClockState {
  if (!ctx.leaseClock) ctx.leaseClock = createLeaseClock(ctx.control);
  return ctx.leaseClock;
}

export function watchLease(
  ctx: OwnershipContext,
  opts?: { intervalMs?: number; maxReadErrors?: number }
): { expired: Promise<void>; cancel(): void } {
  const intervalMs = Math.max(1, opts?.intervalMs ?? Number.parseInt(process.env['ORC_LEASE_WATCH_INTERVAL_MS'] ?? '500', 10));
  const maxReadErrors = Math.max(1, opts?.maxReadErrors ?? Number.parseInt(process.env['ORC_LEASE_WATCH_MAX_READ_ERRORS'] ?? '3', 10));
  const clock = contextLeaseClock(ctx);
  let timer: NodeJS.Timeout | null = null;
  let consecutiveErrors = 0;
  let settled = false;
  let resolveExpired!: () => void;
  const expired = new Promise<void>((resolve) => { resolveExpired = resolve; });

  const failClosed = () => {
    if (!settled) {
      settled = true;
      clock.observedExpired = true;
      ctx.hasObservedExpired = true;
      resolveExpired();
    }
  };

  const check = () => {
    try {
      const record = readControl(ctx.runDir);
      const observation = observeLease(clock, record);
      if (!observation.accepted) {
        consecutiveErrors++;
        if (consecutiveErrors >= maxReadErrors) failClosed();
        return;
      }
      consecutiveErrors = 0;
      if (observation.expired) failClosed();
    } catch {
      consecutiveErrors++;
      if (consecutiveErrors >= maxReadErrors) failClosed();
    }
  };

  timer = setInterval(check, intervalMs);
  timer.unref();
  check();

  return {
    expired,
    cancel() {
      if (timer) clearInterval(timer);
      timer = null;
    }
  };
}

export async function ownershipFence(ctx: OwnershipContext, loopSpec: unknown): Promise<boolean> {
  try {
    const observation = observeLease(contextLeaseClock(ctx), readControl(ctx.runDir));
    if (!observation.accepted || observation.expired) throw new Error(observation.accepted ? 'lease expired' : observation.reason);
    return true;
  } catch {
    const { handleOwnershipLoss } = await import('./interrupted-artifact.js');
    await handleOwnershipLoss(loopSpec as any, ctx);
    return false;
  }
}

// --- Terminal finalization ---------------------------------------------------

export async function finalizeOwnedRun(
  ctx: OwnershipContext | null,
  runOutcome: { success: boolean; verdict: string; message?: string }
): Promise<void> {
  if (!ctx) return;
  const activePath = path.join(ctx.runDir, 'active.json');
  if (!fs.existsSync(activePath)) return;
  const initial = readActive(ctx.runDir);
  if (['completed', 'failed', 'stopped'].includes(initial.state)) return;

  const { terminateOwnedRuntimes } = await import('./owned-runtime-registry.js');
  const terminations = await terminateOwnedRuntimes(
    2000,
    (capability) => capability.runId === ctx.runId && capability.runDir === ctx.runDir
  );
  const rejected = terminations.filter((entry) => entry.result.outcome === 'rejected' || !entry.retired);
  const after = readActive(ctx.runDir);

  if (rejected.length > 0 || after.groups.length > 0) {
    const reason = rejected.length > 0
      ? `terminal ownership-failure during finalization: ${rejected.map((entry) => {
          if (entry.result.outcome === 'rejected') return entry.result.reason;
          if (entry.result.outcome === 'already-gone') return entry.result.reason;
          return 'runtime capability was not retired';
        }).join('; ')}`
      : 'terminal ownership-failure during finalization: active groups remain';
    writeActive(ctx.runDir, { ...after, state: 'failed', reason, cliRevision: after.cliRevision + 1 });
    throw new Error(reason);
  }

  if (runOutcome.verdict === 'ownership-lost') {
    stopRun(ctx.runDir, ctx.projectDir, ctx.runId, 'ownership-lost');
  } else if (runOutcome.success) {
    completeRun(ctx.runDir, ctx.projectDir, ctx.runId);
  } else if (runOutcome.verdict === 'user-stop') {
    stopRun(ctx.runDir, ctx.projectDir, ctx.runId, 'user-stop');
  } else {
    failRun(ctx.runDir, ctx.projectDir, ctx.runId, runOutcome.message || 'run-failed');
  }
}
