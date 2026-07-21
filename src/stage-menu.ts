import type { Step, StepKind } from './state.js';

export type SessionPolicy = 'new' | 'resumed';

export interface StageAction {
  id: string;
  group: 'start-new' | 'continue' | 'run-one-step';
  stage: 'evaluate' | 'repair' | 'task' | 'stop';
  version: number;
  sessionPolicy: SessionPolicy | { repair: SessionPolicy; evaluate: SessionPolicy };
  sessionId?: string;
  provider?: string;
  model?: string;
  oneOff?: boolean;
  label: string;
  recommended: boolean;
  disabledReason?: string;
}

export type MenuPhase = 'fresh' | 'retry-pending' | 'repair-complete' | 'accepted' | 'task-complete';

export interface LoopMenuState {
  phase: MenuPhase;
  latestVersion: number;
  pendingRepairVersion: number | null;
  decisionPoint: 'startup' | 'in-loop';
  loopName: string;
}

/** Build generic actions for a configured two-step approval binding. */
export function buildStageActions(input: LoopMenuState): { actions: StageAction[]; recommendedId: string } {
  const version = input.latestVersion + 1;
  const repairVersion = input.pendingRepairVersion ?? input.latestVersion;
  const actions: StageAction[] = [
    {
      id: 'start-new',
      group: 'start-new',
      stage: 'evaluate',
      version,
      sessionPolicy: 'new',
      label: `Start ${input.loopName} evaluation v${version} with a fresh session`,
      recommended: input.phase === 'fresh' || input.phase === 'accepted',
    },
    {
      id: 'run-evaluate',
      group: 'run-one-step',
      stage: 'evaluate',
      version,
      sessionPolicy: 'new',
      oneOff: true,
      label: `Run ${input.loopName} evaluation v${version}`,
      recommended: false,
    },
  ];

  if (input.phase === 'retry-pending') {
    actions.unshift({
      id: 'continue-repair',
      group: 'continue',
      stage: 'repair',
      version: repairVersion,
      sessionPolicy: { repair: 'new', evaluate: 'new' },
      label: `Repair ${input.loopName} v${repairVersion}, then evaluate v${repairVersion + 1}`,
      recommended: true,
    });
  }

  return {
    actions,
    recommendedId: actions.find((action) => action.recommended)?.id ?? actions[0]!.id,
  };
}

export function findResumableSession(
  steps: Step[],
  kinds: StepKind[],
  agent: string,
  model: string,
  opts?: { stopAtAccepted?: boolean; effort?: string },
): { sessionId: string; version: number; kind: StepKind; provider: string; model: string } | null {
  const stopAtAccepted = opts?.stopAtAccepted !== false;
  if (stopAtAccepted && steps.some((step) => step.decision === 'accepted')) return null;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]!;
    if (
      kinds.includes(step.kind) &&
      step.agent === agent &&
      step.model === model &&
      (opts?.effort === undefined || step.effort === opts.effort) &&
      step.sessionId &&
      step.sessionId !== 'none'
    ) {
      return {
        sessionId: step.sessionId,
        version: step.version,
        kind: step.kind,
        provider: step.agent,
        model: step.model,
      };
    }
  }
  return null;
}
