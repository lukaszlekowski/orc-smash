import type { Step } from './state.js';
import type { NextStepDecision } from './next-step.js';

export interface PanelContext {
  projectRoot: string;
  loopName: string;
  currentIteration: number;
  maxIterations: number;
  activeSkillRunner: { skillId: string; agent: string; model: string } | null;
  timeline: Step[];
  nextStepMessage: string;
}

export function buildPanelContext(
  projectRoot: string,
  loopName: string,
  currentIteration: number,
  maxIterations: number,
  activeSkillRunner: { skillId: string; agent: string; model: string } | null,
  timeline: Step[],
  nextStepMessage: string
): PanelContext {
  return {
    projectRoot,
    loopName,
    currentIteration,
    maxIterations,
    activeSkillRunner,
    timeline,
    nextStepMessage
  };
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
