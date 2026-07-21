import { readFileSync } from 'node:fs';
import type { OutputContract } from './manifest.js';
import { parseArtifactMetaClassified } from './provenance.js';

export type DecisionOutcome = 'accepted' | 'retry' | 'unknown';

export type CompletionOutcome = 'COMPLETED' | 'BLOCKED' | 'unknown';

export type RequiredOutcome = 'valid' | 'unknown';

/**
 * Parse a decision-artifact file against its configured accepted/retry tokens.
 * Returns the canonical decision or 'unknown'.
 */
export function parseDecisionArtifact(
  filePath: string,
  heading: string,
  acceptedToken: string,
  retryToken: string,
): DecisionOutcome {
  return parseDecisionContent(readFileSync(filePath, 'utf-8'), heading, acceptedToken, retryToken);
}

export function parseDecisionContent(
  content: string,
  heading: string,
  acceptedToken: string,
  retryToken: string,
): DecisionOutcome {
  const headingPattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, 'im');
  const match = headingPattern.exec(content);
  if (!match) return 'unknown';

  const afterHeading = content.slice(match.index + match[0].length);
  const nextHeadingMatch = /^##\s+/m.exec(afterHeading);
  const section = nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;

  const lines = section.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.replace(/^[*\s]+/, '').replace(/[*\s]+$/, '').trim().toUpperCase();
    if (line === acceptedToken.toUpperCase()) return 'accepted';
    if (line === retryToken.toUpperCase()) return 'retry';
  }
  return 'unknown';
}

/**
 * Parse a completion-artifact file. Returns COMPLETED, BLOCKED, or unknown.
 * Requires exactly one `## Outcome` section whose first non-blank line is
 * exactly `COMPLETED` or `BLOCKED`.
 */
export function parseCompletionArtifact(filePath: string): CompletionOutcome {
  return parseCompletionContent(readFileSync(filePath, 'utf-8'));
}

export function parseCompletionContent(content: string): CompletionOutcome {
  const headingRe = /^##\s+Outcome\s*$/gim;
  const matches: RegExpExecArray[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(content)) !== null) {
    matches.push(m);
  }
  if (matches.length === 0) return 'unknown';
  if (matches.length > 1) return 'unknown';

  const afterHeading = content.slice(matches[0]!.index + matches[0]![0].length);
  const nextHeadingMatch = /^##\s+/m.exec(afterHeading);
  const section = nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;

  const lines = section.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line === 'COMPLETED') return 'COMPLETED';
    if (line === 'BLOCKED') return 'BLOCKED';
    return 'unknown';
  }
  return 'unknown';
}

/**
 * Check that a required-artifact exists and has valid provenance.
 * The named validator is checked separately by the caller.
 */
export function requiredArtifactExists(filePath: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const result = parseArtifactMetaClassified(content, { agent: 'unknown', version: 0 });
    return result.status === 'classified';
  } catch {
    return false;
  }
}

/**
 * Classify an artifact against its output contract.
 */
export function classifyArtifact(
  filePath: string,
  contract: OutputContract,
  decision?: { heading: string; accepted: string; retry: string },
  validator?: (filePath: string) => boolean,
): { kind: 'accepted' | 'retry' | 'completed' | 'blocked' | 'valid' | 'unknown'; detail?: string } {
  try {
    const meta = parseArtifactMetaClassified(readFileSync(filePath, 'utf-8'), { agent: 'unknown', version: 0 });
    if (meta.status !== 'classified') {
      return { kind: 'unknown', detail: meta.reason };
    }
  } catch {
    return { kind: 'unknown', detail: 'missing or unreadable artifact' };
  }

  switch (contract) {
    case 'decision-artifact': {
      if (!decision) return { kind: 'unknown', detail: 'missing decision config' };
      const result = parseDecisionArtifact(filePath, decision.heading, decision.accepted, decision.retry);
      return { kind: result };
    }
    case 'completion-artifact': {
      const result = parseCompletionArtifact(filePath);
      if (result === 'COMPLETED') return { kind: 'completed' };
      if (result === 'BLOCKED') return { kind: 'blocked', detail: 'BLOCKED' };
      return { kind: 'unknown', detail: 'invalid or missing Outcome section' };
    }
    case 'required-artifact': {
      if (!requiredArtifactExists(filePath)) return { kind: 'unknown', detail: 'missing or invalid provenance' };
      if (validator && !validator(filePath)) return { kind: 'unknown', detail: 'validator failed' };
      return { kind: 'valid' };
    }
    default:
      return { kind: 'unknown' };
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
