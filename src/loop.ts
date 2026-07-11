import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import chalk from 'chalk';
import { scan, scanImplementAsSteps, type Step, resolveImplementFacts, requireApprovedPlanAuditPath } from './state.js';
import { parseFollowUpOutcome, type FollowUpOutcome } from './follow-up-outcome.js';
import type { AgentRegistry } from './adapters/registry.js';
import type { RunResult } from './adapters/types.js';
import { renderPattern } from './patterns.js';
import { composePrompt } from './prompt-composer.js';
import { writeArtifactWithMeta, type ArtifactMeta, type StepKind } from './provenance.js';
import { parseVerdict } from './verdict.js';
import { buildPanelContext, latestAuditVersion, type PanelContext, type ResolvedRunnerDisplay, resolveLoopLabels } from './status.js';
import { promptRunners, promptStageAction } from './interactive.js';
import { structuredMessage } from './adapters/errors.js';
import type { Config } from './config.js';
import type { LoopSpec, SkillSpec } from './manifest.js';
import type { CliOutput } from './cli-output.js';
import { resolveRunner } from './runner.js';
import { findHighestRawImplementLedger, isCompleteImplementLedger } from './implement-ledger.js';
import { deriveCloseoutSignal, writePlanCloseout } from './plan-closeout.js';
import { initializePlanMetadata } from './plan-metadata.js';
import { quarantineArtifact, quarantineInterruptedResume } from './interrupted-artifact.js';
import { resolveNextStep } from './next-step.js';
import { buildStageActions, findResumableSession, findResumableSessionDetail, deriveContinuity, type MenuPhase, type StageAction, type SessionPolicy, type LoopMenuState } from './stage-menu.js';
import { executeLoopStep } from './loops/execution.js';
import type { LoopReturn, Runner } from './loops/runtime.js';
import { resolveRecordedRunner } from './loops/runner-selection.js';
import { missingRequiredArtifact } from './required-artifact.js';

export interface LoopOptions {
  maxIterations: number;
  globalOverrides?: { agent?: string; model?: string };
  interactive?: boolean;
  registry: AgentRegistry;
  output: CliOutput;
  seedResolved?: Set<string>;
}


