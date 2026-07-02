import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import chalk from 'chalk';
import { scan, type Step, resolveImplementFacts, requireApprovedPlanAuditPath } from './state.js';
import { parseFollowUpOutcome, type FollowUpOutcome } from './follow-up-outcome.js';
import { getAdapter, type AgentRegistry } from './adapters/registry.js';
import type { RunResult } from './adapters/types.js';
import { renderPattern } from './patterns.js';
import { composePrompt } from './prompt-composer.js';
import { writeArtifactWithMeta, type ArtifactMeta, type StepKind } from './provenance.js';
import { parseVerdict } from './verdict.js';
import { buildPanelContext, latestAuditVersion, type PanelContext } from './status.js';
import type { LifecycleEvent } from './adapter-lifecycle.js';
import { promptSecondOpinionDecision, promptSecondOpinionRunner, promptContinueToReview, promptRunners } from './interactive.js';
import { structuredMessage } from './adapters/errors.js';
import type { Config } from './config.js';
import type { LoopSpec, SkillSpec } from './manifest.js';
import type { CliOutput } from './cli-output.js';
import { resolveRunner } from './runner.js';
import { isCompleteImplementLedger } from './implement-ledger.js';
import { deriveCloseoutSignal, writePlanCloseout } from './plan-closeout.js';
import { debugLoopSpawn } from './debug-spawn.js';
import { quarantineArtifact, quarantineInterruptedResume, setStepCtx } from './interrupted-artifact.js';

export interface LoopOptions {
  maxIterations: number;
  startPoint?: 'fresh' | 'resume' | 'new-round';
  globalOverrides?: { agent?: string; model?: string };
  interactive?: boolean;
  registry: AgentRegistry;
  output: CliOutput;
  auditContinuity?: 'off' | 'codex-resume';
}

type Runner = { agent: string; model: string };
type LoopReturn = { success: boolean; verdict: string; message: string; lastAuditPath: string | null };

