import type { Step, StepKind, StepStatus } from './state.js';
import type { NextStepDecision } from './next-step.js';

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
    skillId: string;
    agent: string;
    model: string;
    version: number;
    iteration: number;
    startedAtMs: number;
    status: StepStatus;
    message: string;
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

export function assembleNextStepMessage(decision: NextStepDecision, latestVersion: number): string {
  switch (decision.state) {
    case 'fresh':
      return `Ready to smash version ${decision.nextAuditVersion} (fresh)`;
    case 'rejected':
      return `Proposed next: follow-up then audit version ${decision.nextAuditVersion}`;
    case 'approved':
      return `Completed: approved at version ${latestVersion}`;
    case 'unknown-latest-audit':
      return `Terminal error: latest audit is unparseable`;
  }
}
