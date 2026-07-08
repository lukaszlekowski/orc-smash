import type { Verdict } from './verdict.js';

/**
 * Single source of truth for next-step / restart decisions.
 *
 * The restart rule ("what should happen after the latest audit?") was previously
 * recomputed in `scan`, `loop`, and `status`. It is a domain rule and must exist
 * exactly once. This module owns it.
 *
 * `resolveNextStep(...)` returns enough data for both runtime flow
 * (`nextSkill` / `followUpVersion` / `nextAuditVersion`) and status messaging
 * (`state` / `nextAuditVersion`), so the status panel and the loop cannot drift.
 */

export type NextStepState = 'fresh' | 'rejected' | 'approved' | 'unknown-latest-audit';

export interface NextStepDecision {
  state: NextStepState;
  nextSkill: 'audit' | 'follow-up' | null;
  followUpVersion: number | null;
  nextAuditVersion: number;
  priorAuditPath: string | null;
}

export interface NextStepInput {
  latestVerdict: Verdict | null;
  latestVersion: number;
  hasAudits: boolean;
  latestAuditPath: string | null;
}

export function resolveNextStep(input: NextStepInput): NextStepDecision {
  const { latestVerdict, latestVersion, hasAudits, latestAuditPath } = input;

  if (!hasAudits) {
    return {
      state: 'fresh',
      nextSkill: 'audit',
      followUpVersion: null,
      nextAuditVersion: 1,
      priorAuditPath: null
    };
  }

  switch (latestVerdict) {
    case 'REJECTED':
      // The follow-up repairs the rejected version (same N); the next audit is N+1.
      return {
        state: 'rejected',
        nextSkill: 'follow-up',
        followUpVersion: latestVersion,
        nextAuditVersion: latestVersion + 1,
        priorAuditPath: latestAuditPath
      };
    case 'APPROVED':
      // Approved round closes; the next round's audit is N+1.
      return {
        state: 'approved',
        nextSkill: 'audit',
        followUpVersion: null,
        nextAuditVersion: latestVersion + 1,
        priorAuditPath: latestAuditPath
      };
    default:
      // 'unknown' (or anomalous null): terminal — no next skill advances the loop.
      return {
        state: 'unknown-latest-audit',
        nextSkill: null,
        followUpVersion: null,
        nextAuditVersion: latestVersion + 1,
        priorAuditPath: latestAuditPath
      };
  }
}

