import { parseDecisionContent, type DecisionOutcome } from './artifact-contract.js';

/** @deprecated Use parseDecisionContent with the binding's declared tokens. */
export type Verdict = DecisionOutcome;

/**
 * Compatibility entry point for callers that still use the old module name.
 * The parser itself is the generic configured decision classifier; stdout is
 * deliberately ignored because transport text is not artifact evidence.
 */
export function parseVerdict(
  fileContent: string | null,
  _stdout: string | null = null,
  decision: { heading: string; accepted: string; retry: string } = {
    heading: 'Verdict',
    accepted: 'APPROVED',
    retry: 'REJECTED',
  },
): Verdict {
  return parseDecisionContent(fileContent ?? '', decision.heading, decision.accepted, decision.retry);
}
