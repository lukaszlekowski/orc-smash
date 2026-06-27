import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import ora from 'ora';
import chalk from 'chalk';
import { scan, parseOutcome, type Step, type StepStatus } from './state.js';
import { getAdapter } from './adapters/types.js';
import { composePrompt } from './prompt-composer.js';
import { writeArtifactWithMeta, type ArtifactMeta } from './provenance.js';
import { parseVerdict } from './verdict.js';
import { renderStatusPanel } from './status.js';
import { promptSecondOpinionDecision, promptSecondOpinionRunner } from './interactive.js';
import { structuredMessage } from './adapters/errors.js';
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
          timeline: steps,
          nextStepMessage: `Executing follow-up on version ${N - 1} rejection...`
        })
      );

      const roleFile = config.manifest.roles[followUpSkill.role];
      if (!roleFile) {
        throw new Error(`Role file '${followUpSkill.role}' not found in roles list`);
      }

      const priorAuditPath = latestAuditStep()?.artifactPath ?? null;
      const followUpVersion = N - 1;
      const prompt = composePrompt(
        followUpSkillId,
        roleFile,
        followUpSkill.file,
        loopSpec,
        {
          targetRoot: projectRoot,
          version: followUpVersion,
          priorAuditPath,
          agentName: runner.agent,
          kind: 'follow-up'
        }
      );

      const adapter = getAdapter(runner.agent);
      const spinner = ora(chalk.blue(`Spawning ${runner.agent} for follow-up...`)).start();

      const result = await adapter.run({
        prompt,
        model: runner.model,
        cwd: projectRoot
      });

      if (result.error || result.exitCode !== 0) {
        spinner.fail(`Follow-up ${result.error?.kind ?? 'failed'}`);
        return {
          success: false,
          verdict: 'unknown',
          message: structuredMessage(result, { label: 'Follow-up', model: runner.model }),
          lastAuditPath
        };
      }

      const relFollowUpPath = loopSpec.followUpPattern
        .replace('{n}', String(followUpVersion))
        .replace('{agent}', runner.agent);
      const absFollowUpPath = resolve(projectRoot, relFollowUpPath);
      const followUpStatus: StepStatus = (result.error || result.exitCode !== 0) ? 'failed' : 'done';
      let followUpOutcome: 'patched' | 'blocked' = 'patched';
      if (existsSync(absFollowUpPath)) {
        const body = readFileSync(absFollowUpPath, 'utf-8');
        followUpOutcome = parseOutcome(body);   // single parser shared with scan — no inline regex (m2)
        const meta: ArtifactMeta = {
          loop: loopName, skill: followUpSkillId, kind: 'follow-up', role: followUpSkill.role,
          version: followUpVersion, agent: runner.agent, model: runner.model,
          target: loopSpec.target,
          priorAudit: priorAuditRel(projectRoot, latestAuditStep()?.artifactPath),  // relativized (m5)
          timestamp: new Date().toISOString()
        };
        writeArtifactWithMeta(absFollowUpPath, body, meta);
      }
      steps.push({
        kind: 'follow-up', role: followUpSkill.role, agent: runner.agent, model: runner.model,
        version: followUpVersion, status: followUpStatus, outcome: followUpOutcome,
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

    // Display Status
    console.clear();
    console.log(
      renderStatusPanel({
        projectRoot,
        loopName,
        currentIteration: iteration,
        maxIterations: options.maxIterations,
        activeSkillRunner: { skillId: auditSkillId, agent: runner.agent, model: runner.model },
        timeline: steps,
        nextStepMessage: `Running audit for version ${N}...`
      })
    );

    const roleFile = config.manifest.roles[auditSkill.role];
    if (!roleFile) {
      throw new Error(`Role file '${auditSkill.role}' not found in roles list`);
    }

    const priorAuditPath = latestAuditStep()?.artifactPath ?? null;
    const prompt = composePrompt(
      auditSkillId,
      roleFile,
      auditSkill.file,
      loopSpec,
      {
        targetRoot: projectRoot,
        version: N,
        priorAuditPath,
        agentName: runner.agent,
        kind: 'audit'
      }
    );

    const adapter = getAdapter(runner.agent);
    const spinner = ora(chalk.blue(`Spawning ${runner.agent} for audit v${N}...`)).start();

    const result = await adapter.run({
      prompt,
      model: runner.model,
      cwd: projectRoot
    });

    if (result.error) {
      spinner.fail(`Audit ${result.error.kind}`);
      return {
        success: false,
        verdict: 'unknown',
        message: structuredMessage(result, { label: 'Audit', model: runner.model }),
        lastAuditPath
      };
    }

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
          timeline: steps,
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
      const meta: ArtifactMeta = {
        loop: loopName, skill: auditSkillId, kind: 'audit', role: auditSkill.role,
        version: N, agent: runner.agent, model: runner.model,
        target: loopSpec.target,
        priorAudit: priorAuditRel(projectRoot, latestAuditStep()?.artifactPath),  // relativized (m5)
        timestamp: new Date().toISOString()
      };
      writeArtifactWithMeta(absOutputPath, fileContent, meta);
    }

    lastAuditPath = absOutputPath;
    steps.push({
      kind: 'audit', role: auditSkill.role, agent: runner.agent, model: runner.model,
      version: N, status: 'done', verdict,
      artifactPath: absOutputPath, mtime: Date.now()
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
        timeline: steps,
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
