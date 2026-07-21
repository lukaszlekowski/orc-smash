/**
 * Interrupted-run context, durable marker, and artifact quarantine (§3).
 *
 * Four ownership boundaries keep interrupt handling single-sourced:
 *   - `src/adapters/utils.ts` owns active child tracking + termination.
 *   - THIS module owns the interrupt-context API end to end: active project-root
 *     registration/clear, active step-context registration/clear, marker
 *     read/write/clear, in-flight quarantine, and late-artifact quarantine.
 *   - `src/state.ts` owns one display-only status helper that merges marker
 *     facts into a status timeline (decision-path scans stay unchanged).
 *   - `src/status.ts` owns the read-only interrupted message text.
 *
 * The marker is durable resume state written under the active `projectRoot`
 * (NOT `process.cwd()`), so a rerun from any launch directory can detect the
 * interruption, quarantine partial/late artifacts before state resolution, and
 * resume the correct stage. The marker's `loop` field is authoritative for
 * status loop selection (see `src/commands/status.ts` marker-first precedence).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, readdirSync, statSync, rmSync } from 'node:fs';
import { resolve, join, relative, basename, dirname } from 'node:path';
import type { StepKind } from './provenance.js';
import { renderPattern, patternToRegex } from './patterns.js';
import { terminateActiveChildren } from './adapters/utils.js';
import type { RunEventInput } from './run-event.js';
import { terminateOwnedRuntimes } from './owned-runtime-registry.js';
import type { LoopBinding, TaskBinding } from './manifest.js';

/** Directory (under the project root) holding the durable marker. */
export const INTERRUPTED_MARKER_DIR = '.orc-smash';
/** Marker filename inside {@link INTERRUPTED_MARKER_DIR}. */
export const INTERRUPTED_MARKER_FILE = 'interrupted.json';

/** Durable resume marker for an interrupted provider step. */
export interface InterruptedMarker {
  /** Authoritative loop name for status loop selection (marker-first precedence). */
  loop: string;
  /** Step kind that was in flight when interrupted. */
  kind: StepKind;
  /** Version (`{n}`) of the in-flight artifact. */
  version: number;
  /** Agent that was running. */
  agent: string;
  /** Model that was running. */
  model: string;
  /** Skill id that was running. */
  skillId: string;
  /** Wall-clock ms when the interruption was recorded. */
  interruptedAtMs: number;
}

/** Active step context: non-null only while a provider subprocess is live. */
export interface StepCtx {
  loop: string;
  kind: StepKind;
  version: number;
  agent: string;
  model: string;
  skillId: string;
}

type BindingDefinition = LoopBinding | TaskBinding | Record<string, unknown>;
type BindingPhase = 'evaluate' | 'repair' | 'task';

/** Normalize only the marker vocabulary; execution uses canonical v1 phases. */
function markerPhase(kind: StepKind): BindingPhase {
  const phaseMap: Record<string, BindingPhase> = {
    evaluate: 'evaluate',
    repair: 'repair',
    task: 'task',
    audit: 'evaluate',
    'follow-up': 'repair',
    implement: 'task',
  };
  return phaseMap[kind] ?? 'evaluate';
}

function isLoopBinding(binding: BindingDefinition): binding is LoopBinding {
  return binding !== null && typeof binding === 'object' && 'type' in binding;
}

