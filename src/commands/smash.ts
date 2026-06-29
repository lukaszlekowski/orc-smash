import { resolve } from 'node:path';
import chalk from 'chalk';
import { loadConfig } from '../config.js';
import { scan } from '../state.js';
import { runLoop } from '../loop.js';
import { validateAgentAndModel } from '../runner.js';
import { resolveNextStep, allowedStartPoint } from '../next-step.js';
import {
  promptLoopSelect,
  promptStartPoint,
  promptRunners,
  promptMaxIterations
} from '../interactive.js';

export interface SmashOptions {
  project?: string;
  loop?: string;
  agent?: string;
  model?: string;
  maxIterations?: string;
}

export async function smashAction(options: SmashOptions): Promise<void> {
  if (!options.project) {
    console.error(chalk.red('Error: project path is required. Use --project <path>'));
    process.exit(1);
  }

  const projectRoot = resolve(options.project);
  let config: any;
  try {
    config = loadConfig(projectRoot);
  } catch (err: any) {
    console.error(chalk.red(`Error: failed to load config or manifest: ${err.message}`));
    process.exit(1);
  }

  const loopKeys = Object.keys(config.manifest.loops);
  if (loopKeys.length === 0) {
    console.error(chalk.red('Error: no loops defined in manifest.'));
    process.exit(1);
  }

  // 1. Loop selection
  let loopName = options.loop;
  const isInteractive = !options.loop;

  if (isInteractive) {
    let defaultLoop = loopKeys[0] || 'plan';
    for (const key of loopKeys) {
      const spec = config.manifest.loops[key]!;
      const stateScan = scan(projectRoot, { auditPattern: spec.auditPattern, followUpPattern: spec.followUpPattern });
      if (stateScan.auditSteps.length > 0) {
        defaultLoop = key;
        break;
      }
    }
    loopName = await promptLoopSelect(loopKeys, defaultLoop);
  }

  if (!loopName || !config.manifest.loops[loopName]) {
    console.error(chalk.red(`Error: loop '${loopName}' not found in manifest.`));
    process.exit(1);
  }

  const loopSpec = config.manifest.loops[loopName]!;

  // 2. Scan state
  const stateScan = scan(projectRoot, { auditPattern: loopSpec.auditPattern, followUpPattern: loopSpec.followUpPattern });
  if (stateScan.latestVerdict === 'unknown' && stateScan.auditSteps.length > 0) {
    console.error(chalk.red(`latest audit is unparseable; resolve or delete it before smashing`));
    process.exit(1);
  }

  // 3. Start Point selection & validation — driven by the canonical next-step rule
  // (resolveNextStep + allowedStartPoint), so the command cannot re-derive
  // verdict-to-start-point policy inline.
  const decision = resolveNextStep({
    latestVerdict: stateScan.latestVerdict,
    latestVersion: stateScan.latestVersion,
    hasAudits: stateScan.auditSteps.length > 0,
    latestAuditPath: stateScan.auditSteps[stateScan.auditSteps.length - 1]?.artifactPath ?? null
  });
  const allowed = allowedStartPoint(decision); // the single valid start point for this state, or null

  let startPoint: 'fresh' | 'resume' | 'new-round' = 'fresh';

  if (isInteractive) {
    const allowedList: string[] = allowed ? [allowed] : [];
    const defaultSP = allowed ?? 'fresh';
    const sp = await promptStartPoint(allowedList, defaultSP);
    startPoint = sp as any;
  } else {
    // Non-interactive start point determination
    startPoint = allowed ?? 'fresh';
  }

  // Validate the chosen start point against the canonical rule for this state.
  const latestVerdict = stateScan.latestVerdict;
  if (startPoint !== allowed) {
    console.error(chalk.red(`Error: start-point '${startPoint}' is invalid for latest verdict ${latestVerdict || 'null'}`));
    process.exit(1);
  }

  // 4. Runners selection & validation
  const loopSkills = [loopSpec.audit, loopSpec['follow-up']];
  const runners: Record<string, { agent: string; model: string }> = {};

  const globalOverrides = {
    agent: options.agent,
    model: options.model
  };

  // Validate global flags if provided
  if (globalOverrides.agent || globalOverrides.model) {
    try {
      const resolvedAgent = globalOverrides.agent || config.defaultAgent;
      const resolvedModel = globalOverrides.model || config.agentDefaultModels[resolvedAgent] || config.defaultModel;
      validateAgentAndModel(resolvedAgent, resolvedModel);
    } catch (err: any) {
      console.error(chalk.red(`Error: ${err.message}`));
      process.exit(1);
    }
  }

  if (isInteractive) {
    const promptedRunners = await promptRunners(loopSkills, config, globalOverrides);
    Object.assign(runners, promptedRunners);
  } else {
    for (const skillId of loopSkills) {
      const skill = config.manifest.skills[skillId];
      if (!skill) continue;
      
      let resolvedAgent = skill.agent;
      let resolvedModel = skill.model;

      if (globalOverrides.agent) {
        resolvedAgent = globalOverrides.agent;
        resolvedModel = globalOverrides.model || config.agentDefaultModels[resolvedAgent] || config.defaultModel;
      }

      try {
        validateAgentAndModel(resolvedAgent, resolvedModel);
      } catch (err: any) {
        console.error(chalk.red(`Error: ${err.message}`));
        process.exit(1);
      }

      runners[skillId] = { agent: resolvedAgent, model: resolvedModel };
    }
  }

  // 5. Max iterations
  let maxIterations = 5;
  if (isInteractive) {
    maxIterations = await promptMaxIterations(5);
  } else if (options.maxIterations) {
    maxIterations = parseInt(options.maxIterations, 10);
    if (isNaN(maxIterations) || maxIterations <= 0) {
      console.error(chalk.red('Error: max-iterations must be a positive integer.'));
      process.exit(1);
    }
  }

  // 6. Run the loop
  try {
    const result = await runLoop(projectRoot, loopName, loopSpec, config, runners, {
      maxIterations,
      startPoint,
      globalOverrides,
      interactive: isInteractive
    });

    if (result.success) {
      console.log(chalk.bold.green(`\nSuccess: ${result.message}`));
      process.exit(0);
    } else {
      console.log(chalk.bold.red(`\nLoop terminated: ${result.message}`));
      process.exit(result.verdict === 'unknown' ? 1 : 0);
    }
  } catch (err: any) {
    console.error(chalk.bold.red(`\nExecution Error: ${err.message}`));
    process.exit(1);
  }
}
