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
import type { LoopSpec } from './manifest.js';
import { renderPattern, patternToRegex } from './patterns.js';
import { terminateActiveChildren } from './adapters/utils.js';

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

// --- Module-level interrupt context (signal-safe mutable state) ---------------

let activeProjectRoot: string | null = null;
let activeStepCtx: StepCtx | null = null;

/** Register the active project root immediately after config load succeeds. */
export function setActiveProjectRoot(root: string | null): void {
  activeProjectRoot = root;
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
  loops: Record<string, LoopSpec>
): string | null {
  const loopSpec = loops[marker.loop];
  if (!loopSpec) return null;
  const pattern =
    marker.kind === 'audit'
      ? loopSpec.auditPattern
      : marker.kind === 'follow-up'
        ? loopSpec.followUpPattern
        : loopSpec.implementPattern;
  if (!pattern) return null;
  const rel = renderPattern(pattern, { n: marker.version, agent: marker.agent });
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
  loopSpec: LoopSpec,
  notBeforeMs: number
): string[] {
  const patterns = [loopSpec.auditPattern, loopSpec.followUpPattern, loopSpec.implementPattern].filter(
    (p): p is string => typeof p === 'string' && p.length > 0
  );
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
  loops: Record<string, LoopSpec>
): { hadMarker: boolean; marker: InterruptedMarker | null; quarantined: string[] } {
  const marker = readInterruptedMarker(projectRoot);
  if (!marker) {
    return { hadMarker: false, marker: null, quarantined: [] };
  }
  const quarantined: string[] = [];

  const inFlight = resolveInterruptedArtifactPath(projectRoot, marker, loops);
  if (inFlight) {
    const result = quarantineArtifact(projectRoot, inFlight, { reason: 'interrupted' });
    if (result.quarantined && result.archivedPath) {
      quarantined.push(result.archivedPath);
    }
  }

  const loopSpec = loops[marker.loop];
  if (loopSpec) {
    const late = quarantineLateArtifactsForLoop(projectRoot, loopSpec, marker.interruptedAtMs);
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
