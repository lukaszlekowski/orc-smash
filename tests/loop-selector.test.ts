import { describe, it, expect } from 'vitest';
import { selectDefaultLoop } from '../src/loop-selector.js';
import type { LoopSpec } from '../src/manifest.js';

describe('loop-selector — selectDefaultLoop pure unit tests', () => {
  const loops: Record<string, LoopSpec> = {
    plan: {
      kind: 'doc-audit',
      target: 'docs/dev/plan.md',
      targetKind: 'file',
      audit: 'plan-audit',
      'follow-up': 'plan-follow-up',
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md',
      inputs: []
    },
    implement: {
      kind: 'implement',
      target: '.',
      targetKind: 'worktree',
      planPath: 'docs/dev/plan.md',
      implement: '30-simple-implement',
      implementPattern: 'docs/dev/impl-v{n}-{agent}.md',
      inputs: []
    },
    review: {
      kind: 'code-review',
      target: '.',
      targetKind: 'worktree',
      planPath: 'docs/dev/plan.md',
      audit: 'review',
      'follow-up': 'review-follow-up',
      auditPattern: 'docs/dev/review-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/review-followup-v{n}-{agent}.md',
      inputs: []
    }
  };

  it('Rule 1: interrupted marker has absolute precedence', () => {
    // Even if progression facts suggest 'implement', the marker loop is selected
    const facts = { approvedPlanAuditPath: '/p/approved.md', currentPlanImplemented: false };
    const maxMtimes = { plan: 100, review: 50 };

    expect(selectDefaultLoop('plan', loops, facts, maxMtimes)).toBe('plan');
    expect(selectDefaultLoop('implement', loops, facts, maxMtimes)).toBe('implement');
    expect(selectDefaultLoop('review', loops, facts, maxMtimes)).toBe('review');
  });

  it('Rule 2: progression logic plan -> implement -> review', () => {
    // 2a. No approved plan -> 'plan'
    expect(selectDefaultLoop(null, loops, { approvedPlanAuditPath: null, currentPlanImplemented: false }, {})).toBe('plan');

    // 2b. Approved plan, not yet implemented -> 'implement'
    expect(selectDefaultLoop(null, loops, { approvedPlanAuditPath: '/p/approved.md', currentPlanImplemented: false }, {})).toBe('implement');

    // 2c. Approved plan and implemented -> 'review'
    expect(selectDefaultLoop(null, loops, { approvedPlanAuditPath: '/p/approved.md', currentPlanImplemented: true }, {})).toBe('review');

    // 2d. Approved plan and implemented, but no review loop -> throws
    const loopsWithoutReview: Record<string, LoopSpec> = {
      plan: loops.plan!,
      implement: loops.implement!
    };
    expect(() =>
      selectDefaultLoop(null, loopsWithoutReview, { approvedPlanAuditPath: '/p/approved.md', currentPlanImplemented: true }, {})
    ).toThrow("Loop selection failed: Rule 2 requires 'review' loop but it is not defined in the manifest.");
  });

  it('Rule 3: selects the non-implement loop with the newest activity when Rule 2 is not active', () => {
    // Mock a manifest with loopA and loopB (Rule 2 is not active because there is no 'implement' loop defined)
    const customLoops: Record<string, LoopSpec> = {
      loopA: {
        kind: 'doc-audit',
        target: 'a.md',
        targetKind: 'file',
        audit: 'skill-a',
        'follow-up': 'skill-a-follow',
        auditPattern: 'a-v{n}.md',
        followUpPattern: 'af-v{n}.md',
        inputs: []
      },
      loopB: {
        kind: 'doc-audit',
        target: 'b.md',
        targetKind: 'file',
        audit: 'skill-b',
        'follow-up': 'skill-b-follow',
        auditPattern: 'b-v{n}.md',
        followUpPattern: 'bf-v{n}.md',
        inputs: []
      }
    };

    expect(selectDefaultLoop(null, customLoops, null, { loopA: 1000, loopB: 500 })).toBe('loopA');
    expect(selectDefaultLoop(null, customLoops, null, { loopA: 500, loopB: 2000 })).toBe('loopB');
  });

  it('Rule 4: falls back to the first non-implement loop when no history/mtimes exist', () => {
    expect(selectDefaultLoop(null, loops, null, { plan: null, review: null })).toBe('plan');
  });
});
