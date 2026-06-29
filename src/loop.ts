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
import { buildPanelContext } from './status.js';
import { promptSecondOpinionDecision, promptSecondOpinionRunner, promptContinueToReview, promptRunners } from './interactive.js';
import { structuredMessage } from './adapters/errors.js';
import type { Config } from './config.js';
import type { LoopSpec, SkillSpec } from './manifest.js';
import type { CliOutput } from './cli-output.js';
import { resolveRunner } from './runner.js';

export interface LoopOptions {
  maxIterations: number;
  startPoint?: 'fresh' | 'resume' | 'new-round';
  globalOverrides?: { agent?: string; model?: string };
  interactive?: boolean;
  registry: AgentRegistry;
  output: CliOutput;
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
  const steps: Step[] = [];

  const priorAuditRel = (root: string, p: string | null | undefined): string =>
    p ? (p.startsWith(root) ? relative(root, p) : p) : 'none';

  const renderPanel = (
    active: { skillId: string; agent: string; model: string } | null,
    currentIteration: number,
    message: string
  ) => {
    options.output.renderPanel(
      buildPanelContext(
        projectRoot,
        loopName,
        currentIteration,
        options.maxIterations,
        active,
        steps,
        message
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
    currentIteration: number
  ) => {
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
    const result = await adapter.run({ prompt, model: runner.model, cwd: projectRoot });
    return result;
  };

  const stepFailed = (result: RunResult, acceptNonzeroExitWithVerdict: boolean): boolean =>
    Boolean(result.error) || (!acceptNonzeroExitWithVerdict && result.exitCode !== 0);

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
      0,
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

    const result = await runAdapter(
      runner,
      prompt,
      `Spawning ${runner.agent} for implementation...`,
      'implement',
      implementSkillId,
      nextVersion,
      0
    );

    if (stepFailed(result, false)) {
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

    options.output.stepSucceeded({
      kind: 'implement',
      skillId: implementSkillId,
      version: nextVersion,
      message: `Implementation execution completed`
    });

    const relOutputPath = renderPattern(loopSpec.implementPattern!, { n: nextVersion, agent: runner.agent });
    const absOutputPath = resolve(projectRoot, relOutputPath);

    if (!existsSync(absOutputPath)) {
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation failed: missing expected output ledger at ${relOutputPath}`,
        errorKind: 'missing_output'
      });
      return emitFinalSummary(false, 'unknown', `Missing expected output ledger file at ${relOutputPath}`, null);
    }
    const ledgerContent = readFileSync(absOutputPath, 'utf-8');
    if (!ledgerContent.trim()) {
      options.output.stepFailed({
        kind: 'implement',
        skillId: implementSkillId,
        version: nextVersion,
        message: `Implementation failed: empty expected output ledger at ${relOutputPath}`,
        errorKind: 'empty_output'
      });
      return emitFinalSummary(false, 'unknown', `Empty expected output ledger file at ${relOutputPath}`, null);
    }

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
      timestamp: new Date().toISOString()
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
      mtime: Date.now()
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

  const buildStepMeta = (skillId: string, skill: SkillSpec, kind: StepKind, version: number, runner: Runner): ArtifactMeta => ({
    loop: loopName,
    skill: skillId,
    kind,
    role: skill.role,
    version,
    agent: runner.agent,
    model: runner.model,
    target: loopSpec.target,
    priorAudit: priorAuditRel(projectRoot, latestAuditStep()?.artifactPath),
    timestamp: new Date().toISOString()
  });

  while (iteration < options.maxIterations) {
    options.output.iterationStarted({ iteration, maxIterations: options.maxIterations });

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
        iteration,
        `Executing follow-up on version ${N - 1} rejection...`
      );

      const prompt = preparePrompt(followUpSkillId, followUpSkill, followUpVersion, runner, 'follow-up');
      const result = await runAdapter(
        runner,
        prompt,
        `Spawning ${runner.agent} for follow-up...`,
        'follow-up',
        followUpSkillId,
        followUpVersion,
        iteration
      );

      if (stepFailed(result, false)) {
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
        writeArtifactWithMeta(absFollowUpPath, body, buildStepMeta(followUpSkillId, followUpSkill, 'follow-up', followUpVersion, runner));
      }
      steps.push({
        kind: 'follow-up', role: followUpSkill.role, agent: runner.agent, model: runner.model,
        version: followUpVersion, status: 'done', outcome: followUpOutcome,
        artifactPath: absFollowUpPath, mtime: Date.now()
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
      iteration,
      `Running audit for version ${N}...`
    );

    const prompt = preparePrompt(auditSkillId, auditSkill, N, runner, 'audit');
    const result = await runAdapter(
      runner,
      prompt,
      `Spawning ${runner.agent} for audit v${N}...`,
      'audit',
      auditSkillId,
      N,
      iteration
    );

    if (stepFailed(result, true)) {
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
      renderPanel(null, iteration, chalk.red(`Terminal: unknown verdict on version ${N}`));
      const errMessage = `Audit failed to write a valid verdict. Output file path: ${relOutputPath}. Process output: ${result.stdout}`;
      return emitFinalSummary(false, 'unknown', errMessage, lastAuditPath);
    }

    // Write provenance stamp to audit file
    if (fileContent !== null) {
      writeArtifactWithMeta(absOutputPath, fileContent, buildStepMeta(auditSkillId, auditSkill, 'audit', N, runner));
    }

    lastAuditPath = absOutputPath;
    steps.push({
      kind: 'audit', role: auditSkill.role, agent: runner.agent, model: runner.model,
      version: N, status: 'done', verdict,
      artifactPath: absOutputPath, mtime: Date.now()
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
