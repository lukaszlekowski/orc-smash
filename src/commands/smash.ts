import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { scan, resolveImplementFacts, requireApprovedPlanAuditPath } from '../state.js';
import { runLoop } from '../loop.js';
import { validateAgentAndModel } from '../runner.js';
import { resolveNextStep, allowedStartPoint } from '../next-step.js';
import {
  promptLoopSelect,
  promptStartPoint,
  promptRunners,
  promptMaxIterations
} from '../interactive.js';
import { createProductionAdapterRegistry, type AgentRegistry } from '../adapters/registry.js';
import type { CliOutput } from '../cli-output.js';
import type { CommandResult } from './types.js';
import type { LoopSpec } from '../manifest.js';

export interface SmashOptions {
  project?: string;
  loop?: string;
  agent?: string;
  model?: string;
  maxIterations?: string;
  output: CliOutput;
  plain?: boolean;
}

interface SmashRunSetup {
  projectRoot: string;
  loopName: string;
  loopSpec: LoopSpec;
  config: Config;
  runners: Record<string, { agent: string; model: string }>;
  maxIterations: number;
  startPoint?: 'fresh' | 'resume' | 'new-round';
  globalOverrides: { agent?: string; model?: string };
  isInteractive: boolean;
  registry: AgentRegistry;
}

