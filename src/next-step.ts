import { captureTargetFingerprint } from './target-snapshot.js';
import type { V1Manifest } from './manifest.js';
import { eligibleNextStages, pipelineStageCandidates, artifactRecordFromStep, type Candidate } from './pipeline-stage-state.js';
import { scanGlobalSnapshot } from './state.js';

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
  const artifacts = snapshot.steps.map(artifactRecordFromStep);
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
  const artifacts = snapshot.steps.map(artifactRecordFromStep);
  const targetSnapshots = buildTargetSnapshots(projectRoot, manifest);
  return pipelineStageCandidates(artifacts, manifest, targetSnapshots);
}
