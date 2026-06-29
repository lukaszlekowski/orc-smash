import { describe, it, expect } from 'vitest';
import { resolveNextStep, allowedStartPoint } from '../src/next-step.js';

describe('resolveNextStep (canonical next-step / restart rule)', () => {
  it('fresh: no audits => audit version 1, no follow-up', () => {
    const d = resolveNextStep({
      latestVerdict: null,
      latestVersion: 0,
      hasAudits: false,
      latestAuditPath: null
    });
    expect(d.state).toBe('fresh');
    expect(d.nextSkill).toBe('audit');
    expect(d.followUpVersion).toBeNull();
    expect(d.nextAuditVersion).toBe(1);
    expect(d.priorAuditPath).toBeNull();
  });

  it('rejected: follow-up repairs latest version, next audit is latest + 1', () => {
    const d = resolveNextStep({
      latestVerdict: 'REJECTED',
      latestVersion: 3,
      hasAudits: true,
      latestAuditPath: '/proj/docs/dev/plan-audit-v3-codex.md'
    });
    expect(d.state).toBe('rejected');
    expect(d.nextSkill).toBe('follow-up');
    // Follow-up version is the version being repaired (N), next audit is N + 1.
    expect(d.followUpVersion).toBe(3);
    expect(d.nextAuditVersion).toBe(4);
    expect(d.priorAuditPath).toBe('/proj/docs/dev/plan-audit-v3-codex.md');
  });

  it('approved: next round audit is latest + 1, no follow-up', () => {
    const d = resolveNextStep({
      latestVerdict: 'APPROVED',
      latestVersion: 2,
      hasAudits: true,
      latestAuditPath: '/proj/docs/dev/plan-audit-v2-claude.md'
    });
    expect(d.state).toBe('approved');
    expect(d.nextSkill).toBe('audit');
    expect(d.followUpVersion).toBeNull();
    expect(d.nextAuditVersion).toBe(3);
    expect(d.priorAuditPath).toBe('/proj/docs/dev/plan-audit-v2-claude.md');
  });

  it('unknown latest audit: terminal, no advancing skill', () => {
    const d = resolveNextStep({
      latestVerdict: 'unknown',
      latestVersion: 5,
      hasAudits: true,
      latestAuditPath: '/proj/docs/dev/plan-audit-v5-opencode.md'
    });
    expect(d.state).toBe('unknown-latest-audit');
    expect(d.nextSkill).toBeNull();
    expect(d.followUpVersion).toBeNull();
    expect(d.nextAuditVersion).toBe(6);
    expect(d.priorAuditPath).toBe('/proj/docs/dev/plan-audit-v5-opencode.md');
  });
});

describe('allowedStartPoint (verdict -> start-point mapping)', () => {
  it('maps fresh -> fresh', () => {
    const d = resolveNextStep({ latestVerdict: null, latestVersion: 0, hasAudits: false, latestAuditPath: null });
    expect(allowedStartPoint(d)).toBe('fresh');
  });

  it('maps rejected -> resume', () => {
    const d = resolveNextStep({ latestVerdict: 'REJECTED', latestVersion: 1, hasAudits: true, latestAuditPath: '/a.md' });
    expect(allowedStartPoint(d)).toBe('resume');
  });

  it('maps approved -> new-round', () => {
    const d = resolveNextStep({ latestVerdict: 'APPROVED', latestVersion: 1, hasAudits: true, latestAuditPath: '/a.md' });
    expect(allowedStartPoint(d)).toBe('new-round');
  });

  it('maps unknown-latest-audit -> null (terminal, no start point)', () => {
    const d = resolveNextStep({ latestVerdict: 'unknown', latestVersion: 1, hasAudits: true, latestAuditPath: '/a.md' });
    expect(allowedStartPoint(d)).toBeNull();
  });
});
