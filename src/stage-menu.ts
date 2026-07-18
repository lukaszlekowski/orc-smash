import type { Step, StepKind } from './state.js';

export type SessionPolicy = 'new' | 'resumed';

export type AuditContinuityPolicy =
  | { enabled: false }
  | { enabled: true; requestedBy: 'audit-continuity' | 'codex-audit-continuity' };

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
  pendingFollowUpVersion: number | null;
  decisionPoint: 'startup' | 'in-loop';
  loopName: string; // display-only
}

export function buildStageActions(input: LoopMenuState): { actions: StageAction[]; recommendedId: string } {
  const { phase, latestAuditVersion, pendingFollowUpVersion, decisionPoint, loopName } = input;
  const actions: StageAction[] = [];
  let recommendedId = '';

  const nextVer = latestAuditVersion + 1;
  const isPlanLoop = loopName === 'plan';
  const auditTerm = isPlanLoop ? 'audit' : 'review';
  const followUpTerm = isPlanLoop ? 'follow-up' : 'review-follow-up';

  if (phase === 'fresh') {
    recommendedId = 'start-new-new-session';
    actions.push({
      id: 'start-new-new-session',
      group: 'start-new',
      stage: 'audit',
      version: 1,
      sessionPolicy: 'new',
      label: `START NEW CHAIN — NEW SESSION_ID each following run — next: ${auditTerm} v1 → ${followUpTerm} v1`,
      recommended: true,
    });
    actions.push({
      id: 'start-new-same-session',
      group: 'start-new',
      stage: 'audit',
      version: 1,
      sessionPolicy: 'resumed',
      label: `START NEW CHAIN — SAME SESSION_ID each following run — next: ${auditTerm} v1 → ${followUpTerm} v1`,
      recommended: false,
    });
    actions.push({
      id: 'run-one-step-audit',
      group: 'run-one-step',
      stage: 'audit',
      version: 1,
      sessionPolicy: 'new',
      oneOff: true,
      label: `Run ${auditTerm} v1 only — then re-prompt`,
      recommended: false,
    });
  } else if (phase === 'rejected-no-followup' || phase === 'rejected-followup-done') {
    recommendedId = 'continue';

    actions.push({
      id: 'start-new-new-session',
      group: 'start-new',
      stage: 'audit',
      version: nextVer,
      sessionPolicy: 'new',
      label: `START NEW CHAIN — NEW SESSION_ID each run — next: ${auditTerm} v${nextVer} → ${followUpTerm} v${nextVer}`,
      recommended: false,
    });
    actions.push({
      id: 'start-new-same-session',
      group: 'start-new',
      stage: 'audit',
      version: nextVer,
      sessionPolicy: 'resumed',
      label: `START NEW CHAIN — SAME SESSION_ID each run — next: ${auditTerm} v${nextVer} → ${followUpTerm} v${nextVer}`,
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
        label: `CONTINUE CHAIN — SAME SESSION_ID each run — next: ${followUpTerm} v${repairVer} → ${auditTerm} v${repairVer + 1}`,
        recommended: true,
      });
      actions.push({
        id: 'run-one-step-audit',
        group: 'run-one-step',
        stage: 'audit',
        version: nextVer,
        sessionPolicy: 'new',
        oneOff: true,
        label: `Run ${auditTerm} v${nextVer} only — then re-prompt`,
        recommended: false,
      });
      actions.push({
        id: 'run-one-step-followup',
        group: 'run-one-step',
        stage: 'follow-up',
        version: repairVer,
        sessionPolicy: 'new',
        oneOff: true,
        label: `Run ${followUpTerm} v${repairVer} only — then re-prompt`,
        recommended: false,
      });
    } else {
      actions.push({
        id: 'continue',
        group: 'continue',
        stage: 'audit',
        version: nextVer,
        sessionPolicy: { followUp: 'resumed', audit: 'resumed' },
        label: `CONTINUE CHAIN — SAME SESSION_ID each run — next: ${auditTerm} v${nextVer} → ${followUpTerm} v${nextVer}`,
        recommended: true,
      });
      actions.push({
        id: 'run-one-step-audit',
        group: 'run-one-step',
        stage: 'audit',
        version: nextVer,
        sessionPolicy: 'new',
        oneOff: true,
        label: `Run ${auditTerm} v${nextVer} only — then re-prompt`,
        recommended: false,
      });
      actions.push({
        id: 'run-one-step-followup',
        group: 'run-one-step',
        stage: 'follow-up',
        version: nextVer,
        sessionPolicy: 'new',
        oneOff: true,
        label: `Run ${followUpTerm} v${nextVer} only — then re-prompt`,
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
      label: `START NEW CHAIN — NEW SESSION_ID each run — next: ${auditTerm} v${nextVer} (fresh) → ${followUpTerm} v${nextVer} (fresh)`,
      recommended: recommendedAtStartup,
    });
    actions.push({
      id: 'start-new-same-session',
      group: 'start-new',
      stage: 'audit',
      version: nextVer,
      sessionPolicy: 'resumed',
      label: `START NEW CHAIN — SAME SESSION_ID each run — next: ${auditTerm} v${nextVer} (fresh, locks provider+model) → resume on reject`,
      recommended: false,
    });
    if (isPlanLoop) {
      actions.push({
        id: 'continue',
        group: 'continue',
        stage: 'audit',
        version: nextVer,
        sessionPolicy: { followUp: 'resumed', audit: 'resumed' },
        label: `CONTINUE CHAIN — resume the APPROVAL session — next: ${auditTerm} v${nextVer} → ${followUpTerm} v${nextVer}`,
        recommended: false,
      });
    }
    actions.push({
      id: 'run-one-step-audit',
      group: 'run-one-step',
      stage: 'audit',
      version: nextVer,
      sessionPolicy: 'new',
      oneOff: true,
      label: `Run ${auditTerm} v${nextVer} only — then re-prompt`,
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
        if (s.agent === agent && s.model === model) {
          if (kinds.includes(s.kind) && s.sessionId && s.sessionId !== 'none') {
            return {
              sessionId: s.sessionId,
              version: s.version,
              kind: s.kind,
              provider: s.agent,
              model: s.model,
            };
          }
          // Same agent/model approved session found, but not of the kind we want (e.g. we want follow-up).
          // Continue walking backward to find the matching follow-up step in this same session.
        } else {
          // Approval session belongs to a different agent/model, so we cannot resume.
          return null;
        }
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

export type ResumableSessionStatus =
  | 'found'
  | 'no_steps_of_kind'
  | 'agent_model_mismatch'
  | 'blocked_by_approved_boundary'
  | 'session_id_none';

export type ResumableSessionDetail = {
  status: ResumableSessionStatus;
  session?: { sessionId: string; version: number; kind: StepKind; provider: string; model: string };
};

export function findResumableSessionDetail(
  steps: Step[],
  kinds: StepKind[],
  agent: string,
  model: string,
  opts?: { stopAtApproved?: boolean }
): ResumableSessionDetail {
  const walk = findResumableSession(steps, kinds, agent, model, opts);
  if (walk) {
    return { status: 'found', session: walk };
  }

  const hasKind = steps.some(s => kinds.includes(s.kind));
  if (!hasKind) {
    return { status: 'no_steps_of_kind' };
  }

  const hasAgentModel = steps.some(s => kinds.includes(s.kind) && s.agent === agent && s.model === model);
  if (!hasAgentModel) {
    return { status: 'agent_model_mismatch' };
  }

  const stopAtApproved = opts?.stopAtApproved !== false;
  if (stopAtApproved) {
    const walkWithoutStop = findResumableSession(steps, kinds, agent, model, { stopAtApproved: false });
    if (walkWithoutStop) {
      return { status: 'blocked_by_approved_boundary' };
    }
  }

  return { status: 'session_id_none' };
}

export function deriveContinuity(agent: string): boolean {
  return ['codex', 'opencode', 'claude'].includes(agent);
}

export function applyAuditContinuityPolicy(
  actions: StageAction[],
  state: { phase: MenuPhase; armed: boolean; lastVerdict: string | null },
  policy: AuditContinuityPolicy
): StageAction[] {
  if (policy.enabled) {
    return actions.map(a => {
      if (a.id === 'start-new-same-session') {
        return { ...a, disabledReason: 'disabled by --audit-continuity: seed audit is always fresh' };
      }
      if (a.group === 'continue' && typeof a.sessionPolicy === 'object') {
        return {
          ...a,
          sessionPolicy: {
            followUp: state.armed && state.lastVerdict === 'REJECTED' ? 'resumed' as const : 'new' as const,
            audit: state.armed && state.lastVerdict === 'REJECTED' ? 'resumed' as const : 'new' as const
          }
        };
      }
      if (a.group === 'continue' && a.sessionPolicy === 'resumed') {
        return { ...a, sessionPolicy: state.armed && state.lastVerdict === 'REJECTED' ? 'resumed' as SessionPolicy : 'new' as SessionPolicy };
      }
      return a;
    }).filter(a => a.id !== 'start-new-same-session');
  }

  return actions.map(a => {
    if (typeof a.sessionPolicy === 'object') {
      return {
        ...a,
        sessionPolicy: {
          followUp: 'new' as const,
          audit: 'new' as const
        }
      };
    }
    if (a.sessionPolicy === 'resumed') {
      return { ...a, sessionPolicy: 'new' as SessionPolicy };
    }
    return a;
  }).filter(a => a.id !== 'start-new-same-session');
}
