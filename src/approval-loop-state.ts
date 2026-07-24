import type { ChainMode } from './pipeline-state.js';

export type ApprovalPhase = 'evaluate' | 'repair' | 'task';
export type ApprovalResult = 'accepted' | 'retry' | 'completed' | 'blocked' | 'valid' | 'unknown';

/**
 * The evidence required to reduce one approval chain.  This deliberately
 * retains identity and contract context so callers cannot collapse a repair
 * or task artifact into a generic boolean before applying the domain rule.
 */
export interface ApprovalChainStep {
  artifactIdentity: string;
  bindingKind: 'loop' | 'task';
  bindingId: string;
  phase: ApprovalPhase | string;
  chainId: string;
  chainMode: ChainMode | null;
  pipelineId: string | null;
  pipelineRunId: string | null;
  stageId: string | null;
  version: number;
  parentArtifactIdentity: string | null;
  normalizedResult: ApprovalResult;
  contractValid: boolean;
  unclassified: boolean;
  artifactPath: string;
  resultFingerprint: string;
}

export type ApprovalReasonCode =
  | 'accepted'
  | 'retry-requires-repair'
  | 'repair-requires-evaluation'
  | 'blocked-repair'
  | 'unknown-evaluation'
  | 'unknown-repair'
  | 'repair-after-accepted'
  | 'evaluation-without-repair'
  | 'duplicate-position'
  | 'competing-position'
  | 'legacy-phase'
  | 'non-evaluate-root'
  | 'unclassified-evidence';

export type ApprovalChainState =
  | { kind: 'not-started' }
  | { kind: 'repair-required'; evaluate: ApprovalChainStep; reason: 'retry-requires-repair' }
  | { kind: 'evaluation-required'; repair: ApprovalChainStep; reason: 'repair-requires-evaluation' }
  | { kind: 'accepted'; evaluate: ApprovalChainStep; reason: 'accepted' }
  | { kind: 'blocked'; artifact: ApprovalChainStep; reason: 'blocked-repair' }
  | { kind: 'unknown'; artifact?: ApprovalChainStep; reason: ApprovalReasonCode }
  | { kind: 'conflict'; artifacts: ApprovalChainStep[]; reason: ApprovalReasonCode };

const PHASES = new Set<ApprovalPhase>(['evaluate', 'repair', 'task']);

function positionKey(step: ApprovalChainStep): string {
  return `${step.version}:${step.phase}`;
}

function byCausalPosition(a: ApprovalChainStep, b: ApprovalChainStep): number {
  return a.version - b.version
    || phaseOrder(a.phase) - phaseOrder(b.phase)
    || a.artifactIdentity.localeCompare(b.artifactIdentity);
}

function phaseOrder(phase: string): number {
  if (phase === 'evaluate') return 0;
  if (phase === 'repair') return 1;
  return 2;
}

function unknownFor(steps: ApprovalChainStep[], reason: ApprovalReasonCode): ApprovalChainState {
  const artifact = [...steps].sort(byCausalPosition).at(-1);
  return artifact ? { kind: 'unknown', artifact, reason } : { kind: 'unknown', reason };
}

/**
 * Reduce one chain using declared phase, parent identity, version, and the
 * normalized output contract.  The reducer is intentionally fail-closed:
 * legacy phase names, malformed evidence, duplicate positions, and illegal
 * transitions never become approval.
 */
