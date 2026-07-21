import type { LoopSpec, Manifest } from './manifest.js';
import { readInterruptedMarker } from './interrupted-artifact.js';
import { scanGlobalSnapshot } from './state.js';

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