function bindingPatterns(binding: BindingDefinition, phase?: BindingPhase): string[] {
  if (isLoopBinding(binding)) {
    const legacy = binding as LoopBinding & {
      auditPattern?: unknown;
      followUpPattern?: unknown;
      implementPattern?: unknown;
    };
    if (!phase) {
      const patterns = [
        typeof legacy.auditPattern === 'string' ? legacy.auditPattern : binding.evaluate.output.pattern,
        typeof legacy.followUpPattern === 'string' ? legacy.followUpPattern : binding.repair.output.pattern,
      ];
      if (typeof legacy.implementPattern === 'string') patterns.push(legacy.implementPattern);
      return patterns;
    }
    const selected = phase === 'repair'
      ? binding.repair.output.pattern
      : phase === 'task'
        ? (typeof legacy.implementPattern === 'string' ? legacy.implementPattern : binding.evaluate.output.pattern)
        : binding.evaluate.output.pattern;
    const legacySelected = phase === 'repair'
      ? legacy.followUpPattern
      : phase === 'task'
        ? legacy.implementPattern
        : legacy.auditPattern;
    return [typeof legacySelected === 'string' ? legacySelected : selected];
  }

  const legacy = binding as TaskBinding & {
    auditPattern?: unknown;
    followUpPattern?: unknown;
    implementPattern?: unknown;
  };
  if (typeof legacy.implementPattern === 'string') return [legacy.implementPattern];
  if (typeof legacy.auditPattern === 'string' || typeof legacy.followUpPattern === 'string') {
    return [
      ...(typeof legacy.auditPattern === 'string' ? [legacy.auditPattern] : []),
      ...(typeof legacy.followUpPattern === 'string' ? [legacy.followUpPattern] : []),
    ];
  }
  const task = binding as TaskBinding;
  return [typeof task.output?.pattern === 'string' ? task.output.pattern : ''];
}

// --- Module-level interrupt context (signal-safe mutable state) ---------------

let activeProjectRoot: string | null = null;
let activeStepCtx: StepCtx | null = null;
let activeRunEventSink: ((event: RunEventInput) => void) | null = null;

/** Register the active project root immediately after config load succeeds. */
export function setActiveProjectRoot(root: string | null): void {
  activeProjectRoot = root;
}

export function setActiveRunEventSink(sink: ((event: RunEventInput) => void) | null): void {
  activeRunEventSink = sink;
}

/** @returns the active project root, or `null` before setup / after completion. */
export function getActiveProjectRoot(): string | null {
  return activeProjectRoot;
}

/**
 * Register the active step context. Non-null ONLY while a provider subprocess is
 * actively running; `runLoop` clears it in `runAdapter`'s `finally` path so a
 * stale context never archives a completed artifact.
 */
export function setStepCtx(ctx: StepCtx | null): void {
  activeStepCtx = ctx;
}

/** @returns the active step context, or `null` when no subprocess is in flight. */
export function getStepCtx(): StepCtx | null {
  return activeStepCtx;
}

/** Reset all interrupt-context state. Used between tests and on clean completion. */
export function clearInterruptState(): void {
  activeProjectRoot = null;
  activeStepCtx = null;
  activeRunEventSink = null;
}

// --- Marker path --------------------------------------------------------------

export function markerPath(projectRoot: string): string {
  return join(projectRoot, INTERRUPTED_MARKER_DIR, INTERRUPTED_MARKER_FILE);
}

// --- Marker I/O ----------------------------------------------------------------

/**
 * Read the durable marker for a project root. Returns `null` when absent or
 * corrupt (a corrupt marker must never block resume — it is treated as absent).
 */
export function readInterruptedMarker(projectRoot: string): InterruptedMarker | null {
  const path = markerPath(projectRoot);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf-8');
    const obj = JSON.parse(raw) as Partial<InterruptedMarker>;
    if (
      typeof obj.loop === 'string' &&
      typeof obj.kind === 'string' &&
      typeof obj.version === 'number' &&
      typeof obj.agent === 'string' &&
      typeof obj.model === 'string' &&
      typeof obj.skillId === 'string' &&
      typeof obj.interruptedAtMs === 'number'
    ) {
      return {
        loop: obj.loop,
        kind: obj.kind as StepKind,
        version: obj.version,
        agent: obj.agent,
        model: obj.model,
        skillId: obj.skillId,
        interruptedAtMs: obj.interruptedAtMs
      };
    }
    return null;
  } catch {
    // Corrupt marker: treat as absent so resume is never blocked by bad state.
    return null;
  }
}

/** Write the durable marker under the active project root. */
export function writeInterruptedMarker(projectRoot: string, marker: InterruptedMarker): void {
  const path = markerPath(projectRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(marker, null, 2), 'utf-8');
}

/** Remove the durable marker (called after a successful resume quarantine). */
export function clearInterruptedMarker(projectRoot: string): void {
  const path = markerPath(projectRoot);
  if (existsSync(path)) {
    rmSync(path, { force: true });
  }
}

// --- Path resolution from marker + manifest -----------------------------------

