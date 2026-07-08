import { describe, it, expect } from 'vitest';
import {
  buildStageActions,
  findResumableSession,
  deriveContinuity,
  type LoopMenuState
} from '../src/stage-menu.js';
import type { Step } from '../src/state.js';

describe('stage-menu: buildStageActions recommended-parity', () => {
  const cases: {
    state: Partial<LoopMenuState>;
    expectedRecId: string;
    description: string;
  }[] = [
    {
      state: { phase: 'fresh', latestAuditVersion: 0, decisionPoint: 'startup', loopName: 'plan' },
      expectedRecId: 'start-new-new-session',
      description: 'fresh | startup -> START NEW — NEW SESSION (audit v1)'
    },
    {
      state: { phase: 'rejected-no-followup', latestAuditVersion: 3, pendingFollowUpVersion: 3, decisionPoint: 'startup', loopName: 'plan' },
      expectedRecId: 'continue',
      description: 'rejected-no-followup | startup -> CONTINUE'
    },
    {
      state: { phase: 'rejected-followup-done', latestAuditVersion: 3, decisionPoint: 'startup', loopName: 'plan' },
      expectedRecId: 'continue',
      description: 'rejected-followup-done | startup -> CONTINUE'
    },
    {
      state: { phase: 'rejected-no-followup', latestAuditVersion: 3, pendingFollowUpVersion: 3, decisionPoint: 'in-loop', loopName: 'plan' },
      expectedRecId: 'continue',
      description: 'rejected-no-followup | in-loop -> CONTINUE (follow-up -> audit)'
    },
    {
      state: { phase: 'rejected-followup-done', latestAuditVersion: 3, decisionPoint: 'in-loop', loopName: 'plan' },
      expectedRecId: 'continue',
      description: 'rejected-followup-done | in-loop -> CONTINUE (audit -> follow-up)'
    },
    {
      state: { phase: 'approved', latestAuditVersion: 4, decisionPoint: 'startup', loopName: 'plan' },
      expectedRecId: 'start-new-new-session',
      description: 'approved | startup -> START NEW — NEW SESSION (new-round audit v5)'
    },
    {
      state: { phase: 'approved', latestAuditVersion: 4, decisionPoint: 'in-loop', loopName: 'plan' },
      expectedRecId: 'stop',
      description: 'approved | in-loop -> Stop'
    },
    {
      state: { phase: 'implement-done', latestAuditVersion: 1, decisionPoint: 'startup', loopName: 'implement' },
      expectedRecId: 'stop',
      description: 'implement-done | startup -> Stop'
    },
    {
      state: { phase: 'implement-done', latestAuditVersion: 1, decisionPoint: 'in-loop', loopName: 'implement' },
      expectedRecId: 'stop',
      description: 'implement-done | in-loop -> Stop'
    }
  ];

  for (const tc of cases) {
    it(tc.description, () => {
      const fullState: LoopMenuState = {
        phase: 'fresh',
        latestAuditVersion: 0,
        pendingFollowUpVersion: null,
        decisionPoint: 'startup',
        loopName: 'plan',
        ...tc.state
      };
      const { actions, recommendedId } = buildStageActions(fullState);
      expect(recommendedId).toBe(tc.expectedRecId);
      const recAction = actions.find(a => a.id === recommendedId);
      expect(recAction).toBeDefined();
      expect(recAction?.recommended).toBe(true);
      expect(actions.filter(a => a.recommended).length).toBe(1);
    });
  }
});

