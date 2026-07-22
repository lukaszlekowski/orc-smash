import { captureTargetFingerprint } from './target-snapshot.js';
import type { V1Manifest } from './manifest.js';
import { eligibleNextStages, pipelineStageCandidates } from './pipeline-state.js';
import type { Candidate } from './pipeline-state.js';
import { scanGlobalSnapshot } from './state.js';

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
 *
 * F9: `pipelineSuggestions(...)` returns the ordered collection of explainable
 * next-stage candidates for display and operator selection.
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
      return {
        state: 'rejected',
        nextSkill: 'repair',
        repairVersion: latestVersion,
        nextEvaluateVersion: latestVersion + 1,
        priorArtifactPath: latestArtifactPath
      };
    case 'accepted':
      return {
        state: 'accepted',
        nextSkill: 'evaluate',
        repairVersion: null,
        nextEvaluateVersion: latestVersion + 1,
        priorArtifactPath: latestArtifactPath
      };
    default:
      return {
        state: 'unknown-latest-evaluation',
        nextSkill: null,
        repairVersion: null,
        nextEvaluateVersion: latestVersion + 1,
        priorArtifactPath: latestArtifactPath
      };
  }
}

// ---- F9: Pipeline suggestion logic ----

/**
 * Compute fingerprint snapshots for every binding target across all pipelines.
 * Used by the eligibility predicate to check staleness.
 */
export function buildTargetSnapshots(projectRoot: string, manifest: V1Manifest): Map<string, string> {
  const snapshots = new Map<string, string>();
  for (const [pipelineId, pipeline] of Object.entries(manifest.pipelines ?? {})) {
    for (const stage of pipeline.stages) {
      const bindingId = stage.loop ?? stage.task;
      if (!bindingId) continue;
      const binding = manifest.loops[bindingId] ?? manifest.tasks?.[bindingId];
      if (!binding) continue;
      const fingerprint = captureTargetFingerprint(projectRoot, binding.target, manifest);
      snapshots.set(`${pipelineId}:${stage.stageId}`, fingerprint);
    }
  }
  return snapshots;
}

/**
 * Return the ordered collection of explainable next-stage candidates for
 * every pipeline, consuming the R1 eligibility predicate.
 *
 * Each candidate carries the evidence (decision, completion, staleness) needed
 * for the status display and the operator's `Start suggested stage` selection.
 */
export function pipelineSuggestions(
  projectRoot: string,
  manifest: V1Manifest,
): Candidate[] {
  const snapshot = scanGlobalSnapshot(projectRoot, manifest);
  const artifacts = snapshot.steps.map(s => ({
    artifactIdentity: s.artifactIdentity ?? '',
    pipelineId: s.pipelineId ?? null,
    pipelineRunId: s.pipelineRunId ?? null,
    stageId: s.stageId ?? null,
    chainId: s.chainId ?? '',
    chainMode: (s.chainMode ?? null) as any,
    parentArtifactIdentity: s.parentArtifactIdentity ?? null,
    resultFingerprint: s.resultFingerprint ?? '',
    artifactPath: s.artifactPath,
    decision: s.decision,
    completionOutcome: s.completionOutcome,
    contractValid: !s.unclassified,
    version: s.version,
  }));
  const targetSnapshots = buildTargetSnapshots(projectRoot, manifest);
  return eligibleNextStages(artifacts, manifest, targetSnapshots);
}

/**
 * Return ALL pipeline stage candidates (including stale ones) for status
 * display, so the operator can see why a suggestion is unavailable.
 */
export function allPipelineCandidates(
  projectRoot: string,
  manifest: V1Manifest,
): Candidate[] {
  const snapshot = scanGlobalSnapshot(projectRoot, manifest);
  const artifacts = snapshot.steps.map(s => ({
    artifactIdentity: s.artifactIdentity ?? '',
    pipelineId: s.pipelineId ?? null,
    pipelineRunId: s.pipelineRunId ?? null,
    stageId: s.stageId ?? null,
    chainId: s.chainId ?? '',
    chainMode: (s.chainMode ?? null) as any,
    parentArtifactIdentity: s.parentArtifactIdentity ?? null,
    resultFingerprint: s.resultFingerprint ?? '',
    artifactPath: s.artifactPath,
    decision: s.decision,
    completionOutcome: s.completionOutcome,
    contractValid: !s.unclassified,
    version: s.version,
  }));
  const targetSnapshots = buildTargetSnapshots(projectRoot, manifest);
  return pipelineStageCandidates(artifacts, manifest, targetSnapshots);
}
