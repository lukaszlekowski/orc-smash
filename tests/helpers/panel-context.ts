import type { StepKind, StepStatus } from '../../src/state.js';
import type { PanelContext } from '../../src/status.js';

/**
 * Frozen snapshot of a PanelContext at capture time. The live `PanelContext`
 * holds the precomputed global timeline rows. Tests that need to assert
 * against the pre-spawn or mid-spawn state snapshot the other live fields
 * immediately; the timeline itself is intentionally stable for one step.
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
  inFlightRole: string | null;
  inFlightStatus: StepStatus | null;
  inFlightStartedAtMs: number | null;
  latestVersion: number;
  readOnly: boolean;
}

export type { PanelContext };