/**
 * Resolve the absolute artifact path the in-flight step WOULD have written, from
 * the marker + the manifest's loop patterns. Returns `null` when the loop or its
 * pattern for the marker's kind is missing (defensive: never throw on resume).
 */
export function resolveInterruptedArtifactPath(
  projectRoot: string,
  marker: InterruptedMarker,
  bindings: Record<string, BindingDefinition>
): string | null {
  const binding = bindings[marker.loop];
  if (!binding) return null;
  const pattern = bindingPatterns(binding, markerPhase(marker.kind))[0];
  if (!pattern) return null;
  const rel = renderPattern(pattern, { version: marker.version, provider: marker.agent });
  return resolve(projectRoot, rel);
}

// --- Quarantine (shared by §2 auth cleanup and §3 interrupted handling) -------

/**
 * Move a single resolved artifact into `<projectRoot>/docs/dev/archived/` so the
 * state scanner ignores it. No-op (returns `{ quarantined: false }`) if the file
 * does not exist. The archived name is unique per call so repeated quarantines of
 * the same version never clobber each other.
 */
export function quarantineArtifact(
  projectRoot: string,
  absArtifactPath: string,
  opts: { reason?: string; notBeforeMs?: number } = {}
): { quarantined: boolean; archivedPath: string | null } {
  if (!existsSync(absArtifactPath)) {
    return { quarantined: false, archivedPath: null };
  }
  // Late-artifact guard: only quarantine files newer than the marker timestamp.
  if (opts.notBeforeMs !== undefined) {
    const stat = statSync(absArtifactPath);
    if (stat.mtimeMs <= opts.notBeforeMs) {
      return { quarantined: false, archivedPath: null };
    }
  }
  const archivedDir = join(projectRoot, 'docs/dev/archived');
  mkdirSync(archivedDir, { recursive: true });
  const original = basename(absArtifactPath);
  const suffix = opts.reason ? `.${opts.reason}` : '';
  // Unique suffix with the interruption/now timestamp avoids clobbering prior
  // quarantines of the same logical artifact.
  const stamp = opts.notBeforeMs ?? Date.now();
  const archivedPath = join(archivedDir, `${original}${suffix}.${stamp}`);
  renameSync(absArtifactPath, archivedPath);
  return { quarantined: true, archivedPath };
}

/**
 * Quarantine "late" artifacts for a loop: any file under `<projectRoot>/docs/dev`
 * (excluding `archived/`) matching one of the loop's audit/follow-up/implement
 * patterns whose mtime is newer than `notBeforeMs`. Catches stragglers written by
 * the child between marker-write and termination. Returns the archived paths.
 */
export function quarantineLateArtifactsForLoop(
  projectRoot: string,
  binding: BindingDefinition,
  notBeforeMs: number
): string[] {
  const patterns = bindingPatterns(binding).filter((pattern) => pattern.length > 0);
  if (patterns.length === 0) return [];
  const regexes = patterns.map(patternToRegex);
  const docsDev = join(projectRoot, 'docs/dev');
  const archived: string[] = [];
  for (const file of listArtifactFiles(docsDev)) {
    const rel = relative(projectRoot, file);
    if (!regexes.some((re) => re.test(rel))) continue;
    const stat = statSync(file);
    if (stat.mtimeMs <= notBeforeMs) continue;
    const result = quarantineArtifact(projectRoot, file, { reason: 'late', notBeforeMs });
    if (result.quarantined && result.archivedPath) {
      archived.push(result.archivedPath);
    }
  }
  return archived;
}

/** Recursively list files under `dir`, skipping the `archived` subtree. */
function listArtifactFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      if (entry === 'archived') continue;
      out.push(...listArtifactFiles(abs));
    } else {
      out.push(abs);
    }
  }
  return out;
}

/**
 * Composite resume quarantine: read the marker; if present, quarantine the
 * in-flight resolved artifact, sweep late artifacts for the marker's loop, then
 * clear the marker. Safe no-op when no marker exists. This is the single
 * entrypoint `resolveSmashRunSetup` (setup time) and `runLoop` (loop start) call
 * before any decision-path scan can hit `unknown` or advance state.
 */
