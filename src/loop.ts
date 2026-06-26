import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { scan, type HistoryEntry } from './state.js';
import { getAdapter } from './adapters/types.js';
import { composePrompt } from './prompt-composer.js';
import { stampProvenance } from './provenance.js';
import { parseVerdict } from './verdict.js';
import { renderStatusPanel } from './status.js';
import { promptSecondOpinionDecision, promptSecondOpinionRunner } from './interactive.js';
import type { Config } from './config.js';
import type { LoopSpec } from './manifest.js';

export interface LoopOptions {
  maxIterations: number;
  startPoint: 'fresh' | 'resume' | 'new-round';
  globalOverrides?: { agent?: string; model?: string };
  interactive?: boolean;
}

export async function runLoop(
  projectRoot: string,
  loopName: string,
  loopSpec: LoopSpec,
  config: Config,
  runners: Record<string, { agent: string; model: string }>,
  options: LoopOptions
): Promise<{ success: boolean; verdict: string; message: string; lastAuditPath: string | null }> {
  // 1. Initial State scan
  const initialScan = scan(projectRoot, loopSpec.auditPattern);
  if (initialScan.latestVerdict === 'unknown' && initialScan.history.length > 0) {
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

  const history = [...initialScan.history];
  let iteration = 0;
  let lastAuditPath: string | null = history[history.length - 1]?.filePath || null;

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

      // Display Status
      console.clear();
      console.log(
        renderStatusPanel({
          projectRoot,
          loopName,
          currentIteration: iteration,
          maxIterations: options.maxIterations,
          activeSkillRunner: { skillId: followUpSkillId, agent: runner.agent, model: runner.model },
          history,
          nextStepMessage: `Executing follow-up on version ${N - 1} rejection...`
        })
      );

      const roleFile = config.manifest.roles[followUpSkill.role];
      if (!roleFile) {
        throw new Error(`Role file '${followUpSkill.role}' not found in roles list`);
      }

      const priorAuditPath = history[history.length - 1]?.filePath || null;
      const prompt = composePrompt(
        followUpSkillId,
        roleFile,
        followUpSkill.file,
        loopSpec,
        {
          targetRoot: projectRoot,
          version: N,
          priorAuditPath,
          agentName: runner.agent
        }
      );

      const adapter = getAdapter(runner.agent);
      const spinner = ora(chalk.blue(`Spawning ${runner.agent} for follow-up...`)).start();

      const result = await adapter.run({
        prompt,
        model: runner.model,
        cwd: projectRoot
      });

      if (result.exitCode !== 0) {
        spinner.fail(`Follow-up execution failed with exit code ${result.exitCode}`);
        return {
          success: false,
          verdict: 'unknown',
          message: `Follow-up failed with exit code ${result.exitCode}. Output: ${result.stdout}`,
          lastAuditPath
        };
      }

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

    // Display Status
    console.clear();
    console.log(
      renderStatusPanel({
        projectRoot,
        loopName,
        currentIteration: iteration,
        maxIterations: options.maxIterations,
        activeSkillRunner: { skillId: auditSkillId, agent: runner.agent, model: runner.model },
        history,
        nextStepMessage: `Running audit for version ${N}...`
      })
    );

    const roleFile = config.manifest.roles[auditSkill.role];
    if (!roleFile) {
      throw new Error(`Role file '${auditSkill.role}' not found in roles list`);
    }

    const priorAuditPath = history[history.length - 1]?.filePath || null;
    const prompt = composePrompt(
      auditSkillId,
      roleFile,
      auditSkill.file,
      loopSpec,
      {
        targetRoot: projectRoot,
        version: N,
        priorAuditPath,
        agentName: runner.agent
      }
    );

    const adapter = getAdapter(runner.agent);
    const spinner = ora(chalk.blue(`Spawning ${runner.agent} for audit v${N}...`)).start();

    const result = await adapter.run({
      prompt,
      model: runner.model,
      cwd: projectRoot
    });

    spinner.succeed(`Audit execution completed`);

    // Retrieve written audit file
    const relOutputPath = loopSpec.auditPattern
      .replace('{n}', String(N))
      .replace('{agent}', runner.agent);
    const absOutputPath = resolve(projectRoot, relOutputPath);

    let fileContent: string | null = null;
    if (existsSync(absOutputPath)) {
      fileContent = readFileSync(absOutputPath, 'utf-8');
    }

    const verdict = parseVerdict(fileContent, result.stdout);
    iteration++;

    if (verdict === 'unknown') {
      console.clear();
      console.log(
        renderStatusPanel({
          projectRoot,
          loopName,
          currentIteration: iteration,
          maxIterations: options.maxIterations,
          activeSkillRunner: null,
          history,
          nextStepMessage: chalk.red(`Terminal: unknown verdict on version ${N}`)
        })
      );
      return {
        success: false,
        verdict: 'unknown',
        message: `Audit failed to write a valid verdict. Output file path: ${relOutputPath}. Process output: ${result.stdout}`,
        lastAuditPath
      };
    }

    // Write provenance stamp to audit file
    if (fileContent !== null) {
      const stamp = stampProvenance(runner.agent, runner.model, N);
      writeFileSync(absOutputPath, fileContent + stamp);
    }

    lastAuditPath = absOutputPath;
    history.push({
      version: N,
      agent: runner.agent,
      model: runner.model,
      verdict,
      filePath: absOutputPath,
      mtime: Date.now()
    });

    // Display Updated Status
    console.clear();
    console.log(
      renderStatusPanel({
        projectRoot,
        loopName,
        currentIteration: iteration,
        maxIterations: options.maxIterations,
        activeSkillRunner: null,
        history,
        nextStepMessage: `Completed iteration ${iteration} with verdict: ${verdict}`
      })
    );

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
