import type { Verdict } from './verdict.js';
import type { Step, StepKind } from './state.js';

export type SessionPolicy = 'new' | 'resumed';

export interface StageAction {
  id: string;
  group: 'start-new' | 'continue' | 'run-one-step';
  stage: 'audit' | 'follow-up' | 'implement' | 'stop';
  version: number;
  // Single policy for one-step actions; per-kind map for a CONTINUE that bundles follow-up+audit.
  sessionPolicy: SessionPolicy | { followUp: SessionPolicy; audit: SessionPolicy };
  sessionId?: string;
  provider?: string;
  model?: string;
  oneOff?: boolean;
  label: string;
  recommended: boolean;
  disabledReason?: string;
}

export type MenuPhase = 'fresh' | 'rejected-no-followup' | 'rejected-followup-done' | 'approved' | 'implement-done';

export interface LoopMenuState {
  phase: MenuPhase;
  latestAuditVersion: number;
  latestVerdict: Verdict | null;
  pendingFollowUpVersion: number | null;
  hasApprovedBoundary: boolean;
  decisionPoint: 'startup' | 'in-loop';
  loopName: string; // display-only
}

export function buildStageActions(input: LoopMenuState): { actions: StageAction[]; recommendedId: string } {
  const { phase, latestAuditVersion, pendingFollowUpVersion, decisionPoint, loopName } = input;
  const actions: StageAction[] = [];
  let recommendedId = '';

  const nextVer = latestAuditVersion + 1;
  const isPlanLoop = loopName === 'plan';

  if (phase === 'fresh') {
    recommendedId = 'start-new-new-session';
    actions.push({
      id: 'start-new-new-session',
      group: 'start-new',
      stage: 'audit',
      version: 1,
      sessionPolicy: 'new',
      label: 'START NEW CHAIN — NEW SESSION_ID each following run — next: audit v1 → follow-up v1',
      recommended: true,
    });
    actions.push({
      id: 'start-new-same-session',
      group: 'start-new',
      stage: 'audit',
      version: 1,
      sessionPolicy: 'resumed',
      label: 'START NEW CHAIN — SAME SESSION_ID each following run — next: audit v1 → follow-up v1',
      recommended: false,
    });
    actions.push({
      id: 'run-one-step-audit',
      group: 'run-one-step',
      stage: 'audit',
      version: 1,
      sessionPolicy: 'new',
      oneOff: true,
      label: 'Run audit v1 only — then re-prompt',
      recommended: false,
    });
  } else if (phase === 'rejected-no-followup' || phase === 'rejected-followup-done') {
    // In startup, both share recommended CONTINUE.
    // In-loop:
    //   rejected-no-followup -> recommended CONTINUE (follow-up -> audit)
    //   rejected-followup-done -> recommended CONTINUE (audit -> follow-up)
    recommendedId = 'continue';

    actions.push({
      id: 'start-new-new-session',
      group: 'start-new',
      stage: 'audit',
      version: nextVer,
      sessionPolicy: 'new',
      label: `START NEW CHAIN — NEW SESSION_ID each run — next: audit v${nextVer} → follow-up v${nextVer}`,
      recommended: false,
    });
    actions.push({
      id: 'start-new-same-session',
      group: 'start-new',
      stage: 'audit',
      version: nextVer,
      sessionPolicy: 'resumed',
      label: `START NEW CHAIN — SAME SESSION_ID each run — next: audit v${nextVer} → follow-up v${nextVer}`,
      recommended: false,
    });

    if (phase === 'rejected-no-followup') {
      const repairVer = pendingFollowUpVersion ?? latestAuditVersion;
      actions.push({
        id: 'continue',
        group: 'continue',
        stage: 'follow-up',
        version: repairVer,
        sessionPolicy: { followUp: 'resumed', audit: 'resumed' },
        label: `CONTINUE CHAIN — SAME SESSION_ID each run — next: follow-up v${repairVer} → audit v${repairVer + 1}`,
        recommended: true,
      });
      actions.push({
        id: 'run-one-step-audit',
        group: 'run-one-step',
        stage: 'audit',
        version: nextVer,
        sessionPolicy: 'new',
        oneOff: true,
        label: `Run audit v${nextVer} only — then re-prompt`,
        recommended: false,
      });
      actions.push({
        id: 'run-one-step-followup',
        group: 'run-one-step',
        stage: 'follow-up',
        version: repairVer,
        sessionPolicy: 'new',
        oneOff: true,
        label: `Run follow-up v${repairVer} only — then re-prompt`,
        recommended: false,
      });
    } else {
      actions.push({
        id: 'continue',
        group: 'continue',
        stage: 'audit',
        version: nextVer,
        sessionPolicy: { followUp: 'resumed', audit: 'resumed' },
        label: `CONTINUE CHAIN — SAME SESSION_ID each run — next: audit v${nextVer} → follow-up v${nextVer}`,
        recommended: true,
      });
      actions.push({
        id: 'run-one-step-audit',
        group: 'run-one-step',
        stage: 'audit',
        version: nextVer,
        sessionPolicy: 'new',
        oneOff: true,
        label: `Run audit v${nextVer} only — then re-prompt`,
        recommended: false,
      });
      actions.push({
        id: 'run-one-step-followup',
        group: 'run-one-step',
        stage: 'follow-up',
        version: nextVer,
        sessionPolicy: 'new',
        oneOff: true,
        label: `Run follow-up v${nextVer} only — then re-prompt`,
        recommended: false,
      });
    }
  } else if (phase === 'approved') {
    const recommendedAtStartup = decisionPoint === 'startup';
    recommendedId = recommendedAtStartup ? 'start-new-new-session' : 'stop';

    actions.push({
      id: 'stop',
      group: 'continue',
      stage: 'stop',
      version: latestAuditVersion,
      sessionPolicy: 'new',
      label: 'Stop and await manual review',
      recommended: !recommendedAtStartup,
    });

    if (isPlanLoop) {
      actions.push({
        id: 'implement',
        group: 'continue',
        stage: 'implement',
        version: 1,
        sessionPolicy: 'new',
        label: 'Implement the approved plan',
        recommended: false,
      });
    }

    actions.push({
      id: 'start-new-new-session',
      group: 'start-new',
      stage: 'audit',
      version: nextVer,
      sessionPolicy: 'new',
      label: `START NEW CHAIN — NEW SESSION_ID each run — next: audit v${nextVer} (fresh) → follow-up v${nextVer} (fresh)`,
      recommended: recommendedAtStartup,
    });
    actions.push({
      id: 'start-new-same-session',
      group: 'start-new',
      stage: 'audit',
      version: nextVer,
      sessionPolicy: 'resumed',
      label: `START NEW CHAIN — SAME SESSION_ID each run — next: audit v${nextVer} (fresh, locks provider+model) → resume on reject`,
      recommended: false,
    });
    actions.push({
      id: 'continue',
      group: 'continue',
      stage: 'audit',
      version: nextVer,
      sessionPolicy: 'resumed',
      label: `CONTINUE CHAIN — resume the APPROVAL session — next: audit v${nextVer} in approval session`,
      recommended: false,
    });
    actions.push({
      id: 'run-one-step-audit',
      group: 'run-one-step',
      stage: 'audit',
      version: nextVer,
      sessionPolicy: 'new',
      oneOff: true,
      label: `Run audit v${nextVer} only — then re-prompt`,
      recommended: false,
    });
  } else if (phase === 'implement-done') {
    recommendedId = 'stop';

    actions.push({
      id: 'stop',
      group: 'continue',
      stage: 'stop',
      version: 1,
      sessionPolicy: 'new',
      label: 'Stop and await manual review',
      recommended: true,
    });
    actions.push({
      id: 'start-new-new-session',
      group: 'start-new',
      stage: 'audit',
      version: 1,
      sessionPolicy: 'new',
      label: 'START NEW CHAIN — NEW SESSION_ID each run — next: review v1 → review-follow-up v1',
      recommended: false,
    });
    actions.push({
      id: 'start-new-same-session',
      group: 'start-new',
      stage: 'audit',
      version: 1,
      sessionPolicy: 'resumed',
      label: 'START NEW CHAIN — SAME SESSION_ID each run — next: review v1 → review-follow-up v1',
      recommended: false,
    });
    actions.push({
      id: 'run-one-step-audit',
      group: 'run-one-step',
      stage: 'audit',
      version: 1,
      sessionPolicy: 'new',
      oneOff: true,
      label: 'Run review v1 only — then re-prompt',
      recommended: false,
    });
    actions.push({
      id: 'run-one-step-followup',
      group: 'run-one-step',
      stage: 'follow-up',
      version: 1,
      sessionPolicy: 'new',
      oneOff: true,
      label: 'Run review-follow-up v1 only — then re-prompt',
      recommended: false,
    });
  }

  return { actions, recommendedId };
}

export function findResumableSession(
  steps: Step[],
  kinds: StepKind[],
  agent: string,
  model: string,
  opts?: { stopAtApproved?: boolean }
): { sessionId: string; version: number; kind: StepKind; provider: string; model: string } | null {
  const stopAtApproved = opts?.stopAtApproved !== false;

  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]!;

    if (s.kind === 'audit' && s.verdict === 'APPROVED') {
      if (stopAtApproved) {
        return null;
      } else {
        if (kinds.includes(s.kind) && s.agent === agent && s.model === model && s.sessionId && s.sessionId !== 'none') {
          return {
            sessionId: s.sessionId,
            version: s.version,
            kind: s.kind,
            provider: s.agent,
            model: s.model,
          };
        }
        return null;
      }
    }

    if (kinds.includes(s.kind) && s.agent === agent && s.model === model && s.sessionId && s.sessionId !== 'none') {
      return {
        sessionId: s.sessionId,
        version: s.version,
        kind: s.kind,
        provider: s.agent,
        model: s.model,
      };
    }
  }

  return null;
}

export function deriveContinuity(agent: string): boolean {
  return ['codex', 'opencode', 'claude'].includes(agent);
}
