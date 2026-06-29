export type FollowUpOutcome = 'patched' | 'blocked';

export const FOLLOW_UP_OUTCOME_HEADING = '## Follow-up Outcome';

/**
 * Single source of truth for follow-up outcome parsing. Matches the first
 * `patched`/`blocked` token immediately under the `## Follow-up Outcome` heading.
 */
export function parseFollowUpOutcome(content: string): FollowUpOutcome {
  const regex = new RegExp(`^##\\s*Follow-up Outcome\\s*\\r?\\n\\s*\\r?\\n?\\s*(patched|blocked)\\b`, 'im');
  const m = content.match(regex);
  return m && m[1] === 'blocked' ? 'blocked' : 'patched';
}

/**
 * Render the Follow-up Outcome section with canonical formatting.
 */
export function renderFollowUpOutcomeSection(outcome: FollowUpOutcome): string {
  return `${FOLLOW_UP_OUTCOME_HEADING}\n\n${outcome}`;
}
