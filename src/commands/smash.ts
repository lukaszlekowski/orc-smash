import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { scan, requireApprovedPlanAuditPath } from '../state.js';
import { runLoop } from '../loop.js';
import { validateAgentAndModel, normalizeModelForAgent } from '../runner.js';
import {
  promptLoopSelect,
  promptMaxIterations
} from '../interactive.js';
import { deriveContinuity } from '../stage-menu.js';
import { createProductionAdapterRegistry, type AgentRegistry } from '../adapters/registry.js';
import { setActiveProjectRoot, quarantineInterruptedResume } from '../interrupted-artifact.js';
import type { CliOutput } from '../cli-output.js';
import type { CommandResult } from './types.js';
import type { LoopSpec } from '../manifest.js';
import { configureSpawnDebug } from '../debug-spawn.js';

import { resolveDefaultLoop } from '../loop-selector.js';

export interface SmashOptions {
  project?: string;
  loop?: string;
  agent?: string;
  model?: string;
  maxIterations?: string;
  debugSpawn?: boolean;
  debugSpawnFile?: string;
  output: CliOutput;
  plain?: boolean;
  codexAuditContinuity?: boolean;
  auditContinuity?: boolean;
  /**
   * Test seam (Step 5, v3-audit M1 fix): the factory used to build the
   * agent registry. Defaults to `(cfg) => createProductionAdapterRegistry(cfg.registry)`.
   * Production code never passes this — the test suite (Step 11) injects a
   * spy to observe that the loaded `config.registry` actually reaches
   * the production registry call site.
   */
  createAdapterRegistry?: (cfg: Config) => AgentRegistry;
}

interface SmashRunSetup {
  projectRoot: string;
  loopName: string;
  loopSpec: LoopSpec;
  config: Config;
  runners: Record<string, { agent: string; model: string }>;
  maxIterations: number;
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

  // §3: register the active project root for interrupt-time marker placement,
  // and quarantine any in-flight/late artifact left by a prior interrupted run
  // BEFORE any decision-path scan below can hit `unknown` or advance state.
  setActiveProjectRoot(projectRoot);
  quarantineInterruptedResume(projectRoot, config.manifest.loops);

  const loopKeys = Object.keys(config.manifest.loops);
  if (loopKeys.length === 0) {
    const msg = 'Error: no loops defined in manifest.';
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

  const buildRegistry = options.createAdapterRegistry ?? buildDefaultAdapterRegistry;
  const registry = buildRegistry(config);

  // 1. Loop selection
  let loopName = options.loop;
  const isInteractive = !options.loop;

  if (isInteractive) {
    const { loopName: defaultLoop } = resolveDefaultLoop(projectRoot, config.manifest);
    loopName = await promptLoopSelect(loopKeys, defaultLoop);
  }

  if (!loopName || !config.manifest.loops[loopName]) {
    const msg = `Error: loop '${loopName}' not found in manifest.`;
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

  const loopSpec = config.manifest.loops[loopName]!;

  // Defensive check for obsolete options passed programmatically (e.g. in tests)
  if (options.auditContinuity || options.codexAuditContinuity) {
    const msg = `Error: unknown option ${options.auditContinuity ? '--audit-continuity' : '--codex-audit-continuity'}`;
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

  // 2. Scan state
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

    runners[skillId] = {
      agent: resolvedAgent,
      model: normalizeModelForAgent(resolvedAgent, resolvedModel)
    };
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

  const auditSkillId = loopSpec.audit;
  const auditRunner = auditSkillId ? runners[auditSkillId] : undefined;
  if (auditRunner) {
    const agentSupportsContinuity = deriveContinuity(auditRunner.agent);
    if (!agentSupportsContinuity) {
      options.output.warn(`agent ${auditRunner.agent} does not support session resume.`);
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

  configureSpawnDebug({
    enabled: options.debugSpawn,
    filePath: options.debugSpawnFile
  });

  const projectRoot = resolve(options.project);
  try {
    const setupResult = await resolveSmashRunSetup(projectRoot, options);
    if ('errorResult' in setupResult) {
      return setupResult.errorResult;
    }

    const { setup } = setupResult;

    try {
      const result = await runLoop(projectRoot, setup.loopName, setup.loopSpec, setup.config, setup.runners, {
        maxIterations: setup.maxIterations,
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
  } finally {
    // §3: clear the active project root on completion (normal or error) so a
    // later signal in the same process cannot write a stale interrupt marker.
    setActiveProjectRoot(null);
  }
}

/**
 * Default factory for the agent registry (the v4-audit M3 helper).
 * Production code calls `smashAction` without `createAdapterRegistry`,
 * and `resolveSmashRunSetup` falls back to this function. The helper
 * exists so a deterministic regression test can import it directly
 * (static import, no `vi.spyOn` of a module export) and assert that
 * the default wiring passes `config.registry` to the production
 * registry. Without this helper, the only way to test the default
 * factory is a post-import spy on `createProductionAdapterRegistry`,
 * which is module-binding-sensitive and a weaker assertion than the
 * seam-based test.
 */
export function buildDefaultAdapterRegistry(config: Config): AgentRegistry {
  return createProductionAdapterRegistry(config.registry);
}
