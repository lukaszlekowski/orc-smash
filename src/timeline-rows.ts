import type { GlobalSnapshot, Step } from './state.js';

export type TimelineRelevance =
  | 'current-chain'
  | 'current-run'
  | 'unrelated'
  | 'unclassified';

export interface TimelineRow {
  step: Step;
  relevance: TimelineRelevance;
}

export interface TimelineRelevanceContext {
  chainId: string | null;
  pipelineId: string | null;
  pipelineRunId: string | null;
  bindingId: string;
}

/**
 * Derive display-only rows from the already validated global artifact
 * snapshot. The returned rows retain the scanner's causal order and never
 * mutate the authoritative Step objects.
 */
export function buildTimelineRows(
  snapshot: GlobalSnapshot,
  context: TimelineRelevanceContext,
): TimelineRow[] {
  return snapshot.steps.map((step): TimelineRow => {
    if (step.unclassified) {
      return { step, relevance: 'unclassified' };
    }
    if (step.chainId && step.chainId === context.chainId) {
      return { step, relevance: 'current-chain' };
    }
    if (
      context.pipelineId &&
      context.pipelineRunId &&
      step.pipelineId === context.pipelineId &&
      step.pipelineRunId === context.pipelineRunId
    ) {
      return { step, relevance: 'current-run' };
    }
    return { step, relevance: 'unrelated' };
  });
}

export function latestVersionForBinding(
  snapshot: GlobalSnapshot,
  bindingId: string,
  inFlightVersion = 0,
): number {
  return Math.max(
    inFlightVersion,
    ...snapshot.steps
      .filter(step => step.bindingId === bindingId)
      .map(step => step.version),
    0,
  );
}