export function quarantineInterruptedResume(
  projectRoot: string,
  bindings: Record<string, BindingDefinition>
): { hadMarker: boolean; marker: InterruptedMarker | null; quarantined: string[] } {
  const marker = readInterruptedMarker(projectRoot);
  if (!marker) {
    return { hadMarker: false, marker: null, quarantined: [] };
  }
  const quarantined: string[] = [];

  const inFlight = resolveInterruptedArtifactPath(projectRoot, marker, bindings);
  if (inFlight) {
    const result = quarantineArtifact(projectRoot, inFlight, { reason: 'interrupted' });
    if (result.quarantined && result.archivedPath) {
      quarantined.push(result.archivedPath);
    }
  }

  const binding = bindings[marker.loop];
  if (binding) {
    const late = quarantineLateArtifactsForLoop(projectRoot, binding, marker.interruptedAtMs);
    quarantined.push(...late);
  }

  clearInterruptedMarker(projectRoot);
  return { hadMarker: true, marker, quarantined };
}

// --- Signal-safe entrypoint ---------------------------------------------------

/**
 * Handle an interrupt signal (SIGINT/SIGTERM). When a step is in flight under a
 * registered project root, write the durable marker for that step; always
 * terminate active provider children (SIGTERM → SIGKILL after grace); then exit
 * with the conventional signal code. No-op safe for the marker write when no
 * step is in flight (the child termination still runs as a best-effort cleanup).
 */
export async function handleInterruptSignal(signal: NodeJS.Signals): Promise<void> {
  activeRunEventSink?.({ type: 'run.interrupted', atMs: Date.now(), reason: signal });
  const ctx = activeStepCtx;
  const root = activeProjectRoot;
  if (ctx && root) {
    writeInterruptedMarker(root, {
      loop: ctx.loop,
      kind: ctx.kind,
      version: ctx.version,
      agent: ctx.agent,
      model: ctx.model,
      skillId: ctx.skillId,
      interruptedAtMs: Date.now()
    });
  }
  await terminateActiveChildren();
  // Conventional exit code: 128 + signal number.
  const signo = signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 0;
  process.exit(128 + signo);
}

const ownershipLosses = new Map<string, Promise<OwnershipLossResult>>();

/**
 * Structured ownership-loss cleanup result. The lease-expiry race must always
 * resolve to an ownership-specific outcome; this type carries whether cleanup
 * completed cleanly (`ownership-stopped`, admission released) or hit a terminal
 * ownership-failure condition (`ownership-blocked`, admission retained for an
 * operator). It is returned — never thrown — so `executeLoopStep()`'s
 * `Promise.race` can never escape as a generic transport failure.
 */
export type OwnershipLossResult =
  | { kind: 'ownership-stopped' }
  | { kind: 'ownership-blocked'; reason: string };

/**
 * Record a terminal ownership-failure state in `active.json` + `project.json`
 * and RETAIN the project admission lock (it is never released here). Best-effort:
 * if the records are unreadable the fail-closed guarantee still holds because no
 * admission is released. Used by both the survivor-gate branch and the catch-all
 * for unexpected cleanup errors.
 */
async function recordTerminalOwnershipFailure(ctx: any, reason: string): Promise<void> {
  try {
    const { readActive, writeActive, readProjectIndex, writeProjectIndex } = await import('./run-ownership.js');
    const record = readActive(ctx.runDir);
    record.state = 'failed';
    record.reason = reason;
    record.recoveryAtMs = Date.now();
    record.cliRevision += 1;
    writeActive(ctx.runDir, record);
    try {
      const projectIndex = readProjectIndex(ctx.projectDir);
      projectIndex.state = 'failed';
      writeProjectIndex(ctx.projectDir, projectIndex);
    } catch {
      // project.json optional/missing — admission lock retention is the guarantee.
    }
  } catch {
    // active.json unreadable/missing — admission lock is retained regardless.
  }
}

