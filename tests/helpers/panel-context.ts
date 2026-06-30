import type { StepKind, StepStatus } from '../../src/state.js';
import type { PanelContext } from '../../src/status.js';

/**
 * Frozen snapshot of a PanelContext at capture time. The live `PanelContext`
 * holds a reference to the loop's `steps` array (the `timeline` field), which
 * is mutated as the loop progresses. Tests that need to assert against the
 * pre-spawn or mid-spawn state must snapshot the timeline (and other fields)
 * immediately — without snapshotting, every captured context reflects the
 * final loop state and the pre-artifact assertions become impossible.
 */
export interface PanelContextSnapshot {
  projectRoot: string;
  loopName: string;
  currentIteration: number;
  maxIterations: number;
  activeSkillRunner: { skillId: string; agent: string; model: string } | null;
  timelineKinds: StepKind[];
  nextStepMessage: string;
  inFlightKind: StepKind | null;
  inFlightStatus: StepStatus | null;
  inFlightStartedAtMs: number | null;
  latestVersion: number;
  readOnly: boolean;
}

export type { PanelContext };
