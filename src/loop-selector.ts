import type { LoopSpec, Manifest } from './manifest.js';
import { readInterruptedMarker } from './interrupted-artifact.js';
import { scan, resolveImplementFacts } from './state.js';

export function selectDefaultLoop(
  markerLoop: string | null,
  loops: Record<string, LoopSpec>,
  implementFacts: { approvedPlanAuditPath: string | null; currentPlanImplemented: boolean } | null,
  loopMaxMtimes: Record<string, number | null>
): string {
  // Rule 1: marker loop precedence
  if (markerLoop && loops[markerLoop]) {
    return markerLoop;
  }

  // Rule 2: post-plan/post-implement progression
  const hasPlan = 'plan' in loops;
  const hasImplement = 'implement' in loops;
  if (hasPlan && hasImplement && implementFacts) {
    if (implementFacts.currentPlanImplemented) {
      if ('review' in loops) {
        return 'review';
      }
      throw new Error("Loop selection failed: Rule 2 requires 'review' loop but it is not defined in the manifest.");
    } else if (implementFacts.approvedPlanAuditPath !== null) {
      return 'implement';
    } else {
      return 'plan';
    }
  }

  // Rule 3: most recent activity heuristic
  let selectedLoop: string | null = null;
  let maxMtime = -1;

  for (const [key, spec] of Object.entries(loops)) {
    if (spec.kind === 'implement') continue;
    const mtime = loopMaxMtimes[key];
    if (mtime !== undefined && mtime !== null && mtime > maxMtime) {
      maxMtime = mtime;
      selectedLoop = key;
    }
  }

  if (selectedLoop !== null) {
    return selectedLoop;
  }

  // Rule 4: Fallback to the first non-implement loop defined in manifest
  for (const [key, spec] of Object.entries(loops)) {
    if (spec.kind !== 'implement') {
      return key;
    }
  }

  // Final absolute fallback
  return Object.keys(loops)[0] || 'plan';
}

export function resolveDefaultLoop(
  projectRoot: string,
  manifest: Manifest
): {
  loopName: string;
  implementFacts: { approvedPlanAuditPath: string | null; currentPlanImplemented: boolean; nextVersion: number } | null;
} {
  const marker = readInterruptedMarker(projectRoot);
  const markerLoop = marker ? marker.loop : null;

  // Gather implement facts if plan and implement loop exist
  let implementFacts: { approvedPlanAuditPath: string | null; currentPlanImplemented: boolean; nextVersion: number } | null = null;
  const planSpec = manifest.loops['plan'];
  const implementSpec = manifest.loops['implement'];
  if (planSpec && implementSpec) {
    implementFacts = resolveImplementFacts(
      projectRoot,
      { auditPattern: planSpec.auditPattern ?? '', followUpPattern: planSpec.followUpPattern ?? '' },
      { implementPattern: implementSpec.implementPattern ?? '' }
    );
  }

  // Gather max mtimes for non-implement loops
  const loopMaxMtimes: Record<string, number | null> = {};
  for (const [key, spec] of Object.entries(manifest.loops)) {
    if (spec.kind === 'implement') continue;
    const stateScan = scan(projectRoot, {
      auditPattern: spec.auditPattern ?? '',
      followUpPattern: spec.followUpPattern ?? ''
    });
    let max: number | null = null;
    for (const step of stateScan.timeline) {
      if (max === null || step.mtime > max) {
        max = step.mtime;
      }
    }
    loopMaxMtimes[key] = max;
  }

  const loopName = selectDefaultLoop(markerLoop, manifest.loops, implementFacts, loopMaxMtimes);

  return {
    loopName,
    implementFacts
  };
}
