
/**
 * Single source of truth for next-step / restart decisions.
 *
 * The restart rule ("what should happen after the latest evaluation?") was previously
 * recomputed in `scan`, `loop`, and `status`. It is a domain rule and must exist
 * exactly once. This module owns it.
 *
 * `resolveNextStep(...)` returns enough data for both runtime flow
 * (`nextSkill` / `repairVersion` / `nextEvaluateVersion`) and status messaging
 * (`state` / `nextEvaluateVersion`), so the status panel and the loop cannot drift.
 */

export type NextStepState = 'fresh' | 'rejected' | 'accepted' | 'unknown-latest-evaluation';

export interface NextStepDecision {
  state: NextStepState;
  nextSkill: 'evaluate' | 'repair' | null;
  repairVersion?: number | null;
  nextEvaluateVersion?: number;
  priorArtifactPath?: string | null;
}

export interface NextStepInput {
  /** Canonical decision (`accepted`/`retry`/`unknown`). */
  latestDecision: string | null;
  latestVersion: number;
  hasEvaluations: boolean;
  latestArtifactPath?: string | null;
}

export function resolveNextStep(input: NextStepInput): NextStepDecision {
  const { latestDecision, latestVersion, hasEvaluations } = input;
  const latestArtifactPath = input.latestArtifactPath ?? null;

  if (!hasEvaluations) {
    return {
      state: 'fresh',
      nextSkill: 'evaluate',
      repairVersion: null,
      nextEvaluateVersion: 1,
      priorArtifactPath: null
    };
  }

  switch (latestDecision) {
    case 'retry':
      // The repair fixes the rejected version (same N); the next evaluation is N+1.
      return {
        state: 'rejected',
        nextSkill: 'repair',
        repairVersion: latestVersion,
        nextEvaluateVersion: latestVersion + 1,
        priorArtifactPath: latestArtifactPath
      };
    case 'accepted':
      // Accepted round closes; the next round's evaluation is N+1.
      return {
        state: 'accepted',
        nextSkill: 'evaluate',
        repairVersion: null,
        nextEvaluateVersion: latestVersion + 1,
        priorArtifactPath: latestArtifactPath
      };
    default:
      // 'unknown' (or anomalous null): terminal — no next skill advances the loop.
      return {
        state: 'unknown-latest-evaluation',
        nextSkill: null,
        repairVersion: null,
        nextEvaluateVersion: latestVersion + 1,
        priorArtifactPath: latestArtifactPath
      };
  }
}