export function reduceApprovalChain(input: readonly ApprovalChainStep[]): ApprovalChainState {
  if (input.length === 0) return { kind: 'not-started' };

  const steps = [...input].sort(byCausalPosition);
  const invalidPhase = steps.find(step => !PHASES.has(step.phase as ApprovalPhase));
  if (invalidPhase) return { kind: 'unknown', artifact: invalidPhase, reason: 'legacy-phase' };

  const duplicate = steps.find((step, index) => index > 0 && positionKey(step) === positionKey(steps[index - 1]!));
  if (duplicate) {
    return {
      kind: 'conflict',
      artifacts: steps.filter(step => positionKey(step) === positionKey(duplicate)),
      reason: 'duplicate-position',
    };
  }

  const invalidEvidence = steps.find(step => step.unclassified || !step.contractValid || step.normalizedResult === 'unknown');
  if (invalidEvidence) return unknownFor([invalidEvidence], invalidEvidence.phase === 'repair' ? 'unknown-repair' : 'unknown-evaluation');

  const loopSteps = steps.filter(step => step.bindingKind === 'loop');
  if (loopSteps.some(step => step.phase === 'task')) return unknownFor(loopSteps, 'legacy-phase');
  if (steps.some(step => step.bindingKind !== 'loop')) return unknownFor(steps, 'legacy-phase');

  const root = steps[0]!;
  if (root.phase !== 'evaluate') return unknownFor(steps, 'non-evaluate-root');
  if (root.parentArtifactIdentity !== null && root.chainMode !== 'stage-continuation') {
    return unknownFor(steps, 'unclassified-evidence');
  }

  let state: ApprovalChainState;
  if (root.normalizedResult === 'accepted') {
    state = { kind: 'accepted', evaluate: root, reason: 'accepted' };
  } else if (root.normalizedResult === 'retry') {
    state = { kind: 'repair-required', evaluate: root, reason: 'retry-requires-repair' };
  } else {
    return unknownFor([root], 'unknown-evaluation');
  }

  for (let index = 1; index < steps.length; index += 1) {
    const step = steps[index]!;
    const previous = steps[index - 1]!;
    if (step.parentArtifactIdentity !== previous.artifactIdentity) {
      return { kind: 'conflict', artifacts: [previous, step], reason: 'competing-position' };
    }

    if (state.kind === 'accepted') {
      return { kind: 'conflict', artifacts: [state.evaluate, step], reason: 'repair-after-accepted' };
    }

    if (state.kind === 'repair-required') {
      if (step.phase !== 'repair' || step.version !== state.evaluate.version) {
        return { kind: 'conflict', artifacts: [state.evaluate, step], reason: 'evaluation-without-repair' };
      }
      if (step.normalizedResult === 'blocked') {
        state = { kind: 'blocked', artifact: step, reason: 'blocked-repair' };
      } else if (step.normalizedResult === 'completed' || step.normalizedResult === 'valid') {
        state = { kind: 'evaluation-required', repair: step, reason: 'repair-requires-evaluation' };
      } else {
        return unknownFor([step], 'unknown-repair');
      }
      continue;
    }

    if (state.kind === 'evaluation-required') {
      if (step.phase !== 'evaluate' || step.version <= state.repair.version) {
        return { kind: 'conflict', artifacts: [state.repair, step], reason: 'evaluation-without-repair' };
      }
      if (step.normalizedResult === 'accepted') {
        state = { kind: 'accepted', evaluate: step, reason: 'accepted' };
      } else if (step.normalizedResult === 'retry') {
        state = { kind: 'repair-required', evaluate: step, reason: 'retry-requires-repair' };
      } else {
        return unknownFor([step], 'unknown-evaluation');
      }
      continue;
    }

    const terminalState = state as ApprovalChainState;
    if (terminalState.kind === 'blocked' || terminalState.kind === 'unknown' || terminalState.kind === 'conflict') {
      return { kind: 'conflict', artifacts: [previous, step], reason: 'competing-position' };
    }
  }

  return state;
}

export function approvalNextPhase(state: ApprovalChainState):
  | { phase: 'evaluate'; version: number; parentArtifactIdentity: string }
  | { phase: 'repair'; version: number; parentArtifactIdentity: string }
  | null {
  if (state.kind === 'repair-required') {
    return { phase: 'repair', version: state.evaluate.version, parentArtifactIdentity: state.evaluate.artifactIdentity };
  }
  if (state.kind === 'evaluation-required') {
    return { phase: 'evaluate', version: state.repair.version + 1, parentArtifactIdentity: state.repair.artifactIdentity };
  }
  return null;
}

export function resumableApprovalChain(steps: readonly ApprovalChainStep[]): {
  state: ApprovalChainState;
  chainId: string;
  chainMode: ChainMode;
  pipelineId: string | null;
  pipelineRunId: string | null;
  stageId: string | null;
  parentArtifactIdentity: string | null;
} | null {
  if (steps.length === 0) return null;
  const state = reduceApprovalChain(steps);
  if (state.kind !== 'repair-required' && state.kind !== 'evaluation-required') return null;
  const latest = [...steps].sort(byCausalPosition).at(-1)!;
  return {
    state,
    chainId: latest.chainId,
    chainMode: latest.chainMode ?? 'ad-hoc',
    pipelineId: latest.pipelineId,
    pipelineRunId: latest.pipelineRunId,
    stageId: latest.stageId,
    parentArtifactIdentity: latest.artifactIdentity,
  };
}
