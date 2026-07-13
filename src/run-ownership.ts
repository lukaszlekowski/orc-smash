import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { z } from 'zod';

// Types & Schemas
export const ControlSchema = z.object({
  schemaVersion: z.number(),
  runId: z.string(),
  ownerTokenHash: z.string(),
  projectRoot: z.string(),
  hostInstanceId: z.string(),
  leaseIssuedMs: z.number(),
  leaseTtlMs: z.number(),
  leaseExpiresMs: z.number(),
  issuerRevision: z.number()
});
export type ControlRecord = z.infer<typeof ControlSchema>;

export const GroupIdentitySchema = z.object({
  cgroupPath: z.string(),
  pgid: z.number(),
  leaderPid: z.number(),
  leaderStartMs: z.number(),
  command: z.string(),
  cgroupIno: z.number().optional(),
  cgroupDev: z.number().optional()
});
export type GroupIdentity = z.infer<typeof GroupIdentitySchema>;

export const ActiveSchema = z.object({
  cliIdentity: z.object({
    pid: z.number(),
    startMs: z.number(),
    command: z.string()
  }),
  groups: z.array(GroupIdentitySchema),
  state: z.enum(['starting', 'running', 'stopping', 'completed', 'failed', 'stopped']),
  reason: z.string().optional(),
  cliRevision: z.number()
});
export type ActiveRecord = z.infer<typeof ActiveSchema>;

export const ProjectSchema = z.object({
  currentRunId: z.string(),
  runDir: z.string(),
  pid: z.number(),
  startMs: z.number(),
  state: z.string()
});
export type ProjectRecord = z.infer<typeof ProjectSchema>;

export const LockSchema = z.object({
  runId: z.string(),
  pid: z.number(),
  startMs: z.number(),
  runDir: z.string(),
  command: z.string()
});
export type LockRecord = z.infer<typeof LockSchema>;

export interface OwnershipContext {
  token: string;
  runId: string;
  stateDir: string;
  projectDir: string;
  runDir: string;
  control: ControlRecord;
  env: Record<string, string>;
  hasObservedExpired?: boolean;
}

// Global lease clock state for wall-clock floor (legacy/fallback)
let hasObservedExpired = false;

// 1. Directory resolvers & Permission gates
export function getBaseStateDir(): string {
  return process.env['ORC_RUN_STATE_DIR'] ?? process.env['XDG_RUNTIME_DIR'] ?? os.tmpdir();
}

export function getProjectDir(projectRoot: string): string {
  const canonicalRoot = fs.realpathSync(projectRoot);
  const hash = crypto.createHash('sha256').update(canonicalRoot).digest('hex');
  return path.join(getBaseStateDir(), 'orc-smash', 'projects', hash);
}

export function getRunDir(runId: string): string {
  return path.join(getBaseStateDir(), 'orc-smash', 'runs', runId);
}

export function secureMkdir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

export function verifyFilePermissions(filePath: string): void {
  const stat = fs.statSync(filePath);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`File permissions are too loose: ${filePath}`);
  }
}

