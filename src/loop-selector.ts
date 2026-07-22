import type { LoopSpec, Manifest } from './manifest.js';
import { readInterruptedMarker } from './interrupted-artifact.js';
import { scanGlobalSnapshot } from './state.js';
import { recoverInProgressRun } from './pipeline-state.js';

/** Select the most recently active configured loop from generic artifact activity. */
export function selectDefaultLoop(
  markerBinding: string | null,
  loops: Record<string, LoopSpec>,
  loopMaxMtimes: Record<string, number | null>,
): string {
  if (markerBinding && loops[markerBinding]) return markerBinding;

  let selected: string | null = null;
  let newest = -1;
  for (const id of Object.keys(loops)) {
    const mtime = loopMaxMtimes[id];
    if (mtime !== undefined && mtime !== null && mtime > newest) {
      newest = mtime;
      selected = id;
    }
  }
  if (selected) return selected;
  return Object.keys(loops)[0] ?? '';
}

export function resolveDefaultLoop(
  projectRoot: string,
  manifest: Manifest,
): {
  loopName: string;
} {
  const marker = readInterruptedMarker(projectRoot);
  const markerBinding = marker?.loop ?? null;
  const snapshot = scanGlobalSnapshot(projectRoot, manifest);
  const loopMaxMtimes: Record<string, number | null> = {};
  for (const id of Object.keys(manifest.loops)) {
    const steps = snapshot.byBinding.get(id) ?? [];
    loopMaxMtimes[id] = steps.reduce<number | null>((max, step) => (
      max === null || step.mtime > max ? step.mtime : max
    ), null);
  }

  return {
    loopName: selectDefaultLoop(markerBinding, manifest.loops, loopMaxMtimes),
  };
}

// ---- F7: Checks for operator menu state ----

/**
 * Check if a given binding id has an in-progress (unresolved) chain.
 * Returns true when there are artifact steps with no terminal decision.
 */
export function bindingHasInProgressChain(
  projectRoot: string,
  manifest: Manifest,
  bindingId: string,
): boolean {
  const snapshot = scanGlobalSnapshot(projectRoot, manifest);
  const steps = snapshot.byBinding.get(bindingId) ?? [];
  if (steps.length === 0) return false;
  const recovered = recoverInProgressRun(steps as any);
  if (!recovered) return false;
  const latest = steps[steps.length - 1]!;
  if (latest.decision === 'accepted' || latest.completionOutcome === 'completed') return false;
  if (latest.unclassified) return false;
  return true;
}

/**
 * Check if a given loop binding has at least one completed (accepted) artifact
 * that can serve as a second-opinion target.
 */
export function bindingHasCompletedAcceptance(
  projectRoot: string,
  manifest: Manifest,
  bindingId: string,
): boolean {
  const snapshot = scanGlobalSnapshot(projectRoot, manifest);
  const steps = snapshot.byBinding.get(bindingId) ?? [];
  return steps.some(s => s.decision === 'accepted' && !s.unclassified);
}
