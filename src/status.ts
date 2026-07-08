import type { Step, StepKind, StepStatus } from './state.js';
import type { NextStepDecision } from './next-step.js';
import type { LoopSpec, Manifest } from './manifest.js';

/**
 * Format a millisecond duration as the compact `Xm Ys` / `Xs` form used in the
 * status panel and plain timeline. Returns `—` when the duration is unknown
 * (e.g. artifacts written before per-step timing existed, or interrupted steps).
 */
export function formatDurationMs(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—';
  const totalSecs = Math.max(0, Math.floor(ms / 1000));
  if (totalSecs >= 60) {
    return `${Math.floor(totalSecs / 60)}m ${totalSecs % 60}s`;
  }
  return `${totalSecs}s`;
}

/**
 * Format a session ID to keep it compact: showing only the last 5 characters
 * prefixed by `*`. Returns `—` if missing or `'none'`.
 */
export function formatSessionId(sessionId?: string | null): string {
  if (!sessionId || sessionId === 'none') {
    return '—';
  }
  return sessionId.length > 5 ? `*${sessionId.slice(-5)}` : sessionId;
}

export interface PanelContext {
  projectRoot: string;
  loopName: string;
  currentIteration: number;
  maxIterations: number;
  activeSkillRunner: { skillId: string; agent: string; model: string } | null;
  timeline: Step[];
  nextStepMessage: string;
  inFlight: {
    kind: StepKind;
    role: string;
    skillId: string;
    agent: string;
    model: string;
    version: number;
    iteration: number;
    startedAtMs: number;
    status: StepStatus;
    spawnLabel: string;
    toolCallCount: number;
    progressMessage: string | null;
  } | null;
  latestVersion: number;
  readOnly: boolean;
}

export function buildPanelContext(
  projectRoot: string,
  loopName: string,
  currentIteration: number,
  maxIterations: number,
  activeSkillRunner: { skillId: string; agent: string; model: string } | null,
  timeline: Step[],
  nextStepMessage: string,
  inFlight: PanelContext['inFlight'] = null,
  latestVersion: number = 0,
  readOnly: boolean = false
): PanelContext {
  return {
    projectRoot,
    loopName,
    currentIteration,
    maxIterations,
    activeSkillRunner,
    timeline,
    nextStepMessage,
    inFlight,
    latestVersion,
    readOnly
  };
}

export function latestAuditVersion(steps: Step[]): number {
  let max = 0;
  for (const s of steps) {
    if (s.kind === 'audit' && s.version > max) max = s.version;
  }
  return max;
}

export interface LoopLabels {
  audit?: {
    skillId: string;
  };
  followUp?: {
    skillId: string;
  };
  implement?: {
    skillId: string;
  };
}

export function resolveLoopLabels(loopSpec: LoopSpec, manifest: Manifest): LoopLabels {
  const labels: LoopLabels = {};
  if (loopSpec.audit && manifest.skills[loopSpec.audit]) {
    labels.audit = { skillId: loopSpec.audit };
  }
  if (loopSpec['follow-up'] && manifest.skills[loopSpec['follow-up']]) {
    labels.followUp = { skillId: loopSpec['follow-up'] };
  }
  if (loopSpec.implement && manifest.skills[loopSpec.implement]) {
    labels.implement = { skillId: loopSpec.implement };
  }
  return labels;
}

export type NextStepMessageDecision =
  | NextStepDecision
  | { state: 'implement'; nextVersion: number };

export function assembleNextStepMessage(
  decision: NextStepMessageDecision,
  latestVersion: number,
  loopSpec: LoopSpec,
  manifest: Manifest
): string {
  const labels = resolveLoopLabels(loopSpec, manifest);
  switch (decision.state) {
    case 'fresh':
      return `Ready to run ${labels.audit?.skillId ?? 'audit'} version ${decision.nextAuditVersion} (fresh)`;
    case 'rejected':
      return `Proposed next: ${labels.followUp?.skillId ?? 'follow-up'} then ${labels.audit?.skillId ?? 'audit'} version ${decision.nextAuditVersion}`;
    case 'approved':
      return `Completed: approved at version ${latestVersion}`;
    case 'unknown-latest-audit':
      return `Terminal error: latest audit is unparseable`;
    case 'implement':
      return `Ready to run ${labels.implement?.skillId ?? 'implement'} version ${decision.nextVersion}`;
  }
}

/**
 * Interrupted-aware read-only next-step message (§3). This is the ONLY composer
 * for interrupted display facts — no other module may synthesize user-facing
 * interrupted copy. An interrupted state MUST NOT render the audit-only fallback
 * messages from `assembleNextStepMessage()` (no "Ready to smash" / "Completed").
 */
export function assembleInterruptedMessage(loopName: string, version: number): string {
  if (loopName === 'implement') {
    return `Implementation v${version} was interrupted: partial ledgers are quarantined before state resolution, and a rerun resumes implementation rather than advancing to review.`;
  }
  if (loopName === 'review') {
    return `Review v${version} was interrupted: a rerun resumes review after the partial artifact is quarantined.`;
  }
  // 'plan' (and any other doc-audit loop)
  return `Planning v${version} was interrupted: a rerun resumes from the interrupted version after the partial artifact is quarantined.`;
}