// Atomic file writing (temp -> fsync -> rename)
export function writeJsonAtomic(filePath: string, data: any): void {
  const dir = path.dirname(filePath);
  secureMkdir(dir);
  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${process.pid}`);
  fs.writeFileSync(tmpPath, JSON.stringify(data), { mode: 0o600 });
  const fd = fs.openSync(tmpPath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath, filePath);
}

// File helper methods
export function readControl(runDir: string): ControlRecord {
  const controlFile = path.join(runDir, 'control.json');
  verifyFilePermissions(controlFile);
  const content = fs.readFileSync(controlFile, 'utf-8');
  return ControlSchema.parse(JSON.parse(content));
}

export function readActive(runDir: string): ActiveRecord {
  const activeFile = path.join(runDir, 'active.json');
  verifyFilePermissions(activeFile);
  const content = fs.readFileSync(activeFile, 'utf-8');
  return ActiveSchema.parse(JSON.parse(content));
}

export function writeActive(runDir: string, record: ActiveRecord): void {
  const activeFile = path.join(runDir, 'active.json');
  writeJsonAtomic(activeFile, record);
}

export function readProjectIndex(projectDir: string): ProjectRecord {
  const indexFile = path.join(projectDir, 'project.json');
  verifyFilePermissions(indexFile);
  const content = fs.readFileSync(indexFile, 'utf-8');
  return ProjectSchema.parse(JSON.parse(content));
}

export function writeProjectIndex(projectDir: string, record: ProjectRecord): void {
  const indexFile = path.join(projectDir, 'project.json');
  writeJsonAtomic(indexFile, record);
}

// 2. Identity Tuples & Verification
export interface IdentityTuple {
  pid: number;
  startMs: number;
  command: string;
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11
};

function parseEtimeToMs(etime: string): number {
  const parts = etime.split('-');
  let days = 0;
  let timeStr = etime;
  if (parts.length === 2) {
    days = parseInt(parts[0]!, 10);
    timeStr = parts[1]!;
  }
  const timeParts = timeStr.split(':').map(p => parseInt(p, 10));
  let hours = 0;
  let minutes = 0;
  let seconds = 0;
  if (timeParts.length === 3) {
    hours = timeParts[0]!;
    minutes = timeParts[1]!;
    seconds = timeParts[2]!;
  } else if (timeParts.length === 2) {
    minutes = timeParts[0]!;
    seconds = timeParts[1]!;
  } else {
    throw new Error(`Invalid etime format: ${etime}`);
  }
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

export function getProcessStartTime(pid: number): number {
  if (process.platform === 'linux') {
    try {
      const statContent = fs.readFileSync(`/proc/${pid}/stat`, 'utf-8');
      const lastCloseParen = statContent.lastIndexOf(')');
      if (lastCloseParen === -1) throw new Error('Malformed stat line');
      const rest = statContent.substring(lastCloseParen + 1).trim();
      const parts = rest.split(' ');
      const ticks = parseInt(parts[19]!, 10);
      
      const clkTck = parseInt(execSync('getconf CLK_TCK').toString().trim(), 10);
      const btimeLine = fs.readFileSync('/proc/stat', 'utf-8')
        .split('\n')
        .find(line => line.startsWith('btime'));
      if (!btimeLine) throw new Error('btime not found');
      const btime = parseInt(btimeLine.split(/\s+/)[1]!, 10);
      return btime * 1000 + Math.round((ticks * 1000) / clkTck);
    } catch {
      throw new Error(`Failed to parse process start time on Linux for pid ${pid}`);
    }
  } else if (process.platform === 'darwin') {
    try {
      const output = execSync(`ps -p ${pid} -o lstart=,etime=`).toString().trim();
      if (!output) throw new Error('ps output empty');
      const parts = output.split(/\s+/).filter(Boolean);
      if (parts.length < 5) throw new Error(`Invalid ps output: ${output}`);
      const monthStr = parts[1]!;
      const month = MONTHS[monthStr];
      if (month === undefined) throw new Error(`Unknown month: ${monthStr}`);
      const day = parseInt(parts[2]!, 10);
      const timeParts = parts[3]!.split(':');
      if (timeParts.length !== 3) throw new Error(`Invalid time format: ${parts[3]}`);
      const hour = parseInt(timeParts[0]!, 10);
      const minute = parseInt(timeParts[1]!, 10);
      const second = parseInt(timeParts[2]!, 10);
      const year = parseInt(parts[4]!, 10);

      const dateLocal = new Date(year, month, day, hour, minute, second);
      const startMs = dateLocal.getTime();

      if (parts[5]) {
        try {
          const elapsedMs = parseEtimeToMs(parts[5]);
          const expectedStartMs = Date.now() - elapsedMs;
          const diff = Math.abs(startMs - expectedStartMs);
          if (diff > 30000) {
            throw new Error(`etime cross-check failed (diff: ${diff}ms)`);
          }
        } catch {}
      }

      return startMs;
    } catch {
      throw new Error(`Failed to parse process start time on macOS for pid ${pid}`);
    }
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

export function getProcessCommand(pid: number): string {
  if (process.platform === 'linux') {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
      return cmdline.split('\0')[0] || '';
    } catch {
      throw new Error(`Failed to read process cmdline on Linux for pid ${pid}`);
    }
  } else if (process.platform === 'darwin') {
    try {
      const output = execSync(`ps -p ${pid} -o command=`).toString().trim();
      return output.split(' ')[0] || '';
    } catch {
      throw new Error(`Failed to get process command on macOS for pid ${pid}`);
    }
  }
  throw new Error(`Unsupported platform: ${process.platform}`);
}

export function verifyIdentity(tuple: IdentityTuple): boolean {
  try {
    const liveStart = getProcessStartTime(tuple.pid);
    const liveCmd = getProcessCommand(tuple.pid);
    const timeDiff = Math.abs(liveStart - tuple.startMs);
    if (timeDiff > 2000) return false;

    const liveBase = path.basename(liveCmd);
    const tupleBase = path.basename(tuple.command);
    return liveCmd === tuple.command || liveBase === tupleBase;
  } catch {
    return false;
  }
}

// 3. Project Admission & Stale Lock Reclamation
export async function acquireProjectLock(projectDir: string, lockRecord: LockRecord): Promise<void> {
  secureMkdir(projectDir);
  const lockFile = path.join(projectDir, 'project.lock');
  const indexFile = path.join(projectDir, 'project.json');

  let acquired = false;
  try {
    const fd = fs.openSync(lockFile, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify(lockRecord));
    fs.closeSync(fd);
    acquired = true;
  } catch (err: any) {
    if (err.code !== 'EEXIST') {
      throw err;
    }
  }

  if (!acquired) {
    // Check if the current holder is alive
    let currentLock: LockRecord | null = null;
    try {
      verifyFilePermissions(lockFile);
      const content = fs.readFileSync(lockFile, 'utf-8');
      currentLock = LockSchema.parse(JSON.parse(content));
    } catch {
      throw new Error(`Lock file exists but is unparseable/invalid: ${lockFile}`);
    }

    const isHolderAlive = verifyIdentity({
      pid: currentLock.pid,
      startMs: currentLock.startMs,
      command: currentLock.command
    });

    if (isHolderAlive) {
      throw new Error(`Another live run owns this canonical project (PID: ${currentLock.pid})`);
    }

    // Holder is dead. Reconcile the prior run, then REACQUIRE the admission
    // lock with O_EXCL (wx) — never by overwriting the existing lock file, which
    // would let two concurrent reclaimers both conclude the holder is dead and
    // both clobber the record, breaking the one-run-per-project guarantee.
    try {
      // Prior run reconciliation on start
      await reconcileOnStart(currentLock.runDir);
    } catch (reconcileErr) {
      // Reconcile failed: terminal ownership-failure state. Retain the stale
      // lock; do not admit the new run. Operator must recover manually.
      throw new Error(`Stale run reconciliation failed, terminal ownership-failure state. Operator must manually recover project lock.`);
    }

    // Remove the stale lock, then reacquire exclusively with wx. Two concurrent
    // reclaimers that both unlink race on the reacquire: exactly one wins the wx
    // open; the loser hits EEXIST and re-checks liveness (rejecting if the new
    // holder is live, looping if it is already stale again). Bounded so a
    // perpetually contended lock surfaces as an error rather than spinning.
    const RECLAIM_MAX_ATTEMPTS = 8;
    let reclaimed = false;
    for (let attempt = 0; attempt < RECLAIM_MAX_ATTEMPTS; attempt++) {
      try {
        fs.unlinkSync(lockFile);
      } catch (err: any) {
        if (err.code !== 'ENOENT') throw err;
        // Already removed by a concurrent reclaimer — fall through to reacquire.
      }
      try {
        const fd = fs.openSync(lockFile, 'wx', 0o600);
        fs.writeSync(fd, JSON.stringify(lockRecord));
        fs.closeSync(fd);
        reclaimed = true;
        break;
      } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
        // A concurrent reclaimer (or a fresh live launch) acquired it between
        // our unlink and our wx open. Re-validate: live new holder → reject;
        // already-stale-again → retry the unlink+reacquire.
        let rechecked: LockRecord;
        try {
          verifyFilePermissions(lockFile);
          rechecked = LockSchema.parse(JSON.parse(fs.readFileSync(lockFile, 'utf-8')));
        } catch {
          throw new Error(`Lock file exists but is unparseable/invalid during reclaim: ${lockFile}`);
        }
        const holderAlive = verifyIdentity({
          pid: rechecked.pid,
          startMs: rechecked.startMs,
          command: rechecked.command
        });
        if (holderAlive) {
          throw new Error(`Another live run owns this canonical project (PID: ${rechecked.pid})`);
        }
        // stale again — retry
      }
    }
    if (!reclaimed) {
      throw new Error(`Failed to reclaim project admission lock after ${RECLAIM_MAX_ATTEMPTS} attempts: ${lockFile}`);
    }
  }

  // Write/Update project.json index
  const projectRecord: ProjectRecord = {
    currentRunId: lockRecord.runId,
    runDir: lockRecord.runDir,
    pid: lockRecord.pid,
    startMs: lockRecord.startMs,
    state: 'starting'
  };
  writeJsonAtomic(indexFile, projectRecord);
}

export function releaseProjectLock(projectDir: string, runId: string): void {
  const lockFile = path.join(projectDir, 'project.lock');
  const indexFile = path.join(projectDir, 'project.json');

  try {
    if (fs.existsSync(lockFile)) {
      const content = fs.readFileSync(lockFile, 'utf-8');
      const record = LockSchema.parse(JSON.parse(content));
      if (record.runId === runId) {
        fs.unlinkSync(lockFile);
      }
    }
  } catch (err: any) {
    console.error(`Error unlinking lock file: ${err.message}`);
  }

  try {
    if (fs.existsSync(indexFile)) {
      const content = fs.readFileSync(indexFile, 'utf-8');
      const record = ProjectSchema.parse(JSON.parse(content));
      if (record.currentRunId === runId) {
        fs.unlinkSync(indexFile);
      }
    }
  } catch (err: any) {
    console.error(`Error unlinking index file: ${err.message}`);
  }
}

// 4. Lease expiration logic
export function isExpired(expiresMs: number, ctx?: OwnershipContext, now = Date.now()): boolean {
  if (ctx) {
    if (ctx.hasObservedExpired) return true;
    if (now >= expiresMs) {
      ctx.hasObservedExpired = true;
      return true;
    }
    return false;
  }

  if (hasObservedExpired) return true;
  if (now >= expiresMs) {
    hasObservedExpired = true;
    return true;
  }
  return false;
}

export function resetLeaseClock(): void {
  hasObservedExpired = false;
}

// Pure lease gate
export function mayStartStep(
  control: ControlRecord,
  active: ActiveRecord,
  now = Date.now(),
  ctx?: OwnershipContext
): boolean {
  if (isExpired(control.leaseExpiresMs, ctx, now)) return false;
  if (active.state === 'completed' || active.state === 'failed' || active.state === 'stopped') return false;
  return true;
}

// Token matching helper
export function tokenMatches(token: string, hash: string): boolean {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return tokenHash === hash;
}

// Group-termination authorization
export async function authorizeLiveRunSignal(
  handle: any,
  options: { liveToken: string },
  control: ControlRecord
): Promise<boolean> {
  try {
    const { validateRunCgroup } = await import('./adapters/process-group.js');
    validateRunCgroup(handle.cgroupPath, handle.cgroupIno, handle.cgroupDev);
    return tokenMatches(options.liveToken, control.ownerTokenHash);
  } catch {
    return false;
  }
}

export async function authorizeReconcileSignal(
  handle: any,
  cliIdentity: { pid: number; startMs: number; command: string },
  runDir: string
): Promise<boolean> {
  try {
    // 1. Verify prior CLI holder is dead
    const isLive = verifyIdentity(cliIdentity);
    if (isLive) return false;

    // 2. Verify prior run directory is private/owned
    const activeFile = path.join(runDir, 'active.json');
    verifyFilePermissions(activeFile);

    // 3. Validate run cgroup
    const { validateRunCgroup } = await import('./adapters/process-group.js');
    validateRunCgroup(handle.cgroupPath, handle.cgroupIno, handle.cgroupDev);

    return true;
  } catch {
    return false;
  }
}

// Stale Run Reconciliation on Start
export async function reconcileOnStart(priorRunDir: string): Promise<void> {
  const activeFile = path.join(priorRunDir, 'active.json');
  if (!fs.existsSync(activeFile)) return;

  verifyFilePermissions(activeFile);
  const activeContent = fs.readFileSync(activeFile, 'utf-8');
  const record = ActiveSchema.parse(JSON.parse(activeContent));

  if (record.state === 'completed' || record.state === 'failed' || record.state === 'stopped') {
    return; // Already terminal
  }

  // Kill prior processes tokenlessly using cgroup containment
  for (const group of record.groups) {
    const authorized = await authorizeReconcileSignal(
      {
        cgroupPath: group.cgroupPath,
        pgid: group.pgid,
        leaderPid: group.leaderPid,
        leaderStartMs: group.leaderStartMs,
        command: group.command,
        cgroupIno: group.cgroupIno,
        cgroupDev: group.cgroupDev
      },
      record.cliIdentity,
      priorRunDir
    );

    if (!authorized) {
      throw new Error(`Cgroup termination not authorized for group: ${group.cgroupPath}`);
    }

    const { killCgroup } = await import('./adapters/process-group.js');
    killCgroup(group.cgroupPath, group.cgroupIno, group.cgroupDev);
  }

  // Rewrite active.json to failed
  const updatedRecord: ActiveRecord = {
    ...record,
    state: 'failed',
    reason: 'reconciled-stale-run',
    cliRevision: record.cliRevision + 1
  };
  writeJsonAtomic(activeFile, updatedRecord);
}

export function registerGroup(runDir: string, handle: GroupIdentity): void {
  const activeFile = path.join(runDir, 'active.json');
  verifyFilePermissions(activeFile);
  const activeContent = fs.readFileSync(activeFile, 'utf-8');
  const record = ActiveSchema.parse(JSON.parse(activeContent));

  const updatedRecord: ActiveRecord = {
    ...record,
    state: 'running',
    groups: [...record.groups, handle],
    cliRevision: record.cliRevision + 1
  };
  writeJsonAtomic(activeFile, updatedRecord);
}

export async function confirmGroupClosed(runDir: string, handle: GroupIdentity): Promise<void> {
  const activeFile = path.join(runDir, 'active.json');
  verifyFilePermissions(activeFile);
  const activeContent = fs.readFileSync(activeFile, 'utf-8');
  const record = ActiveSchema.parse(JSON.parse(activeContent));

  const { readCgroupProcs, killCgroup } = await import('./adapters/process-group.js');

  const procs = readCgroupProcs(handle.cgroupPath, handle.cgroupIno, handle.cgroupDev);
  if (procs.length > 0) {
    const res = killCgroup(handle.cgroupPath, handle.cgroupIno, handle.cgroupDev);
    if (res.unverifiable || res.survivors.length > 0) {
      throw new Error(`Terminal ownership failure: cgroup ${handle.cgroupPath} contains unkillable survivors or is unreadable`);
    }
  }

  const updatedGroups = record.groups.filter(g => g.cgroupPath !== handle.cgroupPath);
  const updatedRecord: ActiveRecord = {
    ...record,
    groups: updatedGroups,
    cliRevision: record.cliRevision + 1
  };
  writeJsonAtomic(activeFile, updatedRecord);
}

export function completeRun(runDir: string, projectDir: string, runId: string): void {
  const activeFile = path.join(runDir, 'active.json');
  verifyFilePermissions(activeFile);
  const record = ActiveSchema.parse(JSON.parse(fs.readFileSync(activeFile, 'utf-8')));

  if (record.groups.length > 0) {
    throw new Error(`Cannot complete run: active groups remain in active.json`);
  }

  const updatedRecord: ActiveRecord = {
    ...record,
    state: 'completed',
    cliRevision: record.cliRevision + 1
  };
  writeJsonAtomic(activeFile, updatedRecord);
  releaseProjectLock(projectDir, runId);
}

export function failRun(runDir: string, projectDir: string, runId: string, reason: string): void {
  const activeFile = path.join(runDir, 'active.json');
  verifyFilePermissions(activeFile);
  const record = ActiveSchema.parse(JSON.parse(fs.readFileSync(activeFile, 'utf-8')));

  if (record.groups.length > 0) {
    throw new Error(`Cannot fail run: active groups remain in active.json`);
  }

  const updatedRecord: ActiveRecord = {
    ...record,
    state: 'failed',
    reason,
    cliRevision: record.cliRevision + 1
  };
  writeJsonAtomic(activeFile, updatedRecord);
  releaseProjectLock(projectDir, runId);
}

export function stopRun(runDir: string, projectDir: string, runId: string, reason: string): void {
  const activeFile = path.join(runDir, 'active.json');
  verifyFilePermissions(activeFile);
  const record = ActiveSchema.parse(JSON.parse(fs.readFileSync(activeFile, 'utf-8')));

  if (record.groups.length > 0) {
    throw new Error(`Cannot stop run: active groups remain in active.json`);
  }

  const updatedRecord: ActiveRecord = {
    ...record,
    state: 'stopped',
    reason,
    cliRevision: record.cliRevision + 1
  };
  writeJsonAtomic(activeFile, updatedRecord);
  releaseProjectLock(projectDir, runId);
}

// 5. In-flight lease watcher
export function watchLease(
  ctx: OwnershipContext,
  opts?: { intervalMs?: number; maxReadErrors?: number }
): { expired: Promise<void>; cancel(): void } {
  const controlFile = path.join(ctx.runDir, 'control.json');
  const intervalMs = opts?.intervalMs ?? parseInt(process.env['ORC_LEASE_WATCH_INTERVAL_MS'] ?? '500', 10);
  const maxReadErrors = opts?.maxReadErrors ?? parseInt(process.env['ORC_LEASE_WATCH_MAX_READ_ERRORS'] ?? '3', 10);

  let timer: NodeJS.Timeout | null = null;
  let consecutiveErrors = 0;
  let expiredResolved = false;
  let resolveExpired: () => void;
  const expired = new Promise<void>((resolve) => {
    resolveExpired = resolve;
  });

  const check = () => {
    try {
      if (!fs.existsSync(controlFile)) {
        throw new Error('control.json missing');
      }
      verifyFilePermissions(controlFile);
      const content = fs.readFileSync(controlFile, 'utf-8');
      const record = ControlSchema.parse(JSON.parse(content));

      // Check immutable field drift
      if (
        record.runId !== ctx.control.runId ||
        record.ownerTokenHash !== ctx.control.ownerTokenHash ||
        record.projectRoot !== ctx.control.projectRoot ||
        record.hostInstanceId !== ctx.control.hostInstanceId
      ) {
        throw new Error('Issuer identity drift detected');
      }

      consecutiveErrors = 0;

      if (isExpired(record.leaseExpiresMs, ctx)) {
        if (!expiredResolved) {
          expiredResolved = true;
          resolveExpired();
        }
      }
    } catch (err: any) {
      consecutiveErrors++;
      if (consecutiveErrors >= maxReadErrors) {
        if (!expiredResolved) {
          expiredResolved = true;
          resolveExpired();
        }
      }
    }
  };

  timer = setInterval(check, intervalMs);
  // The run itself owns liveness. A leaked watcher must not pin process exit.
  timer.unref();

  return {
    expired,
    cancel() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  };
}

// 6. Completion-side fence
export async function ownershipFence(ctx: OwnershipContext, loopSpec: any): Promise<boolean> {
  try {
    const control = readControl(ctx.runDir);
    
    // Validate immutable fields
    if (
      control.runId !== ctx.control.runId ||
      control.ownerTokenHash !== ctx.control.ownerTokenHash ||
      control.projectRoot !== ctx.control.projectRoot ||
      control.hostInstanceId !== ctx.control.hostInstanceId
    ) {
      throw new Error('Issuer identity drift detected');
    }

    if (isExpired(control.leaseExpiresMs, ctx)) {
      throw new Error('Lease expired');
    }

    return true;
  } catch (err) {
    const { handleOwnershipLoss } = await import('./interrupted-artifact.js');
    await handleOwnershipLoss(loopSpec, ctx);
    return false;
  }
}

// 7. Terminal finalization
export async function finalizeOwnedRun(
  ctx: OwnershipContext | null,
  runOutcome: { success: boolean; verdict: string; message?: string }
): Promise<void> {
  if (!ctx) return;

  const activeFile = path.join(ctx.runDir, 'active.json');
  if (!fs.existsSync(activeFile)) return;

  const record = readActive(ctx.runDir);

  // If already terminal in active.json, do nothing
  if (record.state === 'completed' || record.state === 'failed' || record.state === 'stopped') {
    return;
  }

  // 1. Assert every cgroup is empty
  const { readCgroupProcs, killCgroup } = await import('./adapters/process-group.js');
  for (const group of record.groups) {
    const procs = readCgroupProcs(group.cgroupPath, group.cgroupIno, group.cgroupDev);
    if (procs.length > 0) {
      const res = killCgroup(group.cgroupPath, group.cgroupIno, group.cgroupDev);
      if (res.unverifiable || res.survivors.length > 0) {
        // Retain lock, throw/fail closed
        record.state = 'failed';
        record.reason = 'finalize-stale-with-survivors';
        writeActive(ctx.runDir, record);
        
        try {
          const projectIndex = readProjectIndex(ctx.projectDir);
          projectIndex.state = 'failed';
          writeProjectIndex(ctx.projectDir, projectIndex);
        } catch {}
        
        throw new Error('Terminal ownership failure: cgroup contains unkillable survivors during finalization.');
      }
    }
  }

  // 2. Persist the cleared group set so the checked lifecycle boundary below
  // sees no active groups (completeRun/failRun/stopRun assert groups is empty).
  record.groups = [];
  writeActive(ctx.runDir, record);

  // 3. Route the terminal transition through the single checked lifecycle
  // boundary — completeRun()/failRun()/stopRun() re-read active.json, assert no
  // active group remains, set the terminal state, and release admission. This
  // keeps one ownership lifecycle transition path instead of mutating
  // ActiveRecord directly here.
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