export async function runLoop(
  projectRoot: string,
  loopName: string,
  loopSpec: LoopSpec,
  config: Config,
  runners: Record<string, Runner>,
  options: LoopOptions
): Promise<LoopReturn> {
  // §3: defensive quarantine at loop start. Quarantine any in-flight/late
  // artifact left by a prior interrupted run (marker-based) before state
  // resolution. No-op when no marker exists. Composite helper also covers the
  // recursive plan→implement→review transitions (marker cleared after first run).
  quarantineInterruptedResume(projectRoot, config.manifest.loops);

  const steps: Step[] = [];

  const priorAuditRel = (root: string, p: string | null | undefined): string =>
    p ? (p.startsWith(root) ? relative(root, p) : p) : 'none';

  const renderPanel = (
    active: { skillId: string; agent: string; model: string } | null,
    currentIteration: number,
    message: string,
    inFlight: PanelContext['inFlight'] = null
  ) => {
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
        false
      )
    );
  };

  const emitFinalSummary = (
    success: boolean,
    verdict: 'APPROVED' | 'REJECTED' | 'unknown' | null,
    message: string,
    lastPath: string | null
  ): LoopReturn => {
    options.output.finalSummary({ success, verdict, message, lastAuditPath: lastPath });
    return { success, verdict: verdict ?? 'unknown', message, lastAuditPath: lastPath };
  };

  const runAdapter = async (
    runner: Runner,
    prompt: string,
    spawnLabel: string,
    kind: StepKind,
    skillId: string,
    version: number,
    currentIteration: number,
    continuity?: { mode: 'fresh' | 'resumed'; sessionId?: string }
  ) => {
    const startedAtMs = Date.now();

    let lastProgressMessage = '';
    let toolCallCount = 0;

    const onLifecycle = (e: LifecycleEvent) => {
      if (e.type === 'message') {
        if (e.text) lastProgressMessage = e.text;
        toolCallCount += e.toolCalls ?? 0;
        if (liveInFlight) {
          liveInFlight.toolCallCount = toolCallCount;
          liveInFlight.progressMessage = lastProgressMessage || null;
        }
      }
      if (e.type === 'failed') {
        if (liveInFlight) {
          liveInFlight.status = 'failed';
        }
      }
      if (e.type === 'completed') {
        liveInFlight = null;
      }
    };

    let liveInFlight: NonNullable<PanelContext['inFlight']> | null = {
      kind,
      skillId,
      agent: runner.agent,
      model: runner.model,
      version,
      iteration: currentIteration,
      startedAtMs,
      status: 'running',
      spawnLabel,
      toolCallCount,
      progressMessage: null
    };

    if (options.output.attachLiveRegion) {
      options.output.attachLiveRegion(() => {
        const inFlight: PanelContext['inFlight'] = liveInFlight
          ? {
              kind: liveInFlight.kind,
              skillId: liveInFlight.skillId,
              agent: liveInFlight.agent,
              model: liveInFlight.model,
              version: liveInFlight.version,
              iteration: liveInFlight.iteration,
              startedAtMs: liveInFlight.startedAtMs,
              status: liveInFlight.status,
              spawnLabel: liveInFlight.spawnLabel,
              toolCallCount: liveInFlight.toolCallCount,
              progressMessage: liveInFlight.progressMessage
            }
          : null;
        return buildPanelContext(
          projectRoot,
          loopName,
          currentIteration,
          options.maxIterations,
          { skillId, agent: runner.agent, model: runner.model },
          steps,
          `Running ${kind} v${version}...`,
          inFlight,
          latestAuditVersion(steps),
          false
        );
      });
    }

    try {
      options.output.stepStarted({
        kind,
        skillId,
        agent: runner.agent,
        model: runner.model,
        iteration: currentIteration,
        version,
        message: spawnLabel
      });

      const adapter = getAdapter(options.registry, runner.agent);
      debugLoopSpawn({
        loopName,
        skillId,
        kind,
        agent: runner.agent,
        model: runner.model,
        version,
        cwd: projectRoot,
        prompt
      });

      // §3: register the active step context ONLY while the provider subprocess
      // is live, so an interrupt signal can write an accurate marker. Cleared in
      // the finally path so a stale context never archives a completed artifact.
      setStepCtx({
        loop: loopName,
        kind,
        version,
        agent: runner.agent,
        model: runner.model,
        skillId
      });

      const result = await adapter.run({
        prompt,
        model: runner.model,
        cwd: projectRoot,
        skillId,
        version,
        onLifecycle,
        continuity
      });

      // Agent wall-clock runtime for this step, measured from the spawn start
      // captured above. Persisted into the artifact front matter so `orc status`
      // can show per-step duration after the fact (status-panel/plain-render).
      const durationMs = Date.now() - startedAtMs;

      return { result, durationMs };
    } finally {
      setStepCtx(null);
      if (options.output.detachLiveRegion) {
        options.output.detachLiveRegion();
      }
    }
  };

  const stepFailed = (result: RunResult, acceptNonzeroExitWithVerdict: boolean): boolean =>
    Boolean(result.error) || (!acceptNonzeroExitWithVerdict && result.exitCode !== 0);

  /**
   * §2 auth-failure cleanup: when an adapter returns `error.kind === 'auth'`
   * (today only `agy`, when unauthenticated), quarantine the step's resolved
   * artifact so no resumable `docs/dev/*-vN-<agent>.md` file remains. The loop
   * is the only owner that knows the resolved output path (the adapter cannot).
   * Safe no-op when the adapter wrote no file. Applies to audit/follow-up/implement.
   */
  const quarantineAuthArtifact = (pattern: string | undefined, version: number, agent: string): void => {
    if (!pattern) return;
    const rel = renderPattern(pattern, { n: version, agent });
    const abs = resolve(projectRoot, rel);
    quarantineArtifact(projectRoot, abs, { reason: 'auth' });
  };

  const isNonCleanCompletion = (result: RunResult): boolean =>
    result.completion === 'truncated' || result.completion === 'interrupted';
  const completionMessage = (result: RunResult): string =>
    `Agent execution truncated or interrupted. Stop reason: ${result.stopReason}`;

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

    // Seed steps from existing plan audit history so the panel's
    // `Latest version:` label reflects the approved audit on disk,
    // not a fabricated `v0` (review v7 Major finding #2).
    const planHistory = scan(projectRoot, {
      auditPattern: planSpec.auditPattern ?? '',
      followUpPattern: planSpec.followUpPattern ?? ''
    });
    steps.push(...planHistory.timeline);

    // Resolve runner
    let runner = runners[implementSkillId];
    if (!runner && options.interactive) {
      const prompted = await promptRunners([implementSkillId], config, options.registry, options.globalOverrides);
      runner = prompted[implementSkillId];
    }
    if (!runner) {
      runner = resolveRunner(implementSkillId, config, options.globalOverrides);
    }

    renderPanel(
      { skillId: implementSkillId, agent: runner.agent, model: runner.model },
      1,
      `Running implementation v${nextVersion}...`
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

    const { result, durationMs } = await runAdapter(
      runner,
      prompt,
      `Spawning ${runner.agent} for implementation...`,
      'implement',
      implementSkillId,
      nextVersion,
      1
    );

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

    // --- Verify the implementation ledger BEFORE declaring success ---
    // A clean process exit is not "implementation completed"; the required
    // ledger artifact must exist, be non-empty, and match the ledger contract.
    const relOutputPath = renderPattern(loopSpec.implementPattern!, { n: nextVersion, agent: runner.agent });
    const absOutputPath = resolve(projectRoot, relOutputPath);

    if (!existsSync(absOutputPath)) {
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation failed: ${runner.agent} exited cleanly but produced no ledger at ${relOutputPath}`,
        errorKind: 'missing_output'
      });
      return emitFinalSummary(false, 'unknown', `${runner.agent} exited cleanly but produced no ledger at ${relOutputPath}`, null);
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

    // --- Plan closeout (Step 7b): update plan front matter + Change Log ---
    // The skill's §"Closeout Checklist" requires (1) updating the plan's
    // front-matter `status:` to `done` or `blocked` and (2) recording the run
    // in the plan's `## Change Log`. This MUST happen here (after the artifact
    // gate passes, BEFORE `writeArtifactWithMeta`) — the v5-audit C1 fix.
    // The harness's front-matter stamp is the durable state-detection
    // signal that `state.ts:scanImplementArtifacts()` reads via
    // `provenance.ts:parseArtifactMeta()`'s `priorAudit:` field. If we
    // stamped the file before closeout and closeout later failed, the
    // scanner would see `priorAudit: docs/dev/plan-audit-v{N}-<agent>.md`
    // and `resolveImplementFacts()` would return `currentPlanImplemented:
    // true` — letting a half-done run drive `smash.ts`'s interactive
    // default to `review` and bypass the `unknown` rule (AGENTS.md §3).
    // The fix is: stamp the harness front matter ONLY after closeout
    // succeeds, so a `closeout_failed` run leaves the ledger file on disk
    // without the harness's `priorAudit:` link and the state scanner
    // counts it as `currentPlanImplemented: false`. The wiring uses the
    // dedicated helper from Step 7b — `src/plan-closeout.ts` — not inline
    // parsing inside the loop, so the closeout logic is a single source
    // of truth reusable by any future closeout entry point (e.g.
    // `31-simple-implement-closeout`).
    const projectPlanPath = resolve(projectRoot, 'docs/dev/plan.md');
    const closeoutSignal = deriveCloseoutSignal(ledgerContent);
    const closeoutOutcome = writePlanCloseout({
      planPath: projectPlanPath,
      version: nextVersion,
      agent: runner.agent,
      signal: closeoutSignal
    });
    if (!closeoutOutcome.ok) {
      // CRITICAL (v5-audit C1): do NOT call writeArtifactWithMeta on
      // this branch. The agent's ledger file remains on disk without
      // the harness's front matter. `state.ts:scanImplementArtifacts()`
      // will read `priorAudit: 'none'` (no front matter → fallback
      // `priorAudit: 'none'` from `provenance.ts:parseArtifactMeta`),
      // `resolveImplementFacts()` will return `currentPlanImplemented:
      // false`, and `smash.ts` will default the next interactive start
      // to `implement` (not `review`). The regression test in Step 12
      // ("closeout_failed run does not advance the state scanner")
      // pins this contract end-to-end.
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation failed: plan closeout error: ${closeoutOutcome.error}`,
        errorKind: 'closeout_failed'
      });
      return emitFinalSummary(false, 'unknown', `Plan closeout failed: ${closeoutOutcome.error}`, null);
    }

    // --- Branch on closeout status (v9-audit Critical fix) ---
    // A `blocked` closeout (confidence < 0.95) is terminal for
    // implementation advancement: the harness emits stepFailed, does
    // NOT stamp the harness's front matter, and returns `unknown` so
    // the next interactive startup defaults to `implement` (not
    // `review`). The agent's ledger file remains on disk without the
    // harness's `priorAudit:` link, so `state.ts:scanImplementArtifacts()`
    // reads `priorAudit: 'none'` and `resolveImplementFacts()` returns
    // `currentPlanImplemented: false`. Only a `done` closeout stamps
    // the front matter and advances state.
    if (closeoutOutcome.status === 'blocked') {
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation blocked: ${closeoutSignal.reason ?? 'confidence below 0.95 threshold'}`,
        errorKind: 'implementation_blocked'
      });
      // CRITICAL: do NOT call writeArtifactWithMeta on this branch.
      // The ledger file stays on disk without the harness's
      // `priorAudit:` link, so the state scanner does NOT advance.
      return emitFinalSummary(false, 'unknown', `Implementation blocked: confidence below 0.95 threshold`, null);
    }

    // --- Success emit (v5-audit C1: emitted AFTER closeout, before stamp) ---
    // The success message now reports verified reality: the ledger was
    // verified AND the plan closeout succeeded with status `done`.
    // A `closeout_failed` or `blocked` run does NOT reach this line.
    options.output.stepSucceeded({
      kind: 'implement',
      skillId: implementSkillId,
      version: nextVersion,
      message: `Implementation completed: ledger verified at ${relOutputPath} and plan closeout wrote status: done`
    });

    // --- Stamp the harness's front matter (v5-audit C1: after closeout) ---
    // Closeout succeeded with `done`; the file is now an authentic
    // record of a completed implementation. Stamp the harness's front
    // matter onto it so `state.ts:scanImplementArtifacts()` can see the
    // `priorAudit: <plan-audit-path>` link and
    // `resolveImplementFacts()` returns `currentPlanImplemented: true`.
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
      const transitionChoice = await promptContinueToReview();
      if (transitionChoice === 'review') {
        const reviewLoopSpec = config.manifest.loops['review'];
        if (!reviewLoopSpec) {
          throw new Error("Loop 'review' not found in manifest");
        }
        const reviewSkills = [reviewLoopSpec.audit, reviewLoopSpec['follow-up']].filter((s): s is string => !!s);
        const reviewRunners: Record<string, Runner> = {};
        const prompted = await promptRunners(reviewSkills, config, options.registry, options.globalOverrides);
        Object.assign(reviewRunners, prompted);
        return runLoop(projectRoot, 'review', reviewLoopSpec, config, reviewRunners, {
          ...options,
          startPoint: 'fresh'
        });
      }
    }
    return summary;
  }

  // --- audit-loop stages ---
  const initialScan = scan(projectRoot, { auditPattern: loopSpec.auditPattern!, followUpPattern: loopSpec.followUpPattern! });
  if (initialScan.latestVerdict === 'unknown' && initialScan.auditSteps.length > 0) {
    throw new Error(`latest audit is unparseable; resolve or delete it before smashing`);
  }

  let N = 1;
  let pendingFollowUp = false;
  let isSecondOpinion = false;

  if (options.startPoint === 'resume') {
    N = initialScan.latestVersion + 1;
    pendingFollowUp = true;
  } else if (options.startPoint === 'new-round') {
    N = initialScan.latestVersion + 1;
    pendingFollowUp = false;
  } else {
    // fresh
    N = 1;
    pendingFollowUp = false;
  }

  steps.push(...initialScan.timeline);
  let iteration = 0;
  let lastAuditPath: string | null = steps.filter(s => s.kind === 'audit').pop()?.artifactPath ?? null;

  const latestAuditStep = () => steps.filter(s => s.kind === 'audit').pop() ?? null;

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

  while (iteration < options.maxIterations) {
    options.output.iterationStarted({ iteration: iteration + 1, maxIterations: options.maxIterations });

    // --- Step A: Follow-up ---
    if (pendingFollowUp) {
      const followUpSkillId = loopSpec['follow-up']!;
      const followUpSkill = config.manifest.skills[followUpSkillId];
      if (!followUpSkill) {
        throw new Error(`Follow-up skill '${followUpSkillId}' not found in manifest`);
      }
      const runner = runners[followUpSkillId];
      if (!runner) {
        throw new Error(`No runner resolved for follow-up skill '${followUpSkillId}'`);
      }

      const followUpVersion = N - 1;
      renderPanel(
        { skillId: followUpSkillId, agent: runner.agent, model: runner.model },
        iteration + 1,
        `Executing follow-up on version ${N - 1} rejection...`
      );

      const prompt = preparePrompt(followUpSkillId, followUpSkill, followUpVersion, runner, 'follow-up');
      const { result, durationMs } = await runAdapter(
        runner,
        prompt,
        `Spawning ${runner.agent} for follow-up...`,
        'follow-up',
        followUpSkillId,
        followUpVersion,
        iteration + 1
      );

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
      let followUpOutcome: FollowUpOutcome = 'patched';
      if (existsSync(absFollowUpPath)) {
        const body = readFileSync(absFollowUpPath, 'utf-8');
        followUpOutcome = parseFollowUpOutcome(body);
        writeArtifactWithMeta(absFollowUpPath, body, buildStepMeta(followUpSkillId, followUpSkill, 'follow-up', followUpVersion, runner, durationMs));
      }
      steps.push({
        kind: 'follow-up', role: followUpSkill.role, agent: runner.agent, model: runner.model,
        version: followUpVersion, status: 'done', outcome: followUpOutcome,
        artifactPath: absFollowUpPath, mtime: Date.now(), durationMs,
        sessionMode: 'none', sessionId: 'none'
      });

      options.output.stepSucceeded({
        kind: 'follow-up',
        skillId: followUpSkillId,
        version: followUpVersion,
        message: `Follow-up completed successfully`
      });
      pendingFollowUp = false;
    }

    // --- Step B: Audit ---
    const auditSkillId = loopSpec.audit!;
    const auditSkill = config.manifest.skills[auditSkillId];
    if (!auditSkill) {
      throw new Error(`Audit skill '${auditSkillId}' not found in manifest`);
    }
    const runner = runners[auditSkillId];
    if (!runner) {
      throw new Error(`No runner resolved for audit skill '${auditSkillId}'`);
    }

    renderPanel(
      { skillId: auditSkillId, agent: runner.agent, model: runner.model },
      iteration + 1,
      `Running audit for version ${N}...`
    );

    let continuity: { mode: 'fresh' | 'resumed'; sessionId?: string } | undefined = undefined;

    if (options.auditContinuity === 'codex-resume' && runner.agent === 'codex' && !isSecondOpinion) {
      const priorAudit = latestAuditStep();
      const hasApprovedPriorAudit = priorAudit?.verdict === 'APPROVED';
      const isFirstAuditOfChain = (N === 1 && options.startPoint !== 'resume') || options.startPoint === 'new-round' || isSecondOpinion || hasApprovedPriorAudit;

      if (isFirstAuditOfChain) {
        continuity = { mode: 'fresh' };
      } else {
        let priorSessionId: string | 'none' = 'none';
        for (let i = steps.length - 1; i >= 0; i--) {
          const s = steps[i]!;
          if (s.kind === 'audit' && s.agent === 'codex' && s.sessionId && s.sessionId !== 'none') {
            priorSessionId = s.sessionId;
            break;
          }
        }
        if (priorSessionId === 'none') {
          throw new Error('Error: --codex-audit-continuity is enabled but no prior Codex session ID was found in loop history.');
        }
        continuity = { mode: 'resumed', sessionId: priorSessionId };
      }
    }

    const prompt = preparePrompt(auditSkillId, auditSkill, N, runner, 'audit');
    const { result, durationMs } = await runAdapter(
      runner,
      prompt,
      `Spawning ${runner.agent} for audit v${N}...`,
      'audit',
      auditSkillId,
      N,
      iteration + 1,
      continuity
    );

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

    options.output.stepSucceeded({
      kind: 'audit',
      skillId: auditSkillId,
      version: N,
      message: `Audit execution completed`
    });

    // Retrieve written audit file
    const relOutputPath = renderPattern(loopSpec.auditPattern!, { n: N, agent: runner.agent });
    const absOutputPath = resolve(projectRoot, relOutputPath);

    let fileContent: string | null = null;
    if (existsSync(absOutputPath)) {
      fileContent = readFileSync(absOutputPath, 'utf-8');
    }

    const verdict = parseVerdict(fileContent, result.stdout);
    iteration++;

    if (verdict === 'unknown') {
      renderPanel(null, iteration + 1, chalk.red(`Terminal: unknown verdict on version ${N}`));
      const errMessage = `Audit failed to write a valid verdict. Output file path: ${relOutputPath}. Process output: ${result.stdout}`;
      return emitFinalSummary(false, 'unknown', errMessage, lastAuditPath);
    }

    // Write provenance stamp to audit file
    if (fileContent !== null) {
      const mode = continuity?.mode ?? 'none';
      const sid = continuity ? (result.sessionId ?? 'none') : 'none';
      writeArtifactWithMeta(absOutputPath, fileContent, buildStepMeta(auditSkillId, auditSkill, 'audit', N, runner, durationMs, mode, sid));
    }

    lastAuditPath = absOutputPath;
    steps.push({
      kind: 'audit', role: auditSkill.role, agent: runner.agent, model: runner.model,
      version: N, status: 'done', verdict,
      artifactPath: absOutputPath, mtime: Date.now(), durationMs,
      sessionMode: continuity?.mode ?? 'none',
      sessionId: continuity ? (result.sessionId ?? 'none') : 'none'
    });

    renderPanel(null, iteration, `Completed iteration ${iteration} with verdict: ${verdict}`);

    if (verdict === 'APPROVED') {
      if (options.interactive) {
        const selectableAgents = [...options.registry.adapters.keys()]
          .filter((agent) => agent in config.registry.providers);
        const alternativeAgents = selectableAgents.filter((agent) => agent !== runner.agent);
        const hasAlternative = alternativeAgents.length > 0;

        let allowedActions: ('stop' | 'run-second-opinion' | 'implement')[] = [];
        if (loopName === 'plan') {
          allowedActions = hasAlternative
            ? ['stop', 'run-second-opinion', 'implement']
            : ['stop', 'implement'];
        } else {
          allowedActions = hasAlternative
            ? ['stop', 'run-second-opinion']
            : ['stop'];
        }

        const choice = await promptSecondOpinionDecision(allowedActions);
        if (choice === 'stop') {
          return emitFinalSummary(true, 'APPROVED', `awaiting your review: ${relOutputPath}`, lastAuditPath);
        } else if (choice === 'implement') {
          const implementLoopSpec = config.manifest.loops['implement'];
          if (!implementLoopSpec) {
            throw new Error("Loop 'implement' not found in manifest");
          }
          const implementSkills = implementLoopSpec.implement ? [implementLoopSpec.implement] : [];
          const implementRunners: Record<string, Runner> = {};
          const prompted = await promptRunners(implementSkills, config, options.registry, options.globalOverrides);
          Object.assign(implementRunners, prompted);
          return runLoop(projectRoot, 'implement', implementLoopSpec, config, implementRunners, {
            ...options,
            startPoint: undefined
          });
        } else {
          // run-second-opinion
          const newRunner = await promptSecondOpinionRunner(runner.agent, config, options.registry);
          runners[auditSkillId] = newRunner;
          N = N + 1;
          pendingFollowUp = false;
          isSecondOpinion = true;
          continue;
        }
      } else {
        // Non-interactive stops immediately on APPROVED
        return emitFinalSummary(true, 'APPROVED', `awaiting your review: ${relOutputPath}`, lastAuditPath);
      }
    } else {
      // REJECTED
      pendingFollowUp = true;
      N = N + 1;
    }
  }

  // Hit max iterations
  return emitFinalSummary(false, 'REJECTED', `hit max-iterations, awaiting human`, lastAuditPath);
}