export async function runLoop(
  projectRoot: string,
  loopName: string,
  loopSpec: LoopSpec,
  config: Config,
  runners: Record<string, Runner>,
  options: LoopOptions
): Promise<LoopReturn> {
  const labels = resolveLoopLabels(loopSpec, config.manifest);

  // §3: defensive quarantine at loop start. Quarantine any in-flight/late
  // artifact left by a prior interrupted run (marker-based) before state
  // resolution. No-op when no marker exists. Composite helper also covers the
  // recursive plan→implement→review transitions (marker cleared after first run).
  quarantineInterruptedResume(projectRoot, config.manifest.loops);

  const steps: Step[] = [];
  const upfrontResolved = new Set<string>();
  const upfrontPolicies = new Map<string, SessionPolicy>();
  const runnerResolution = new Map<string, ResolvedRunnerDisplay>();
  let projectSummaryDetails: string[] = [];
  let isFirstAction = true;
  let lastActionGroup: string | null = null;

  if (options.seedResolved) {
    for (const s of options.seedResolved) {
      upfrontResolved.add(s);
    }
  }

  const priorAuditRel = (root: string, p: string | null | undefined): string =>
    p ? (p.startsWith(root) ? relative(root, p) : p) : 'none';

  const renderPanel = (
    active: { skillId: string; agent: string; model: string } | null,
    currentIteration: number,
    message: string,
    inFlight: PanelContext['inFlight'] = null
  ) => {
    const resolvedRunners = [loopSpec.audit, loopSpec['follow-up']]
      .filter((skillId): skillId is string => !!skillId)
      .flatMap((skillId) => {
        const runner = runners[skillId];
        if (!runner) return [];
        return [runnerResolution.get(skillId) ?? {
          skillId,
          agent: runner.agent,
          model: runner.model,
          source: 'configured' as const
        }];
      });
    options.output.renderPanel(
      buildPanelContext(
        projectRoot,
        loopName,
        currentIteration,
        options.maxIterations,
        active,
        steps,
        message,
        inFlight,
        latestAuditVersion(steps),
        false,
        resolvedRunners
      )
    );
  };

  const emitFinalSummary = (
    success: boolean,
    verdict: 'APPROVED' | 'REJECTED' | 'unknown' | null,
    message: string,
    lastPath: string | null
  ): LoopReturn => {
    const runnerDetails = [loopSpec.audit, loopSpec['follow-up']]
      .filter((skillId): skillId is string => !!skillId)
      .flatMap((skillId) => {
        const runner = runners[skillId];
        if (!runner) return [];
        const resolution = runnerResolution.get(skillId);
        const source = resolution?.source === 'inherited' && resolution.inheritedFrom
          ? `inherited from ${resolution.inheritedFrom.kind} v${resolution.inheritedFrom.version}, session ${resolution.inheritedFrom.sessionId}`
          : resolution?.source === 'selected'
            ? 'selected this chain'
            : 'configured for this run';
        return [`runner (${skillId}): ${runner.agent} (${runner.model}) — ${source}`];
      });
    options.output.finalSummary({ success, verdict, message, lastAuditPath: lastPath, details: [...buildProjectSummaryDetails(), ...runnerDetails] });
    return { success, verdict: verdict ?? 'unknown', message, lastAuditPath: lastPath };
  };

  function buildProjectSummaryDetails(): string[] {
    const details: string[] = [];
    const planDocPath = resolve(projectRoot, 'docs/dev/plan.md');
    details.push(existsSync(planDocPath) ? 'plan document: docs/dev/plan.md' : 'plan document: not found');

    const planSpec = config.manifest.loops['plan'];
    if (planSpec?.auditPattern && planSpec.followUpPattern) {
      const planScan = scan(projectRoot, { auditPattern: planSpec.auditPattern, followUpPattern: planSpec.followUpPattern });
      const latestPlanAudit = planScan.auditSteps.at(-1);
      const latestPlanFollowUp = planScan.timeline.filter(s => s.kind === 'follow-up').at(-1);
      details.push(latestPlanAudit
        ? `most recent plan audit: ${relative(projectRoot, latestPlanAudit.artifactPath)}, decision: ${latestPlanAudit.verdict}, model: ${latestPlanAudit.agent} (${latestPlanAudit.model}), sessionId: ${latestPlanAudit.sessionId ?? 'none'}`
        : 'most recent plan audit: none');
      details.push(latestPlanFollowUp
        ? `most recent plan follow-up: ${relative(projectRoot, latestPlanFollowUp.artifactPath)}, model: ${latestPlanFollowUp.agent} (${latestPlanFollowUp.model}), sessionId: ${latestPlanFollowUp.sessionId ?? 'none'}`
        : 'most recent plan follow-up: none');
    }

    const implementSpec = config.manifest.loops['implement'];
    if (implementSpec?.implementPattern) {
      const implementRole = implementSpec.implement && config.manifest.skills[implementSpec.implement]?.role || 'implementer';
      const latestImplementation = scanImplementAsSteps(projectRoot, implementSpec.implementPattern, implementRole).at(-1);
      details.push(latestImplementation
        ? `most recent implementation: ${relative(projectRoot, latestImplementation.artifactPath)}, model: ${latestImplementation.agent} (${latestImplementation.model})`
        : 'most recent implementation: none');
    }

    const reviewSpec = config.manifest.loops['review'];
    if (reviewSpec?.auditPattern && reviewSpec.followUpPattern) {
      const reviewScan = scan(projectRoot, { auditPattern: reviewSpec.auditPattern, followUpPattern: reviewSpec.followUpPattern });
      const latestReview = reviewScan.auditSteps.at(-1);
      const latestReviewFollowUp = reviewScan.timeline.filter(s => s.kind === 'follow-up').at(-1);
      details.push(latestReview
        ? `most recent review: ${relative(projectRoot, latestReview.artifactPath)}, decision: ${latestReview.verdict}, model: ${latestReview.agent} (${latestReview.model}), sessionId: ${latestReview.sessionId ?? 'none'}`
        : 'most recent review: none');
      details.push(latestReviewFollowUp
        ? `most recent review follow-up: ${relative(projectRoot, latestReviewFollowUp.artifactPath)}, model: ${latestReviewFollowUp.agent} (${latestReviewFollowUp.model}), sessionId: ${latestReviewFollowUp.sessionId ?? 'none'}`
        : 'most recent review follow-up: none');
    }
    return details;
  }

  const runAdapter = async (
    runner: Runner,
    prompt: string,
    spawnLabel: string,
    kind: StepKind,
    skillId: string,
    version: number,
    currentIteration: number,
    continuity?: { mode: 'fresh' | 'resumed'; sessionId?: string }
  ) => executeLoopStep({
    projectRoot,
    loopName,
    loopSpec,
    config,
    registry: options.registry,
    output: options.output,
    steps,
    maxIterations: options.maxIterations
  }, { runner, prompt, spawnLabel, kind, skillId, version, iteration: currentIteration, continuity });

  const stepFailed = (result: RunResult, acceptNonzeroExitWithVerdict: boolean): boolean =>
    Boolean(result.error) || (!acceptNonzeroExitWithVerdict && result.exitCode !== 0);

  const quarantineAuthArtifact = (pattern: string | undefined, version: number, agent: string): void => {
    if (!pattern) return;
    const rel = renderPattern(pattern, { n: version, agent });
    const abs = resolve(projectRoot, rel);
    quarantineArtifact(projectRoot, abs, { reason: 'auth' });
  };

  const isNonCleanCompletion = (result: RunResult): boolean =>
    result.completion === 'truncated' || result.completion === 'interrupted' || result.completion === 'missing';
  const completionMessage = (result: RunResult): string =>
    result.completion === 'missing'
      ? 'Agent exited without the verified OpenCode completion signal; treating the result as unknown. Run again with --debug-spawn and capture the terminal stream event.'
      : `Agent execution truncated or interrupted. Stop reason: ${result.stopReason}`;

  const chooseAction = async (decisionPoint: 'startup' | 'in-loop', overridePhase?: MenuPhase, opts?: { autoRecommend?: boolean }): Promise<{ action: StageAction; phase: MenuPhase }> => {
    const stateScan = scan(projectRoot, { auditPattern: loopSpec.auditPattern || '', followUpPattern: loopSpec.followUpPattern || '' });

    let phase: MenuPhase = 'fresh';
    let latestAuditVersionVal = 0;
    let pendingFollowUpVersionVal: number | null = null;

    if (overridePhase) {
      phase = overridePhase;
      latestAuditVersionVal = latestAuditVersion(steps) || 1;
    } else if (loopSpec.kind === 'implement') {
      const planSpecForImpl = config.manifest.loops['plan']!;
      const implFacts = resolveImplementFacts(projectRoot, {
        auditPattern: planSpecForImpl.auditPattern ?? '',
        followUpPattern: planSpecForImpl.followUpPattern ?? ''
      }, {
        implementPattern: loopSpec.implementPattern ?? ''
      });

      if (implFacts.currentPlanImplemented) {
        phase = 'implement-done';
      } else {
        return {
          action: {
            id: 'implement',
            group: 'continue',
            stage: 'implement',
            version: implFacts.nextVersion,
            sessionPolicy: 'new',
            label: 'Implement the approved plan',
            recommended: true
          },
          phase: 'fresh'
        };
      }
    } else {
      const decision = resolveNextStep({
        latestVerdict: stateScan.latestVerdict,
        latestVersion: stateScan.latestVersion,
        hasAudits: stateScan.auditSteps.length > 0,
        latestAuditPath: stateScan.auditSteps[stateScan.auditSteps.length - 1]?.artifactPath ?? null
      });

      latestAuditVersionVal = stateScan.latestVersion;

      if (decision.state === 'fresh') {
        phase = 'fresh';
      } else if (decision.state === 'approved') {
        phase = 'approved';
      } else if (decision.state === 'rejected') {
        const latestVersion = stateScan.latestVersion;
        const followUpForLatest = stateScan.timeline.find(s => s.kind === 'follow-up' && s.version === latestVersion);
        const followUpCompleted = followUpForLatest && followUpForLatest.status === 'done' && followUpForLatest.outcome;

        if (pendingFollowUp || !followUpCompleted) {
          phase = 'rejected-no-followup';
          pendingFollowUpVersionVal = latestVersion;
        } else {
          phase = 'rejected-followup-done';
        }
      } else {
        throw new Error(`latest audit is unparseable; resolve or delete it before smashing`);
      }
    }

    const menuState: LoopMenuState = {
      phase,
      latestAuditVersion: latestAuditVersionVal,
      pendingFollowUpVersion: pendingFollowUpVersionVal,
      decisionPoint,
      loopName
    };

    const { actions, recommendedId } = buildStageActions(menuState);

    let targetLoopSpec = loopSpec;
    if (phase === 'implement-done') {
      const reviewSpec = config.manifest.loops['review'];
      if (reviewSpec) {
        targetLoopSpec = reviewSpec;
      }
    }

    // Resolve sessions and check agent support for continuity
    for (const act of actions) {
      if (
        act.id === 'continue' ||
        act.sessionPolicy === 'resumed' ||
        (typeof act.sessionPolicy === 'object' &&
          (act.sessionPolicy.audit === 'resumed' || act.sessionPolicy.followUp === 'resumed'))
      ) {
        const skillId = act.stage === 'follow-up' ? targetLoopSpec['follow-up']! : targetLoopSpec.audit!;
        let runner = runners[skillId] || resolveRunner(skillId, config, options.globalOverrides);

        const kindsToFind: StepKind[] = act.stage === 'follow-up' ? ['follow-up'] : ['audit'];
        const stopAtApproved = act.id !== 'continue' || phase !== 'approved';

        const allowAnyAgent = options.interactive && !options.globalOverrides?.agent;

        if (allowAnyAgent) {
          let lastSessionStep: Step | null = null;
          for (let i = steps.length - 1; i >= 0; i--) {
            const s = steps[i]!;
            if (s.kind === 'audit' && s.verdict === 'APPROVED' && stopAtApproved) {
              break;
            }
            if (kindsToFind.includes(s.kind) && s.sessionId && s.sessionId !== 'none') {
              lastSessionStep = s;
              break;
            }
          }

          if (lastSessionStep) {
            const provider = lastSessionStep.agent;
            const model = lastSessionStep.model;
            if (!config.registry.providers[provider]) {
              act.disabledReason = `inherited provider ${provider} is not configured`;
              continue;
            }
            const recordedRunner = resolveRecordedRunner(config.registry, provider, model);
            if (!recordedRunner) {
              act.disabledReason = `inherited model ${model} is not configured`;
              continue;
            }
            runner = recordedRunner;
          }
        }

        if (!deriveContinuity(runner.agent)) {
          act.disabledReason = `agent ${runner.agent} does not support session resume`;
          continue;
        }

        const walkSession = findResumableSession(steps, kindsToFind, runner.agent, runner.model, { stopAtApproved });

        if (walkSession) {
          act.sessionId = walkSession.sessionId;
          act.provider = walkSession.provider;
          act.model = walkSession.model;
        }
      }
    }

    if (options.interactive && !opts?.autoRecommend) {
      const chosenId = await promptStageAction(actions, recommendedId);
      const chosen = actions.find(a => a.id === chosenId);
      if (!chosen) {
        throw new Error(`Chosen action ID ${chosenId} not found`);
      }
      return { action: chosen, phase };
    } else {
      const recommended = actions.find(a => a.id === recommendedId);
      if (!recommended) throw new Error(`Recommended action ID ${recommendedId} not found`);
      return { action: recommended, phase };
    }
  };

  const resolveUpfrontRunners = async (
    chosenAction: StageAction,
    phase: MenuPhase,
    loopSpec: LoopSpec
  ): Promise<void> => {
    const isNewSegment = lastActionGroup === null || lastActionGroup === 'run-one-step';

    if (chosenAction.group === 'start-new' || chosenAction.group === 'run-one-step') {
      upfrontResolved.clear();
      upfrontPolicies.clear();
      if (isFirstAction && options.seedResolved) {
        for (const s of options.seedResolved) {
          upfrontResolved.add(s);
        }
      }
    }

    let targetLoopSpec = loopSpec;
    if (phase === 'implement-done') {
      const reviewSpec = config.manifest.loops['review'];
      if (!reviewSpec) {
        throw new Error("Loop 'review' not found in manifest");
      }
      targetLoopSpec = reviewSpec;
    }

    const auditSkillId = targetLoopSpec.audit;
    const followUpSkillId = targetLoopSpec['follow-up'];

    let skillsToResolve: string[] = [];

    if (chosenAction.id === 'stop' || chosenAction.id === 'implement') {
      skillsToResolve = [];
    } else if (chosenAction.group === 'run-one-step') {
      const skillId = chosenAction.stage === 'follow-up' ? followUpSkillId : auditSkillId;
      if (skillId) {
        skillsToResolve = [skillId];
      }
    } else if (chosenAction.group === 'start-new') {
      skillsToResolve = [auditSkillId, followUpSkillId].filter((s): s is string => !!s);
    } else if (chosenAction.group === 'continue') {
      if (phase === 'rejected-no-followup') {
        skillsToResolve = [followUpSkillId, auditSkillId].filter((s): s is string => !!s);
      } else if (phase === 'rejected-followup-done') {
        skillsToResolve = [auditSkillId, followUpSkillId].filter((s): s is string => !!s);
      } else if (phase === 'approved') {
        skillsToResolve = [auditSkillId, followUpSkillId].filter((s): s is string => !!s);
      } else {
        const firstSkill = chosenAction.stage === 'follow-up' ? followUpSkillId : auditSkillId;
        const secondSkill = chosenAction.stage === 'follow-up' ? auditSkillId : followUpSkillId;
        skillsToResolve = [firstSkill, secondSkill].filter((s): s is string => !!s);
      }
    }

    const getPolicyForSkill = (skillId: string): SessionPolicy => {
      const isFollowUp = skillId === followUpSkillId;
      const policy = chosenAction.sessionPolicy;
      if (typeof policy === 'object') {
        return isFollowUp ? policy.followUp : policy.audit;
      }
      return policy;
    };

    const targetLabels = targetLoopSpec === loopSpec ? labels : resolveLoopLabels(targetLoopSpec, config.manifest);
    const skillsToPrompt: string[] = [];

    for (const skillId of skillsToResolve) {
      const policy = getPolicyForSkill(skillId);
      if (isNewSegment || !upfrontPolicies.has(skillId)) {
        upfrontPolicies.set(skillId, policy);
      }

      if (upfrontResolved.has(skillId)) {
        continue;
      }
      const kind: StepKind = skillId === followUpSkillId ? 'follow-up' : 'audit';
      let inherited = false;

      if (policy === 'resumed') {
        let runner = runners[skillId] || resolveRunner(skillId, config, options.globalOverrides);
        const stopAtApproved = chosenAction.id !== 'continue' || phase !== 'approved';

        const allowAnyAgent = options.interactive && !options.globalOverrides?.agent;
        if (allowAnyAgent) {
          let lastSessionStep: Step | null = null;
          for (let i = steps.length - 1; i >= 0; i--) {
            const s = steps[i]!;
            if (s.kind === 'audit' && s.verdict === 'APPROVED' && stopAtApproved) {
              break;
            }
            if (s.kind === kind && s.sessionId && s.sessionId !== 'none') {
              lastSessionStep = s;
              break;
            }
          }

          if (lastSessionStep) {
            const provider = lastSessionStep.agent;
            const model = lastSessionStep.model;
            const recordedRunner = resolveRecordedRunner(config.registry, provider, model);
            if (recordedRunner) runner = recordedRunner;
          }
        }

        if (deriveContinuity(runner.agent)) {
          const walkSession = findResumableSession(steps, [kind], runner.agent, runner.model, { stopAtApproved });
          if (walkSession) {
            runners[skillId] = { agent: walkSession.provider, model: walkSession.model };
            runnerResolution.set(skillId, {
              skillId,
              agent: walkSession.provider,
              model: walkSession.model,
              source: 'inherited',
              inheritedFrom: { kind: walkSession.kind, version: walkSession.version, sessionId: walkSession.sessionId }
            });
            const labelKey = kind === 'follow-up' ? 'followUp' : 'audit';
            options.output.note(`Inherited runner for ${targetLabels[labelKey]?.skillId ?? skillId}: ${walkSession.provider} (${walkSession.model}) session ${walkSession.sessionId}`);
            upfrontResolved.add(skillId);
            inherited = true;
          }
        }
      }

      if (!inherited) {
        skillsToPrompt.push(skillId);
      }
    }

    if (skillsToPrompt.length > 0) {
      const prompted = await promptRunners(
        skillsToPrompt,
        config,
        options.registry,
        options.globalOverrides,
        { forceSelect: chosenAction.group === 'continue' }
      );
      for (const skillId of skillsToPrompt) {
        if (prompted[skillId]) {
          runners[skillId] = prompted[skillId];
          runnerResolution.set(skillId, {
            skillId,
            agent: prompted[skillId].agent,
            model: prompted[skillId].model,
            source: 'selected'
          });
          upfrontResolved.add(skillId);
        }
      }
    }
    lastActionGroup = chosenAction.group;
  };

  const preparePrompt = (skillId: string, skill: SkillSpec, version: number, runner: Runner, kind: StepKind): string => {
    const roleFile = config.manifest.roles[skill.role];
    if (!roleFile) {
      throw new Error(`Role file '${skill.role}' not found in roles list`);
    }
    return composePrompt(skillId, roleFile, skill.file, loopSpec, {
      targetRoot: projectRoot,
      version,
      priorAuditPath: latestAuditStep()?.artifactPath ?? null,
      agentName: runner.agent,
      kind
    });
  };

  const buildStepMeta = (
    skillId: string,
    skill: SkillSpec,
    kind: StepKind,
    version: number,
    runner: Runner,
    durationMs: number,
    sessionMode?: 'fresh' | 'resumed' | 'none',
    sessionId?: string | 'none'
  ): ArtifactMeta => ({
    loop: loopName,
    skill: skillId,
    kind,
    role: skill.role,
    version,
    agent: runner.agent,
    model: runner.model,
    target: loopSpec.target,
    priorAudit: priorAuditRel(projectRoot, latestAuditStep()?.artifactPath),
    timestamp: new Date().toISOString(),
    durationMs,
    sessionMode: sessionMode ?? 'none',
    sessionId: sessionId ?? 'none'
  });

  if (loopSpec.kind === 'implement') {
    const planSpec = config.manifest.loops['plan'];
    if (!planSpec) {
      throw new Error("Loop 'plan' not found in manifest");
    }
    const approvedPlanAuditPath = requireApprovedPlanAuditPath(projectRoot, {
      auditPattern: planSpec.auditPattern ?? '',
      followUpPattern: planSpec.followUpPattern ?? ''
    });

    const implementSkillId = loopSpec.implement;
    if (!implementSkillId) {
      throw new Error(`Loop '${loopName}' of kind 'implement' is missing implement skill`);
    }
    const skill = config.manifest.skills[implementSkillId];
    if (!skill || skill.kind !== 'implement') {
      throw new Error(`Implement skill '${implementSkillId}' not found or has invalid kind`);
    }

    const { nextVersion } = resolveImplementFacts(
      projectRoot,
      {
        auditPattern: planSpec.auditPattern ?? '',
        followUpPattern: planSpec.followUpPattern ?? ''
      },
      {
        implementPattern: loopSpec.implementPattern ?? ''
      }
    );

    const planHistory = scan(projectRoot, {
      auditPattern: planSpec.auditPattern ?? '',
      followUpPattern: planSpec.followUpPattern ?? ''
    });
    steps.push(...planHistory.timeline);

    const projectPlanPath = resolve(projectRoot, 'docs/dev/plan.md');
    const metadataPreflight = initializePlanMetadata(projectPlanPath);
    if (!metadataPreflight.ok) {
      const message = `Implementation preflight failed: ${metadataPreflight.error}`;
      options.output.stepFailed({
        kind: 'implement', skillId: implementSkillId, version: nextVersion,
        message, errorKind: 'plan_metadata_invalid'
      });
      return emitFinalSummary(false, 'unknown', message, null);
    }

    const rawLedger = findHighestRawImplementLedger(projectRoot, loopSpec.implementPattern ?? '');
    if (rawLedger) {
      const approvedRel = priorAuditRel(projectRoot, approvedPlanAuditPath);
      if (!options.interactive) {
        const message = `Found valid raw implementation ledger v${rawLedger.version}-${rawLedger.agent} at ${relative(projectRoot, rawLedger.artifactPath)}. Rerun interactively to recover it against approved audit ${approvedRel}; no provider was started.`;
        options.output.stepFailed({
          kind: 'implement', skillId: implementSkillId, version: rawLedger.version,
          message, errorKind: 'raw_ledger_recovery_required'
        });
        return emitFinalSummary(false, 'unknown', message, null);
      }
      const recoverId = await promptStageAction([
        {
          id: 'recover-implementation', group: 'continue', stage: 'implement',
          version: rawLedger.version, sessionPolicy: 'new', recommended: true,
          label: `Recover implementation v${rawLedger.version}-${rawLedger.agent} — link to approved audit ${approvedRel}`
        },
        {
          id: 'stop', group: 'continue', stage: 'stop', version: rawLedger.version,
          sessionPolicy: 'new', recommended: false, label: 'Stop and await manual review'
        }
      ], 'recover-implementation');
      if (recoverId !== 'recover-implementation') {
        return emitFinalSummary(true, null, 'Raw implementation ledger left unchanged for manual review.', rawLedger.artifactPath);
      }

      const signal = deriveCloseoutSignal(rawLedger.content);
      const closeout = writePlanCloseout({
        planPath: projectPlanPath, version: rawLedger.version, agent: rawLedger.agent, signal
      });
      if (!closeout.ok) {
        const message = `Plan closeout failed while recovering v${rawLedger.version}-${rawLedger.agent}: ${closeout.error}`;
        options.output.stepFailed({ kind: 'implement', skillId: implementSkillId, version: rawLedger.version, message, errorKind: 'closeout_failed' });
        return emitFinalSummary(false, 'unknown', message, null);
      }
      if (closeout.status === 'blocked') {
        const message = `Implementation recovery blocked: ${signal.reason ?? 'confidence below 0.95 threshold'}`;
        options.output.stepFailed({ kind: 'implement', skillId: implementSkillId, version: rawLedger.version, message, errorKind: 'implementation_blocked' });
        return emitFinalSummary(false, 'unknown', message, null);
      }
      const recoveredModel = config.registry.providers[rawLedger.agent]?.defaultModel ?? 'unknown';
      writeArtifactWithMeta(rawLedger.artifactPath, rawLedger.content, {
        loop: loopName, skill: implementSkillId, kind: 'implement', role: skill.role,
        version: rawLedger.version, agent: rawLedger.agent, model: recoveredModel,
        target: loopSpec.target, priorAudit: approvedRel, timestamp: new Date().toISOString(), durationMs: 0
      });
      options.output.stepSucceeded({
        kind: 'implement', skillId: implementSkillId, version: rawLedger.version,
        message: `Recovered implementation v${rawLedger.version}-${rawLedger.agent}; plan closeout wrote status: done`
      });
      return emitFinalSummary(true, null, `Recovered implementation successfully: ${relative(projectRoot, rawLedger.artifactPath)}`, rawLedger.artifactPath);
    }

    let runner = runners[implementSkillId];
    if (!runner && options.interactive) {
      const prompted = await promptRunners([implementSkillId], config, options.registry, options.globalOverrides, { forceSelect: true });
      runner = prompted[implementSkillId];
    }
    if (!runner) {
      runner = resolveRunner(implementSkillId, config, options.globalOverrides);
    }

    renderPanel(
      { skillId: implementSkillId, agent: runner.agent, model: runner.model },
      1,
      `Running ${labels.implement?.skillId ?? implementSkillId} v${nextVersion}...`
    );

    const roleFile = config.manifest.roles[skill.role];
    if (!roleFile) {
      throw new Error(`Role file '${skill.role}' not found in roles list`);
    }
    const prompt = composePrompt(implementSkillId, roleFile, skill.file, loopSpec, {
      targetRoot: projectRoot,
      version: nextVersion,
      priorAuditPath: approvedPlanAuditPath,
      agentName: runner.agent,
      kind: 'implement'
    });

    let runResult: { result: RunResult; durationMs: number };
    try {
      runResult = await runAdapter(
        runner,
        prompt,
        `Spawning ${runner.agent} for implementation...`,
        'implement',
        implementSkillId,
        nextVersion,
        1
      );
    } catch (err: any) {
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation failed: ${err.message}`
      });
      return emitFinalSummary(false, 'unknown', err.message, null);
    }

    const { result, durationMs } = runResult;

    if (stepFailed(result, false)) {
      if (result.error?.kind === 'auth') {
        quarantineAuthArtifact(loopSpec.implementPattern, nextVersion, runner.agent);
      }
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation ${result.error?.kind ?? 'failed'}`,
        errorKind: result.error?.kind
      });
      const errMessage = structuredMessage(result, { label: 'Implement', model: runner.model, agent: runner.agent });
      return emitFinalSummary(false, 'unknown', errMessage, null);
    }
    if (isNonCleanCompletion(result)) {
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation truncated or interrupted`,
        errorKind: result.completion
      });
      return emitFinalSummary(false, 'unknown', completionMessage(result), null);
    }

    const relOutputPath = renderPattern(loopSpec.implementPattern!, { n: nextVersion, agent: runner.agent });
    const absOutputPath = resolve(projectRoot, relOutputPath);

    const missingArtifact = missingRequiredArtifact(absOutputPath, {
      agent: runner.agent,
      kind: 'implement',
      outputPath: relOutputPath,
      artifactName: 'implementation ledger'
    });
    if (missingArtifact) {
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation failed: ${missingArtifact.message}`,
        errorKind: missingArtifact.errorKind
      });
      return emitFinalSummary(false, 'unknown', missingArtifact.message, null);
    }
    const ledgerContent = readFileSync(absOutputPath, 'utf-8');
    if (!isCompleteImplementLedger(ledgerContent)) {
      const reason = !ledgerContent.trim()
        ? 'empty'
        : 'missing the required evidence table, requirement coverage table, and/or confidence declaration (see 30-simple-implement SKILL.md "Implementation Evidence Ledger")';
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation failed: ledger at ${relOutputPath} is ${reason}`,
        errorKind: ledgerContent.trim() ? 'invalid_output' : 'empty_output'
      });
      return emitFinalSummary(false, 'unknown', `Ledger at ${relOutputPath} is ${reason}`, null);
    }

    const closeoutSignal = deriveCloseoutSignal(ledgerContent);
    const closeoutOutcome = writePlanCloseout({
      planPath: projectPlanPath,
      version: nextVersion,
      agent: runner.agent,
      signal: closeoutSignal
    });
    if (!closeoutOutcome.ok) {
      const closeoutError = closeoutOutcome.error.includes('plan file not found')
        ? `${closeoutOutcome.error}. The implement agent may have removed docs/dev/plan.md during the run; harness closeout owns plan status/change-log updates and expects that file to remain in place.`
        : closeoutOutcome.error;
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation failed: plan closeout error: ${closeoutError}`,
        errorKind: 'closeout_failed'
      });
      return emitFinalSummary(false, 'unknown', `Plan closeout failed: ${closeoutError}`, null);
    }

    if (closeoutOutcome.status === 'blocked') {
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation blocked: ${closeoutSignal.reason ?? 'confidence below 0.95 threshold'}`,
        errorKind: 'implementation_blocked'
      });
      return emitFinalSummary(false, 'unknown', `Implementation blocked: confidence below 0.95 threshold`, null);
    }

    options.output.stepSucceeded({
      kind: 'implement',
      skillId: implementSkillId,
      version: nextVersion,
      message: `Implementation completed: ledger verified at ${relOutputPath} and plan closeout wrote status: done`
    });

    const meta: ArtifactMeta = {
      loop: loopName,
      skill: implementSkillId,
      kind: 'implement',
      role: skill.role,
      version: nextVersion,
      agent: runner.agent,
      model: runner.model,
      target: loopSpec.target,
      priorAudit: priorAuditRel(projectRoot, approvedPlanAuditPath),
      timestamp: new Date().toISOString(),
      durationMs
    };
    writeArtifactWithMeta(absOutputPath, ledgerContent, meta);

    steps.push({
      kind: 'implement',
      role: skill.role,
      agent: runner.agent,
      model: runner.model,
      version: nextVersion,
      status: 'done',
      artifactPath: absOutputPath,
      mtime: Date.now(),
      durationMs
    });

    const summary = emitFinalSummary(true, null, `Implementation completed successfully: ${relOutputPath}`, absOutputPath);

    if (options.interactive) {
      const { action: chosenAction, phase: chosenPhase } = await chooseAction('in-loop', 'implement-done');
      if (chosenAction.id === 'stop') {
        return summary;
      } else {
        const reviewLoopSpec = config.manifest.loops['review'];
        if (!reviewLoopSpec) {
          throw new Error("Loop 'review' not found in manifest");
        }
        
        await resolveUpfrontRunners(chosenAction, chosenPhase, loopSpec);

        const reviewRunners: Record<string, Runner> = {};
        if (reviewLoopSpec.audit && runners[reviewLoopSpec.audit]) {
          reviewRunners[reviewLoopSpec.audit] = runners[reviewLoopSpec.audit];
        }
        if (reviewLoopSpec['follow-up'] && runners[reviewLoopSpec['follow-up']]) {
          reviewRunners[reviewLoopSpec['follow-up']] = runners[reviewLoopSpec['follow-up']];
        }

        const seedResolved = new Set<string>();
        if (reviewLoopSpec.audit && runners[reviewLoopSpec.audit]) {
          seedResolved.add(reviewLoopSpec.audit);
        }
        if (reviewLoopSpec['follow-up'] && runners[reviewLoopSpec['follow-up']]) {
          seedResolved.add(reviewLoopSpec['follow-up']);
        }

        return runLoop(projectRoot, 'review', reviewLoopSpec, config, reviewRunners, {
          ...options,
          seedResolved
        });
      }
    }
    return summary;
  }

  const noteProjectSummary = (detail: string): void => {
    projectSummaryDetails.push(detail);
    options.output.note(detail);
  };

  const planDocPath = resolve(projectRoot, 'docs/dev/plan.md');
  const hasPlanDoc = existsSync(planDocPath);
  noteProjectSummary(hasPlanDoc ? `plan document: docs/dev/plan.md` : `plan document: not found`);

  const planSpec = config.manifest.loops['plan']!;
  const planScan = scan(projectRoot, { auditPattern: planSpec.auditPattern!, followUpPattern: planSpec.followUpPattern! });
  const latestAudit = planScan.auditSteps.length > 0 ? planScan.auditSteps[planScan.auditSteps.length - 1] : null;
  if (latestAudit) {
    noteProjectSummary(`most recent plan audit: ${relative(projectRoot, latestAudit.artifactPath)}, decision: ${latestAudit.verdict}, model: ${latestAudit.agent} (${latestAudit.model}), sessionId: ${latestAudit.sessionId ?? 'none'}`);
  } else {
    noteProjectSummary('most recent plan audit: none');
  }
  const latestFollowUp = planScan.timeline.filter(s => s.kind === 'follow-up').pop();
  if (latestFollowUp) {
    noteProjectSummary(`most recent plan follow-up: ${relative(projectRoot, latestFollowUp.artifactPath)}, model: ${latestFollowUp.agent} (${latestFollowUp.model}), sessionId: ${latestFollowUp.sessionId ?? 'none'}`);
  } else {
    noteProjectSummary('most recent plan follow-up: none');
  }

  const implementSpec = config.manifest.loops['implement'];
  if (implementSpec?.implementPattern) {
    const implementRole = implementSpec.implement && config.manifest.skills[implementSpec.implement]?.role || 'implementer';
    const latestImplementation = scanImplementAsSteps(projectRoot, implementSpec.implementPattern, implementRole).pop();
    noteProjectSummary(latestImplementation
      ? `most recent implementation: ${relative(projectRoot, latestImplementation.artifactPath)}, model: ${latestImplementation.agent} (${latestImplementation.model})`
      : 'most recent implementation: none');
  }

  const reviewSpec = config.manifest.loops['review'];
  if (reviewSpec?.auditPattern && reviewSpec.followUpPattern) {
    const reviewScan = scan(projectRoot, { auditPattern: reviewSpec.auditPattern, followUpPattern: reviewSpec.followUpPattern });
    const latestReview = reviewScan.auditSteps.at(-1);
    const latestReviewFollowUp = reviewScan.timeline.filter(s => s.kind === 'follow-up').at(-1);
    noteProjectSummary(latestReview
      ? `most recent review: ${relative(projectRoot, latestReview.artifactPath)}, decision: ${latestReview.verdict}, model: ${latestReview.agent} (${latestReview.model}), sessionId: ${latestReview.sessionId ?? 'none'}`
      : 'most recent review: none');
    noteProjectSummary(latestReviewFollowUp
      ? `most recent review follow-up: ${relative(projectRoot, latestReviewFollowUp.artifactPath)}, model: ${latestReviewFollowUp.agent} (${latestReviewFollowUp.model}), sessionId: ${latestReviewFollowUp.sessionId ?? 'none'}`
      : 'most recent review follow-up: none');
  }

  const initialScan = scan(projectRoot, { auditPattern: loopSpec.auditPattern!, followUpPattern: loopSpec.followUpPattern! });
  if (initialScan.latestVerdict === 'unknown' && initialScan.auditSteps.length > 0) {
    throw new Error(`latest audit is unparseable; resolve or delete it before smashing`);
  }

  let N = 1;
  let pendingFollowUp = false;

  steps.push(...initialScan.timeline);
  let iteration = 0;
  let lastAuditPath: string | null = steps.filter(s => s.kind === 'audit').pop()?.artifactPath ?? null;

  const latestAuditStep = () => steps.filter(s => s.kind === 'audit').pop() ?? null;

  const { action: currentAction, phase: startupPhase } = await chooseAction('startup');
  if (options.interactive) {
    await resolveUpfrontRunners(currentAction, startupPhase, loopSpec);
    isFirstAction = false;
  }
  if (currentAction.id === 'stop') {
    const latestAudit = latestAuditStep();
    return emitFinalSummary(true, latestAudit?.verdict || null, `awaiting your review: ${latestAudit?.artifactPath ?? 'none'}`, latestAudit?.artifactPath ?? null);
  } else if (currentAction.id === 'implement') {
    const implementLoopSpec = config.manifest.loops['implement'];
    if (!implementLoopSpec) {
      throw new Error("Loop 'implement' not found in manifest");
    }
    const implementSkills = implementLoopSpec.implement ? [implementLoopSpec.implement] : [];
    const implementRunners: Record<string, Runner> = {};
    if (options.interactive) {
      const prompted = await promptRunners(implementSkills, config, options.registry, options.globalOverrides, { forceSelect: true });
      Object.assign(implementRunners, prompted);
    } else {
      implementRunners[implementLoopSpec.implement!] = resolveRunner(implementLoopSpec.implement!, config, options.globalOverrides);
    }
    return runLoop(projectRoot, 'implement', implementLoopSpec, config, implementRunners, options);
  }

  let pendingAction: StageAction | null = currentAction;
  // Chain mode = START NEW or CONTINUE: keep cycling audit -> follow-up -> audit
  // on rejection without re-prompting the action menu. One-off (run-one-step)
  // actions return to the menu after their single step. Re-derived whenever the
  // operator picks a new action below.
  let chainMode = currentAction.group !== 'run-one-step';
  if (currentAction.stage === 'follow-up') {
    N = currentAction.version + 1;
    pendingFollowUp = true;
  } else {
    N = currentAction.version;
    pendingFollowUp = false;
  }

  while (iteration < options.maxIterations) {
    options.output.iterationStarted({ iteration: iteration + 1, maxIterations: options.maxIterations });

    // --- Step A: Follow-up ---
    if (pendingFollowUp) {
      const followUpSkillId = loopSpec['follow-up']!;
      const followUpSkill = config.manifest.skills[followUpSkillId];
      if (!followUpSkill) {
        throw new Error(`Follow-up skill '${followUpSkillId}' not found in manifest`);
      }
      let followUpPolicy: SessionPolicy = 'new';
      if (upfrontPolicies.has(followUpSkillId)) {
        followUpPolicy = upfrontPolicies.get(followUpSkillId)!;
      } else if (pendingAction) {
        if (typeof pendingAction.sessionPolicy === 'object') {
          followUpPolicy = pendingAction.sessionPolicy.followUp;
        } else {
          followUpPolicy = pendingAction.sessionPolicy;
        }
      }

      if (!upfrontResolved.has(followUpSkillId)) {
        if (followUpPolicy === 'resumed') {
          const provider = pendingAction?.provider;
          const model = pendingAction?.model;
          if (provider && model) {
            if (!config.registry.providers[provider]) {
              throw new Error(`Inherited provider ${provider} is not configured. Please re-run START NEW to pick a fresh provider+model.`);
            }
            const recordedRunner = resolveRecordedRunner(config.registry, provider, model);
            if (!recordedRunner) {
              throw new Error(`Inherited model ${model} is not configured for provider ${provider}. Please re-run START NEW to pick a fresh provider+model.`);
            }
            runners[followUpSkillId] = recordedRunner;
          }
        }
      }

      const runner = runners[followUpSkillId];
      if (!runner) {
        throw new Error(`No runner resolved for follow-up skill '${followUpSkillId}'`);
      }

      const followUpVersion = N - 1;
      renderPanel(
        { skillId: followUpSkillId, agent: runner.agent, model: runner.model },
        iteration + 1,
        `Executing ${labels.followUp?.skillId ?? followUpSkillId} on version ${N - 1} rejection...`
      );

      const prompt = preparePrompt(followUpSkillId, followUpSkill, followUpVersion, runner, 'follow-up');

      let followUpContinuity: { mode: 'fresh' | 'resumed'; sessionId?: string } | undefined = undefined;
      if (deriveContinuity(runner.agent)) {
        if (followUpPolicy === 'resumed') {
          const detail = findResumableSessionDetail(steps, ['follow-up'], runner.agent, runner.model, { stopAtApproved: true });
          if (detail.status === 'found' && detail.session) {
            followUpContinuity = { mode: 'resumed', sessionId: detail.session.sessionId };
          } else {
            if (detail.status === 'no_steps_of_kind') {
              options.output.note(`resumed requested for follow-up but no prior follow-up steps found; starting fresh.`);
            } else if (detail.status === 'agent_model_mismatch') {
              options.output.warn(`resumed requested for follow-up but no prior ${runner.agent}/${runner.model} session found; starting fresh.`);
            } else if (detail.status === 'blocked_by_approved_boundary') {
              options.output.warn(`resumed requested for follow-up but walk is blocked by an APPROVED-audit boundary; starting fresh.`);
            } else if (detail.status === 'session_id_none') {
              options.output.warn(`resumed requested for follow-up but prior steps carry sessionId 'none'; starting fresh.`);
            }
            followUpContinuity = { mode: 'fresh' };
          }
        } else {
          followUpContinuity = { mode: 'fresh' };
        }
      }

      let runResult: { result: RunResult; durationMs: number };
      try {
        runResult = await runAdapter(
          runner,
          prompt,
          `Spawning ${runner.agent} for follow-up...`,
          'follow-up',
          followUpSkillId,
          followUpVersion,
          iteration + 1,
          followUpContinuity
        );
      } catch (err: any) {
        options.output.stepFailed({
          kind: 'follow-up',
          skillId: followUpSkillId,
          version: followUpVersion,
          message: `Follow-up failed: ${err.message}`
        });
        return emitFinalSummary(false, 'unknown', err.message, lastAuditPath);
      }

      const { result, durationMs } = runResult;

      // Thread ID mismatch check
      if (followUpContinuity?.mode === 'resumed' && result.sessionId && result.sessionId !== followUpContinuity.sessionId) {
        const mismatchMsg = `Resumed thread ID mismatch: expected ${followUpContinuity.sessionId}, got ${result.sessionId}`;
        options.output.stepFailed({
          kind: 'follow-up',
          skillId: followUpSkillId,
          version: followUpVersion,
          message: mismatchMsg
        });
        return emitFinalSummary(false, 'unknown', mismatchMsg, lastAuditPath);
      }

      if (stepFailed(result, false)) {
        if (result.error?.kind === 'auth') {
          quarantineAuthArtifact(loopSpec.followUpPattern, followUpVersion, runner.agent);
        }
        options.output.stepFailed({
          kind: 'follow-up',
          skillId: followUpSkillId,
          version: followUpVersion,
          message: `Follow-up ${result.error?.kind ?? 'failed'}`,
          errorKind: result.error?.kind
        });
        const errMessage = structuredMessage(result, { label: 'Follow-up', model: runner.model, agent: runner.agent });
        return emitFinalSummary(false, 'unknown', errMessage, lastAuditPath);
      }
      if (isNonCleanCompletion(result)) {
        options.output.stepFailed({
          kind: 'follow-up',
          skillId: followUpSkillId,
          version: followUpVersion,
          message: `Follow-up truncated or interrupted`,
          errorKind: result.completion
        });
        return emitFinalSummary(false, 'unknown', completionMessage(result), lastAuditPath);
      }

      const relFollowUpPath = renderPattern(loopSpec.followUpPattern!, { n: followUpVersion, agent: runner.agent });
      const absFollowUpPath = resolve(projectRoot, relFollowUpPath);
      const missingArtifact = missingRequiredArtifact(absFollowUpPath, {
        agent: runner.agent,
        kind: 'follow-up',
        outputPath: relFollowUpPath
      });
      if (missingArtifact) {
        options.output.stepFailed({
          kind: 'follow-up',
          skillId: followUpSkillId,
          version: followUpVersion,
          message: `Follow-up failed: ${missingArtifact.message}`,
          errorKind: missingArtifact.errorKind
        });
        return emitFinalSummary(false, 'unknown', missingArtifact.message, lastAuditPath);
      }

      const mode = followUpContinuity?.mode ?? 'none';
      const sid = followUpContinuity ? (result.sessionId ?? 'none') : 'none';
      const body = readFileSync(absFollowUpPath, 'utf-8');
      const followUpOutcome: FollowUpOutcome = parseFollowUpOutcome(body);
      writeArtifactWithMeta(absFollowUpPath, body, buildStepMeta(followUpSkillId, followUpSkill, 'follow-up', followUpVersion, runner, durationMs, mode, sid));
      steps.push({
        kind: 'follow-up', role: followUpSkill.role, agent: runner.agent, model: runner.model,
        version: followUpVersion, status: 'done', outcome: followUpOutcome,
        artifactPath: absFollowUpPath, mtime: Date.now(), durationMs,
        sessionMode: mode, sessionId: sid
      });

      options.output.stepSucceeded({
        kind: 'follow-up',
        skillId: followUpSkillId,
        version: followUpVersion,
        message: `Follow-up completed successfully`
      });
      pendingFollowUp = false;

      if (pendingAction?.oneOff && pendingAction.stage === 'follow-up') {
        pendingAction = null;
        const { action: nextAction, phase: nextPhase } = await chooseAction('in-loop');
        if (options.interactive) {
          await resolveUpfrontRunners(nextAction, nextPhase, loopSpec);
        }
        if (nextAction.id === 'stop') {
          const latestAudit = latestAuditStep();
          const relPath = latestAudit?.artifactPath ? relative(projectRoot, latestAudit.artifactPath) : 'none';
          return emitFinalSummary(latestAudit?.verdict === 'APPROVED', latestAudit?.verdict || null, `awaiting your review: ${relPath}`, latestAudit?.artifactPath ?? null);
        } else if (nextAction.id === 'implement') {
          const implementLoopSpec = config.manifest.loops['implement'];
          if (!implementLoopSpec) {
            throw new Error("Loop 'implement' not found in manifest");
          }
          const implementSkills = implementLoopSpec.implement ? [implementLoopSpec.implement] : [];
          const implementRunners: Record<string, Runner> = {};
          if (options.interactive) {
            const prompted = await promptRunners(implementSkills, config, options.registry, options.globalOverrides, { forceSelect: true });
            Object.assign(implementRunners, prompted);
          } else {
            implementRunners[implementLoopSpec.implement!] = resolveRunner(implementLoopSpec.implement!, config, options.globalOverrides);
          }
          return runLoop(projectRoot, 'implement', implementLoopSpec, config, implementRunners, options);
        } else {
          pendingAction = nextAction;
          chainMode = nextAction.group !== 'run-one-step';
          if (nextAction.stage === 'follow-up') {
            N = nextAction.version + 1;
            pendingFollowUp = true;
          } else {
            N = nextAction.version;
            pendingFollowUp = false;
          }
          continue;
        }
      }
    }

    // --- Step B: Audit ---
    const auditSkillId = loopSpec.audit!;
    const auditSkill = config.manifest.skills[auditSkillId];
    if (!auditSkill) {
      throw new Error(`Audit skill '${auditSkillId}' not found in manifest`);
    }
    let auditPolicy: SessionPolicy = 'new';
    if (upfrontPolicies.has(auditSkillId)) {
      auditPolicy = upfrontPolicies.get(auditSkillId)!;
    } else if (pendingAction) {
      if (typeof pendingAction.sessionPolicy === 'object') {
        auditPolicy = pendingAction.sessionPolicy.audit;
      } else {
        auditPolicy = pendingAction.sessionPolicy;
      }
    }

    if (!upfrontResolved.has(auditSkillId)) {
      if (auditPolicy === 'resumed') {
        const provider = pendingAction?.provider;
        const model = pendingAction?.model;
        if (provider && model) {
          if (!config.registry.providers[provider]) {
            throw new Error(`Inherited provider ${provider} is not configured. Please re-run START NEW to pick a fresh provider+model.`);
          }
          const recordedRunner = resolveRecordedRunner(config.registry, provider, model);
          if (!recordedRunner) {
            throw new Error(`Inherited model ${model} is not configured for provider ${provider}. Please re-run START NEW to pick a fresh provider+model.`);
          }
          runners[auditSkillId] = recordedRunner;
        }
      }
    }

    const runner = runners[auditSkillId];
    if (!runner) {
      throw new Error(`No runner resolved for audit skill '${auditSkillId}'`);
    }

    renderPanel(
      { skillId: auditSkillId, agent: runner.agent, model: runner.model },
      iteration + 1,
      `Running ${labels.audit?.skillId ?? auditSkillId} for version ${N}...`
    );

    let continuity: { mode: 'fresh' | 'resumed'; sessionId?: string } | undefined = undefined;

    if (deriveContinuity(runner.agent)) {
      if (auditPolicy === 'resumed') {
        const planScanForPhase = scan(projectRoot, { auditPattern: loopSpec.auditPattern || '', followUpPattern: loopSpec.followUpPattern || '' });
        const stopAtApproved = !pendingAction || pendingAction.id !== 'continue' || planScanForPhase.latestVerdict !== 'APPROVED';
        const detail = findResumableSessionDetail(steps, ['audit'], runner.agent, runner.model, { stopAtApproved });
        if (detail.status === 'found' && detail.session) {
          continuity = { mode: 'resumed', sessionId: detail.session.sessionId };
        } else {
          if (detail.status === 'no_steps_of_kind') {
            options.output.note(`resumed requested for audit but no prior audit steps found; starting fresh.`);
          } else if (detail.status === 'agent_model_mismatch') {
            options.output.warn(`resumed requested for audit but no prior ${runner.agent}/${runner.model} session found; starting fresh.`);
          } else if (detail.status === 'blocked_by_approved_boundary') {
            options.output.warn(`resumed requested for audit but walk is blocked by an APPROVED-audit boundary; starting fresh.`);
          } else if (detail.status === 'session_id_none') {
            options.output.warn(`resumed requested for audit but prior steps carry sessionId 'none'; starting fresh.`);
          }
          continuity = { mode: 'fresh' };
        }
      } else {
        continuity = { mode: 'fresh' };
      }
    }

    const prompt = preparePrompt(auditSkillId, auditSkill, N, runner, 'audit');

    let runResult: { result: RunResult; durationMs: number };
    try {
      runResult = await runAdapter(
        runner,
        prompt,
        `Spawning ${runner.agent} for audit v${N}...`,
        'audit',
        auditSkillId,
        N,
        iteration + 1,
        continuity
      );
    } catch (err: any) {
      options.output.stepFailed({
        kind: 'audit',
        skillId: auditSkillId,
        version: N,
        message: `Audit failed: ${err.message}`
      });
      return emitFinalSummary(false, 'unknown', err.message, lastAuditPath);
    }

    const { result, durationMs } = runResult;

    // Thread ID mismatch check
    if (continuity?.mode === 'resumed' && result.sessionId && result.sessionId !== continuity.sessionId) {
      const mismatchMsg = `Resumed thread ID mismatch: expected ${continuity.sessionId}, got ${result.sessionId}`;
      options.output.stepFailed({
        kind: 'audit',
        skillId: auditSkillId,
        version: N,
        message: mismatchMsg
      });
      return emitFinalSummary(false, 'unknown', mismatchMsg, lastAuditPath);
    }

    if (stepFailed(result, true)) {
      if (result.error?.kind === 'auth') {
        quarantineAuthArtifact(loopSpec.auditPattern, N, runner.agent);
      }
      options.output.stepFailed({
        kind: 'audit',
        skillId: auditSkillId,
        version: N,
        message: `Audit ${result.error!.kind}`,
        errorKind: result.error?.kind
      });
      const errMessage = structuredMessage(result, { label: 'Audit', model: runner.model, agent: runner.agent });
      return emitFinalSummary(false, 'unknown', errMessage, lastAuditPath);
    }
    if (isNonCleanCompletion(result)) {
      options.output.stepFailed({
        kind: 'audit',
        skillId: auditSkillId,
        version: N,
        message: `Audit truncated or interrupted`,
        errorKind: result.completion
      });
      return emitFinalSummary(false, 'unknown', completionMessage(result), lastAuditPath);
    }

    const relOutputPath = renderPattern(loopSpec.auditPattern!, { n: N, agent: runner.agent });
    const absOutputPath = resolve(projectRoot, relOutputPath);
    const missingArtifact = missingRequiredArtifact(absOutputPath, {
      agent: runner.agent,
      kind: 'audit',
      outputPath: relOutputPath
    });
    if (missingArtifact) {
      options.output.stepFailed({
        kind: 'audit',
        skillId: auditSkillId,
        version: N,
        message: `Audit failed: ${missingArtifact.message}`,
        errorKind: missingArtifact.errorKind
      });
      return emitFinalSummary(false, 'unknown', missingArtifact.message, lastAuditPath);
    }

    const fileContent = readFileSync(absOutputPath, 'utf-8');

    const verdict = parseVerdict(fileContent);
    iteration++;

    if (verdict === 'unknown') {
      renderPanel(null, iteration + 1, chalk.red(`Terminal: unknown verdict on version ${N}`));
      const errMessage = `Audit failed to write a valid verdict. Output file path: ${relOutputPath}. Process output: ${result.stdout}`;
      return emitFinalSummary(false, 'unknown', errMessage, lastAuditPath);
    }

    // Write provenance stamp to audit file
    const mode = continuity?.mode ?? 'none';
    const sid = continuity ? (result.sessionId ?? 'none') : 'none';
    writeArtifactWithMeta(absOutputPath, fileContent, buildStepMeta(auditSkillId, auditSkill, 'audit', N, runner, durationMs, mode, sid));

    lastAuditPath = absOutputPath;
    steps.push({
      kind: 'audit', role: auditSkill.role, agent: runner.agent, model: runner.model,
      version: N, status: 'done', verdict,
      artifactPath: absOutputPath, mtime: Date.now(), durationMs,
      sessionMode: mode,
      sessionId: sid
    });

    options.output.stepSucceeded({
      kind: 'audit',
      skillId: auditSkillId,
      version: N,
      message: `Audit execution completed`
    });

    renderPanel(null, iteration, `Completed iteration ${iteration} with verdict: ${verdict}`);

    pendingAction = null; // Clear pending action since it's fully consumed

    // Chain mode (START NEW / CONTINUE) keeps cycling on rejection: take the
    // recommended continuation without re-prompting the action menu. APPROVED,
    // one-off, and terminal verdicts still prompt normally below.
    const chainReject = chainMode && verdict === 'REJECTED';
    const { action: nextAction, phase: nextPhase } = await chooseAction('in-loop', undefined, { autoRecommend: chainReject });
    if (options.interactive) {
      await resolveUpfrontRunners(nextAction, nextPhase, loopSpec);
    }
    if (nextAction.id === 'stop') {
      return emitFinalSummary(verdict === 'APPROVED', verdict, `awaiting your review: ${relOutputPath}`, lastAuditPath);
    } else if (nextAction.id === 'implement') {
      const implementLoopSpec = config.manifest.loops['implement'];
      if (!implementLoopSpec) {
        throw new Error("Loop 'implement' not found in manifest");
      }
      const implementSkills = implementLoopSpec.implement ? [implementLoopSpec.implement] : [];
      const implementRunners: Record<string, Runner> = {};
      if (options.interactive) {
        const prompted = await promptRunners(implementSkills, config, options.registry, options.globalOverrides, { forceSelect: true });
        Object.assign(implementRunners, prompted);
      } else {
        implementRunners[implementLoopSpec.implement!] = resolveRunner(implementLoopSpec.implement!, config, options.globalOverrides);
      }
      return runLoop(projectRoot, 'implement', implementLoopSpec, config, implementRunners, options);
    } else {
      pendingAction = nextAction;
      chainMode = nextAction.group !== 'run-one-step';
      if (nextAction.stage === 'follow-up') {
        N = nextAction.version + 1;
        pendingFollowUp = true;
      } else {
        N = nextAction.version;
        pendingFollowUp = false;
      }
      continue;
    }
  }

  return emitFinalSummary(false, 'REJECTED', `hit max-iterations, awaiting human`, lastAuditPath);
}
