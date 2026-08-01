import { captureBindingResultFingerprint } from './target-snapshot.js';
import type { V1Manifest } from './manifest.js';
import { eligibleNextStages, pipelineStageCandidates, artifactRecordFromStep, type Candidate } from './pipeline-stage-state.js';
import { scanGlobalSnapshot } from './state.js';

/**
 * Reconstruct the current binding snapshot for every pipeline stage: the
 * binding target plus its declared project-file dependencies. A stage whose
 * declared files are missing is omitted (not crashed) so the typed
 * missing-fingerprint and missing-input preflight paths fail closed.
 */
export function buildBindingSnapshots(projectRoot: string, manifest: V1Manifest): Map<string, string> {
  const snapshots = new Map<string, string>();
  for (const [pipelineId, pipeline] of Object.entries(manifest.pipelines ?? {})) {
    for (const stage of pipeline.stages) {
      const bindingId = stage.loop ?? stage.task;
      if (!bindingId) continue;
      const binding = manifest.loops[bindingId] ?? manifest.tasks?.[bindingId];
      if (!binding) continue;
      try {
        const fingerprint = captureBindingResultFingerprint(projectRoot, binding.target, binding.files, manifest);
        snapshots.set(`${pipelineId}:${stage.stageId}`, fingerprint);
      } catch {
        // Missing target or declared file: omit this stage's current snapshot.
      }
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
  const bindingSnapshots = buildBindingSnapshots(projectRoot, manifest);
  return eligibleNextStages(artifacts, manifest, bindingSnapshots);
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
  const bindingSnapshots = buildBindingSnapshots(projectRoot, manifest);
  return pipelineStageCandidates(artifacts, manifest, bindingSnapshots);
}
