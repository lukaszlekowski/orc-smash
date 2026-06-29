import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { scan, parseOutcome, type Step } from './state.js';
import { getAdapter, type RunResult } from './adapters/types.js';
import { renderPattern } from './patterns.js';
import { composePrompt } from './prompt-composer.js';
import { writeArtifactWithMeta, type ArtifactMeta, type StepKind } from './provenance.js';
import { parseVerdict } from './verdict.js';
import { renderStatusPanel } from './status.js';
import { promptSecondOpinionDecision, promptSecondOpinionRunner } from './interactive.js';
import { structuredMessage } from './adapters/errors.js';
import type { Config } from './config.js';
import type { LoopSpec, SkillSpec } from './manifest.js';

export interface LoopOptions {
  maxIterations: number;
  startPoint: 'fresh' | 'resume' | 'new-round';
  globalOverrides?: { agent?: string; model?: string };
  interactive?: boolean;
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
  // 1. Initial State scan
  const initialScan = scan(projectRoot, { auditPattern: loopSpec.auditPattern, followUpPattern: loopSpec.followUpPattern });
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

  const steps: Step[] = [...initialScan.timeline];
  let iteration = 0;
  let lastAuditPath: string | null = steps.filter(s => s.kind === 'audit').pop()?.artifactPath ?? null;

  const latestAuditStep = () => steps.filter(s => s.kind === 'audit').pop() ?? null;
  /** Relativize an artifact path to projectRoot for portable front matter (m5).
   *  Mirrors resolveInput's priorAudit logic in prompt-composer.ts. */
  const priorAuditRel = (root: string, p: string | null | undefined): string =>
    p ? (p.startsWith(root) ? relative(root, p) : p) : 'none';

  // --- Loop-local responsibilities (Step 7): each helper owns one stable job.
  //     runLoop() below is orchestration only — no generic loop-helpers file. ---

  const renderPanel = (
    active: { skillId: string; agent: string; model: string } | null,
    currentIteration: number,
    message: string
  ) => {
    console.clear();
    console.log(
      renderStatusPanel({
        projectRoot,
        loopName,
        currentIteration,
        maxIterations: options.maxIterations,
        activeSkillRunner: active,
        timeline: steps,
        nextStepMessage: message
      })
    );
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

  const runAdapter = async (runner: Runner, prompt: string, spawnLabel: string) => {
    const adapter = getAdapter(runner.agent);
    const spinner = ora(chalk.blue(spawnLabel)).start();
    const result = await adapter.run({ prompt, model: runner.model, cwd: projectRoot });
    return { result, spinner };
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
    priorAudit: priorAuditRel(projectRoot, latestAuditStep()?.artifactPath),  // relativized (m5)
    timestamp: new Date().toISOString()
  });

  // Asymmetric failure predicate (Step 7.7/7.8): the audit step tolerates a
  // nonzero exit when there is no structured error — verdict parsing may still
  // succeed on partial output (codex/claude nonzero-exit-with-valid-verdict).
  // The follow-up step fails on any error OR nonzero exit. The asymmetry is
  // expressed explicitly via `acceptNonzeroExitWithVerdict`, not duplicated.
  const stepFailed = (result: RunResult, acceptNonzeroExitWithVerdict: boolean): boolean =>
    Boolean(result.error) || (!acceptNonzeroExitWithVerdict && result.exitCode !== 0);

  // Truncated/interrupted execution is terminal for both steps: branch ONLY on
  // the normalized `completion` field, never on the agent or raw stop reasons.
  const isNonCleanCompletion = (result: RunResult): boolean =>
    result.completion === 'truncated' || result.completion === 'interrupted';
  const completionMessage = (result: RunResult): string =>
    `Agent execution truncated or interrupted. Stop reason: ${result.stopReason}`;

