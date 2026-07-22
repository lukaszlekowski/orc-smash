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
  resolvedRunners?: ResolvedRunnerDisplay[];
  timeline: Step[];
  nextStepMessage: string;
  inFlight: {
    kind: StepKind;
    role: string;
    skillId: string;
    agent: string;
    model: string;
    effort?: string;
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
  providerCalls?: number;
}

export interface ResolvedRunnerDisplay {
  skillId: string;
  agent: string;
  model: string;
  source: 'selected' | 'inherited' | 'configured';
  inheritedFrom?: { kind: StepKind; version: number; sessionId: string };
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
  readOnly: boolean = false,
  resolvedRunners: ResolvedRunnerDisplay[] = [],
  providerCalls?: number
): PanelContext {
  return {
    projectRoot,
    loopName,
    currentIteration,
    maxIterations,
    activeSkillRunner,
    resolvedRunners,
    timeline,
    nextStepMessage,
    inFlight,
    latestVersion,
    readOnly,
    providerCalls
  };
}

export function latestVersion(steps: Step[]): number {
  return steps.reduce((max, step) => Math.max(max, step.version), 0);
}

export interface LoopLabels {
  evaluate?: {
    skillId: string;
  };
  repair?: {
    skillId: string;
  };
}

export function resolveLoopLabels(loopSpec: LoopSpec, manifest: Manifest): LoopLabels {
  const labels: LoopLabels = {};
  const evalSkill = loopSpec.evaluate.skill;
  if (evalSkill && manifest.skills[evalSkill]) {
    labels.evaluate = { skillId: evalSkill };
  }
  const repairSkill = loopSpec.repair.skill;
  if (repairSkill && manifest.skills[repairSkill]) {
    labels.repair = { skillId: repairSkill };
  }
  return labels;
}

export function assembleNextStepMessage(
  decision: NextStepDecision,
  latestVersion: number,
  loopSpec: LoopSpec,
  manifest: Manifest
): string {
  const labels = resolveLoopLabels(loopSpec, manifest);
  const nextEvaluateVersion = decision.nextEvaluateVersion ?? latestVersion + 1;
  switch (decision.state) {
    case 'fresh':
      return `Ready to run ${labels.evaluate?.skillId ?? 'evaluate'} version ${nextEvaluateVersion} (fresh)`;
    case 'rejected':
      return `Proposed next: ${labels.repair?.skillId ?? 'repair'} then ${labels.evaluate?.skillId ?? 'evaluate'} version ${nextEvaluateVersion}`;
    case 'accepted':
      return `Completed: accepted at version ${latestVersion}`;
    case 'unknown-latest-evaluation':
      return `Terminal error: latest evaluation is unparseable`;
  }
}

/**
 * Interrupted-aware read-only next-step message (§3). This is the ONLY composer
 * for interrupted display facts — no other module may synthesize user-facing
 * interrupted copy. An interrupted state MUST NOT render the audit-only fallback
 * messages from `assembleNextStepMessage()` (no "Ready to smash" / "Completed").
 */
export function assembleInterruptedMessage(loopName: string, version: number): string {
  return `Binding ${loopName} v${version} was interrupted: the partial artifact is quarantined before state resolution.`;
}