async function performOwnershipLoss(binding: BindingDefinition, ctx: any): Promise<OwnershipLossResult> {
  try {
    const stepCtx = activeStepCtx;
    const root = activeProjectRoot;
    const interruptedAtMs = Date.now();

    // 1. Write the interrupted marker
    if (stepCtx && root) {
      writeInterruptedMarker(root, {
        loop: stepCtx.loop,
        kind: stepCtx.kind,
        version: stepCtx.version,
        agent: stepCtx.agent,
        model: stepCtx.model,
        skillId: stepCtx.skillId,
        interruptedAtMs
      });
    }

    // 2. Terminate only fresh capabilities created by this CLI. In particular,
    // do not reconstruct a kill target from active.json while this process is
    // alive: that would route the live lease-loss path through durable authority
    // and is refused on macOS.
    const { readActive, writeActive, stopRun } = await import('./run-ownership.js');

    const activeRecord = readActive(ctx.runDir);

    activeRecord.state = 'stopping';
    activeRecord.cliRevision += 1;
    writeActive(ctx.runDir, activeRecord);

    const terminationResults = await terminateOwnedRuntimes(
      2000,
      (capability) => capability.runId === ctx.runId && capability.runDir === ctx.runDir
    );
    const registeredGroups = new Set(activeRecord.groups.map((group: any) => `${group.pgid}:${group.leaderPid}`));
    const terminatedGroups = new Set(
      terminationResults.map((entry) => `${entry.capability.handle.pgid}:${entry.capability.handle.leaderPid}`)
    );
    const unverified = terminationResults.filter(
      (entry) => entry.result.outcome === 'rejected' || !entry.retired
    );
    const missingFreshCapability = [...registeredGroups].filter((key) => !terminatedGroups.has(key));

    if (root && stepCtx) {
      const inFlight = resolveInterruptedArtifactPath(root, {
        loop: stepCtx.loop,
        kind: stepCtx.kind,
        version: stepCtx.version,
        agent: stepCtx.agent,
        model: stepCtx.model,
        skillId: stepCtx.skillId,
        interruptedAtMs: Date.now()
      }, { [stepCtx.loop]: binding });

      if (inFlight) {
        quarantineArtifact(root, inFlight, { reason: 'interrupted' });
      }
      quarantineLateArtifactsForLoop(root, binding, interruptedAtMs);
    }

    if (unverified.length > 0 || missingFreshCapability.length > 0) {
      // At least one registered group could not be safely terminated (leader
      // gone or identity drift). Retain admission and surface a terminal
      // ownership-failure for operator recovery rather than risk a recycled-PGID
      // kill.
      const reasons = [
        ...unverified.map((entry) => entry.result.outcome === 'rejected' || entry.result.outcome === 'already-gone'
          ? entry.result.reason
          : 'runtime capability was not retired'),
        ...(missingFreshCapability.length > 0 ? [`no fresh runtime capability for ${missingFreshCapability.join(', ')}`] : [])
      ];
      await recordTerminalOwnershipFailure(
        ctx,
        `ownership-loss-unkillable-groups: ${reasons.join('; ')}`
      );
      return {
        kind: 'ownership-blocked',
        reason: reasons.join('; ')
      };
    }

    const recordAfterKill = readActive(ctx.runDir);
    if (recordAfterKill.groups.length > 0) {
      await recordTerminalOwnershipFailure(ctx, 'ownership-loss-cleanup left active group records');
      return { kind: 'ownership-blocked', reason: 'active group records remain after fresh termination' };
    }
    stopRun(ctx.runDir, ctx.projectDir, ctx.runId, 'ownership-lost');
    return { kind: 'ownership-stopped' };
  } catch (err: any) {
    const message = (err as Error)?.message ?? 'unknown ownership-loss cleanup error';
    await recordTerminalOwnershipFailure(ctx, `ownership-loss-cleanup-error: ${message}`);
    return { kind: 'ownership-blocked', reason: message };
  }
}

export function handleOwnershipLoss(binding: BindingDefinition, ctx: any): Promise<OwnershipLossResult> {
  const key = String(ctx?.runDir ?? ctx?.runId ?? 'unknown');
  const existing = ownershipLosses.get(key);
  if (existing) return existing;
  const operation = performOwnershipLoss(binding, ctx).finally(() => {
    if (ownershipLosses.get(key) === operation) ownershipLosses.delete(key);
  });
  ownershipLosses.set(key, operation);
  return operation;
}