describe('stage-menu: findResumableSession backward walk logic', () => {
  const baseStep = (kind: 'audit' | 'follow-up', version: number, agent: string, model: string, sid: string, verdict?: 'APPROVED' | 'REJECTED'): Step => ({
    kind,
    role: kind === 'audit' ? 'auditor' : 'planner',
    agent,
    model,
    version,
    status: 'done',
    verdict,
    artifactPath: `/path/to/v${version}.md`,
    mtime: Date.now(),
    sessionId: sid,
    sessionMode: 'resumed'
  });

  it('same-agent+model vs same-agent-different-model lock', () => {
    const steps = [
      baseStep('audit', 1, 'codex', 'gpt-4', 'sess_1'),
      baseStep('audit', 2, 'codex', 'gpt-5', 'sess_2')
    ];

    // matches codex + gpt-5
    const res = findResumableSession(steps, ['audit'], 'codex', 'gpt-5');
    expect(res?.sessionId).toBe('sess_2');

    // matches codex + gpt-4
    const resOld = findResumableSession(steps, ['audit'], 'codex', 'gpt-4');
    expect(resOld?.sessionId).toBe('sess_1');

    // no match for model mismatch
    const resMismatch = findResumableSession(steps, ['audit'], 'codex', 'gpt-6');
    expect(resMismatch).toBeNull();
  });

  it('stopAtApproved default (true) stops at first APPROVED audit', () => {
    // default stopAtApproved stops at v2 approved and returns null because we walk backward, hit approved, and stop.
    // What if we look for an audit session after the approved audit has been hit?
    const stepsWithApprovedLast = [
      baseStep('audit', 1, 'codex', 'gpt-5', 'sess_1'),
      baseStep('audit', 2, 'codex', 'gpt-5', 'sess_2', 'APPROVED')
    ];
    const resDefault = findResumableSession(stepsWithApprovedLast, ['audit'], 'codex', 'gpt-5');
    expect(resDefault).toBeNull();
  });

  it('stopAtApproved: false resumes approval session', () => {
    const steps = [
      baseStep('audit', 1, 'codex', 'gpt-5', 'sess_1'),
      baseStep('audit', 2, 'codex', 'gpt-5', 'sess_2', 'APPROVED')
    ];

    const res = findResumableSession(steps, ['audit'], 'codex', 'gpt-5', { stopAtApproved: false });
    expect(res?.sessionId).toBe('sess_2');
    expect(res?.version).toBe(2);
  });

  it('stopAtApproved: false does not skip past approval to older session if agent/model mismatch', () => {
    const steps = [
      baseStep('audit', 1, 'codex', 'gpt-5', 'sess_1'),
      baseStep('audit', 2, 'claude', 'sonnet', 'sess_2', 'APPROVED')
    ];

    // Looking for codex gpt-5. Since latest audit (v2) is APPROVED, we hit it.
    // Even though stopAtApproved is false, v2 does not match codex/gpt-5.
    // We stop at the APPROVED audit and do not skip past it to v1.
    const res = findResumableSession(steps, ['audit'], 'codex', 'gpt-5', { stopAtApproved: false });
    expect(res).toBeNull();
  });

  it('version-agnostic backward search over kind trail', () => {
    // Finds v1 session even if v2 was not run or has no session
    const steps = [
      baseStep('follow-up', 1, 'codex', 'gpt-5', 'sess_f1'),
      baseStep('audit', 2, 'codex', 'gpt-5', 'sess_a2', 'REJECTED')
    ];

    const resFollowUp = findResumableSession(steps, ['follow-up'], 'codex', 'gpt-5');
    expect(resFollowUp?.sessionId).toBe('sess_f1');
    expect(resFollowUp?.version).toBe(1);
  });

  it('one-off step is continuable', () => {
    const steps = [
      baseStep('audit', 1, 'codex', 'gpt-5', 'sess_oneoff_audit', 'REJECTED')
    ];
    const res = findResumableSession(steps, ['audit'], 'codex', 'gpt-5');
    expect(res?.sessionId).toBe('sess_oneoff_audit');
  });

  it('separate coverage for audit vs follow-up kinds', () => {
    const steps = [
      baseStep('follow-up', 1, 'codex', 'gpt-5', 'sess_f1'),
      baseStep('audit', 1, 'codex', 'gpt-5', 'sess_a1', 'REJECTED')
    ];

    const resAudit = findResumableSession(steps, ['audit'], 'codex', 'gpt-5');
    expect(resAudit?.sessionId).toBe('sess_a1');

    const resFollowUp = findResumableSession(steps, ['follow-up'], 'codex', 'gpt-5');
    expect(resFollowUp?.sessionId).toBe('sess_f1');
  });

  it('review loop approved state is terminal and has review-specific labels', () => {
    const freshState: LoopMenuState = {
      phase: 'fresh',
      latestAuditVersion: 0,
      pendingFollowUpVersion: null,
      decisionPoint: 'startup',
      loopName: 'review'
    };
    const freshRes = buildStageActions(freshState);
    const hasReviewTerms = freshRes.actions.every(a => a.label.toLowerCase().includes('review') && !a.label.toLowerCase().includes('audit'));
    expect(hasReviewTerms).toBe(true);

    const approvedState: LoopMenuState = {
      phase: 'approved',
      latestAuditVersion: 1,
      pendingFollowUpVersion: null,
      decisionPoint: 'in-loop',
      loopName: 'review'
    };
    const approvedRes = buildStageActions(approvedState);
    const hasContinue = approvedRes.actions.some(a => a.id === 'continue');
    expect(hasContinue).toBe(false);
  });

  it('approved phase continue action has correct label and sessionPolicy', () => {
    const fullState: LoopMenuState = {
      phase: 'approved',
      latestAuditVersion: 4,
      pendingFollowUpVersion: null,
      decisionPoint: 'in-loop',
      loopName: 'plan'
    };
    const { actions } = buildStageActions(fullState);
    const continueAction = actions.find(a => a.id === 'continue');
    expect(continueAction).toBeDefined();
    expect(continueAction?.sessionPolicy).toEqual({ followUp: 'resumed', audit: 'resumed' });
    expect(continueAction?.label).toContain('CONTINUE CHAIN — resume the APPROVAL session');
    expect(continueAction?.label).toContain('audit v5 → follow-up v5');
  });
});

describe('stage-menu: deriveContinuity', () => {
  it('identifies agent continuity support correctly', () => {
    expect(deriveContinuity('codex')).toBe(true);
    expect(deriveContinuity('opencode')).toBe(true);
    expect(deriveContinuity('claude')).toBe(true);
    expect(deriveContinuity('agy')).toBe(false);
    expect(deriveContinuity('fake')).toBe(false);
    expect(deriveContinuity('unknown')).toBe(false);
  });
});