async function resolveSmashRunSetup(
  projectRoot: string,
  options: SmashOptions
): Promise<{ errorResult: CommandResult } | { setup: SmashRunSetup }> {
  let config: Config;
  try {
    config = loadConfig(projectRoot);
  } catch (err: any) {
    const msg = `Error: failed to load config or manifest: ${err.message}`;
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

  const loopKeys = Object.keys(config.manifest.loops);
  if (loopKeys.length === 0) {
    const msg = 'Error: no loops defined in manifest.';
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

  const registry = createProductionAdapterRegistry();

  // 1. Loop selection
  let loopName = options.loop;
  const isInteractive = !options.loop;

  if (isInteractive) {
    let defaultLoop = 'plan';
    const planSpec = config.manifest.loops['plan'];
    const implementSpec = config.manifest.loops['implement'];
    if (planSpec && implementSpec) {
      const { approvedPlanAuditPath, currentPlanImplemented } = resolveImplementFacts(
        projectRoot,
        {
          auditPattern: planSpec.auditPattern ?? '',
          followUpPattern: planSpec.followUpPattern ?? ''
        },
        {
          implementPattern: implementSpec.implementPattern ?? ''
        }
      );
      if (currentPlanImplemented) {
        defaultLoop = 'review';
      } else if (approvedPlanAuditPath !== null) {
        defaultLoop = 'implement';
      } else {
        defaultLoop = 'plan';
      }
    } else {
      let defaultLoopCandidate = loopKeys[0] || 'plan';
      for (const key of loopKeys) {
        const spec = config.manifest.loops[key]!;
        const stateScan = scan(projectRoot, { auditPattern: spec.auditPattern || '', followUpPattern: spec.followUpPattern || '' });
        if (stateScan.auditSteps.length > 0) {
          defaultLoopCandidate = key;
          break;
        }
      }
      defaultLoop = defaultLoopCandidate;
    }
    loopName = await promptLoopSelect(loopKeys, defaultLoop);
  }

  if (!loopName || !config.manifest.loops[loopName]) {
    const msg = `Error: loop '${loopName}' not found in manifest.`;
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

  const loopSpec = config.manifest.loops[loopName]!;

  // 2. Scan state & 3. Start Point selection & validation
  let startPoint: 'fresh' | 'resume' | 'new-round' | undefined = undefined;

  if (loopSpec.kind === 'implement') {
    try {
      const planSpec = config.manifest.loops['plan'];
      if (!planSpec) {
        throw new Error("Loop 'plan' not found in manifest");
      }
      requireApprovedPlanAuditPath(projectRoot, {
        auditPattern: planSpec.auditPattern ?? '',
        followUpPattern: planSpec.followUpPattern ?? ''
      });
    } catch (err: any) {
      const msg = `Error: ${err.message}`;
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
  } else {
    const stateScan = scan(projectRoot, { auditPattern: loopSpec.auditPattern!, followUpPattern: loopSpec.followUpPattern! });
    if (stateScan.latestVerdict === 'unknown' && stateScan.auditSteps.length > 0) {
      const msg = 'latest audit is unparseable; resolve or delete it before smashing';
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }

    const decision = resolveNextStep({
      latestVerdict: stateScan.latestVerdict,
      latestVersion: stateScan.latestVersion,
      hasAudits: stateScan.auditSteps.length > 0,
      latestAuditPath: stateScan.auditSteps[stateScan.auditSteps.length - 1]?.artifactPath ?? null
    });
    const allowed = allowedStartPoint(decision);

    if (isInteractive) {
      const allowedList: string[] = allowed ? [allowed] : [];
      const defaultSP = allowed ?? 'fresh';
      const sp = await promptStartPoint(allowedList, defaultSP);
      startPoint = sp as any;
    } else {
      startPoint = allowed ?? 'fresh';
    }

    const latestVerdict = stateScan.latestVerdict;
    if (startPoint !== allowed) {
      const msg = `Error: start-point '${startPoint}' is invalid for latest verdict ${latestVerdict || 'null'}`;
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
  }

  // 4. Runners selection & validation
  const loopSkills = loopSpec.kind === 'implement'
    ? (loopSpec.implement ? [loopSpec.implement] : [])
    : [loopSpec.audit, loopSpec['follow-up']].filter((s): s is string => !!s);
  const runners: Record<string, { agent: string; model: string }> = {};

  const globalOverrides = {
    agent: options.agent,
    model: options.model
  };

  if (globalOverrides.agent || globalOverrides.model) {
    try {
      const resolvedAgent = globalOverrides.agent || config.registry.defaults.agent;
      const resolvedModel = globalOverrides.model || config.registry.providers[resolvedAgent]?.[0] || config.registry.defaults.model;
      validateAgentAndModel(resolvedAgent, resolvedModel, config.registry);
    } catch (err: any) {
      const msg = `Error: ${err.message}`;
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
  }

  if (isInteractive) {
    const promptedRunners = await promptRunners(loopSkills, config, registry, globalOverrides);
    Object.assign(runners, promptedRunners);
  } else {
    for (const skillId of loopSkills) {
      const skill = config.manifest.skills[skillId];
      if (!skill) continue;

      let resolvedAgent = skill.agent;
      let resolvedModel = skill.model;

      if (globalOverrides.agent) {
        resolvedAgent = globalOverrides.agent;
        resolvedModel = globalOverrides.model || config.registry.providers[resolvedAgent]?.[0] || config.registry.defaults.model;
      }

      try {
        validateAgentAndModel(resolvedAgent, resolvedModel, config.registry);
      } catch (err: any) {
        const msg = `Error: ${err.message}`;
        options.output.error(msg);
        return { errorResult: { exitCode: 1, message: msg } };
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
      const msg = 'Error: max-iterations must be a positive integer.';
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
  }

  return {
    setup: {
      projectRoot,
      loopName,
      loopSpec,
      config,
      runners,
      maxIterations,
      startPoint,
      globalOverrides,
      isInteractive,
      registry
    }
  };
}

export async function smashAction(options: SmashOptions): Promise<CommandResult> {
  if (!options.project) {
    const msg = 'Error: project path is required. Use --project <path>';
    options.output.error(msg);
    return { exitCode: 1, message: msg };
  }

  const projectRoot = resolve(options.project);
  const setupResult = await resolveSmashRunSetup(projectRoot, options);
  if ('errorResult' in setupResult) {
    return setupResult.errorResult;
  }

  const { setup } = setupResult;

  try {
    const result = await runLoop(projectRoot, setup.loopName, setup.loopSpec, setup.config, setup.runners, {
      maxIterations: setup.maxIterations,
      startPoint: setup.startPoint,
      globalOverrides: setup.globalOverrides,
      interactive: setup.isInteractive,
      registry: setup.registry,
      output: options.output
    });

    if (result.success) {
      return { exitCode: 0, message: result.message };
    } else {
      return { exitCode: result.verdict === 'unknown' ? 1 : 0, message: result.message };
    }
  } catch (err: any) {
    const msg = `Error running loop: ${err.message}`;
    options.output.error(msg);
    return { exitCode: 1, message: msg };
  }
}