  while (iteration < options.maxIterations) {
    // --- Step A: Follow-up ---
    if (pendingFollowUp) {
      const followUpSkillId = loopSpec['follow-up'];
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
      const { result, spinner } = await runAdapter(runner, prompt, `Spawning ${runner.agent} for follow-up...`);

      if (stepFailed(result, false)) {
        spinner.fail(`Follow-up ${result.error?.kind ?? 'failed'}`);
        return {
          success: false,
          verdict: 'unknown',
          message: structuredMessage(result, { label: 'Follow-up', model: runner.model, agent: runner.agent }),
          lastAuditPath
        };
      }
      if (isNonCleanCompletion(result)) {
        spinner.fail(`Follow-up truncated or interrupted`);
        return { success: false, verdict: 'unknown', message: completionMessage(result), lastAuditPath };
      }

      const relFollowUpPath = renderPattern(loopSpec.followUpPattern, { n: followUpVersion, agent: runner.agent });
      const absFollowUpPath = resolve(projectRoot, relFollowUpPath);
      let followUpOutcome: 'patched' | 'blocked' = 'patched';
      if (existsSync(absFollowUpPath)) {
        const body = readFileSync(absFollowUpPath, 'utf-8');
        followUpOutcome = parseOutcome(body);   // single parser shared with scan — no inline regex (m2)
        writeArtifactWithMeta(absFollowUpPath, body, buildStepMeta(followUpSkillId, followUpSkill, 'follow-up', followUpVersion, runner));
      }
      steps.push({
        kind: 'follow-up', role: followUpSkill.role, agent: runner.agent, model: runner.model,
        version: followUpVersion, status: 'done', outcome: followUpOutcome,
        artifactPath: absFollowUpPath, mtime: Date.now()
      });

      spinner.succeed(`Follow-up completed successfully`);
      pendingFollowUp = false;
    }

    // --- Step B: Audit ---
    const auditSkillId = loopSpec.audit;
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
    const { result, spinner } = await runAdapter(runner, prompt, `Spawning ${runner.agent} for audit v${N}...`);

    if (stepFailed(result, true)) {
      spinner.fail(`Audit ${result.error!.kind}`);
      return {
        success: false,
        verdict: 'unknown',
        message: structuredMessage(result, { label: 'Audit', model: runner.model, agent: runner.agent }),
        lastAuditPath
      };
    }
    if (isNonCleanCompletion(result)) {
      spinner.fail(`Audit truncated or interrupted`);
      return { success: false, verdict: 'unknown', message: completionMessage(result), lastAuditPath };
    }

    spinner.succeed(`Audit execution completed`);

    // Retrieve written audit file
    const relOutputPath = renderPattern(loopSpec.auditPattern, { n: N, agent: runner.agent });
    const absOutputPath = resolve(projectRoot, relOutputPath);

    let fileContent: string | null = null;
    if (existsSync(absOutputPath)) {
      fileContent = readFileSync(absOutputPath, 'utf-8');
    }

    const verdict = parseVerdict(fileContent, result.stdout);
    iteration++;

    if (verdict === 'unknown') {
      renderPanel(null, iteration, chalk.red(`Terminal: unknown verdict on version ${N}`));
      return {
        success: false,
        verdict: 'unknown',
        message: `Audit failed to write a valid verdict. Output file path: ${relOutputPath}. Process output: ${result.stdout}`,
        lastAuditPath
      };
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
        const choice = await promptSecondOpinionDecision();
        if (choice === 'stop') {
          return {
            success: true,
            verdict: 'APPROVED',
            message: `awaiting your review: ${relOutputPath}`,
            lastAuditPath
          };
        } else {
          // run-second-opinion
          const newRunner = await promptSecondOpinionRunner(runner.agent, config);
          runners[auditSkillId] = newRunner;
          N = N + 1;
          pendingFollowUp = false;
          continue;
        }
      } else {
        // Non-interactive stops immediately on APPROVED
        return {
          success: true,
          verdict: 'APPROVED',
          message: `awaiting your review: ${relOutputPath}`,
          lastAuditPath
        };
      }
    } else {
      // REJECTED
      pendingFollowUp = true;
      N = N + 1;
    }
  }

  // Hit max iterations
  return {
    success: false,
    verdict: 'REJECTED',
    message: `hit max-iterations, awaiting human`,
    lastAuditPath
  };
}
