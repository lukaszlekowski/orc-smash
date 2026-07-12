import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { scan, requireApprovedPlanAuditPath } from '../state.js';
import { runLoop } from '../loop.js';
import { resolveRunner } from '../runner.js';
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
import { configureSpawnDebug, debugHarnessEvent } from '../debug-spawn.js';

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
    debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'config-load', result: 'pass' });
  } catch (err: any) {
    const msg = `Error: failed to load config or manifest: ${err.message}`;
    debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'config-load', detail: err.message, result: 'fail' });
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
  debugHarnessEvent({ cwd: projectRoot, category: 'decision', event: 'loop-selected', detail: loopName, result: 'pass' });

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
      debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'approved-plan-requirement', result: 'pass' });
    } catch (err: any) {
      const msg = `Error: ${err.message}`;
      debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'approved-plan-requirement', detail: err.message, result: 'fail' });
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
  } else {
    const stateScan = scan(projectRoot, { auditPattern: loopSpec.auditPattern!, followUpPattern: loopSpec.followUpPattern! });
    if (stateScan.latestVerdict === 'unknown' && stateScan.auditSteps.length > 0) {
      const msg = 'latest audit is unparseable; resolve or delete it before smashing';
      debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'state-scan-preflight', detail: 'latest audit unparseable', result: 'fail' });
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
    debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'state-scan-preflight', detail: `latestVerdict=${stateScan.latestVerdict}`, result: 'pass' });
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

  // Interactive implement: defer runner selection to runLoop's implement branch
  // (promptRunners with forceSelect). Pre-seeding the skill default here would
  // silence that prompt and silently use the configured default model.
  // Non-interactive runs and explicit --agent/--model overrides still seed below.
  const deferImplementToPrompt =
    isInteractive && loopSpec.kind === 'implement' && !globalOverrides.agent && !globalOverrides.model;

  for (const skillId of loopSkills) {
    if (deferImplementToPrompt) break;
    try {
      runners[skillId] = resolveRunner(skillId, config, globalOverrides);
      debugHarnessEvent({ cwd: projectRoot, category: 'decision', event: 'runner-resolved', detail: `${skillId} → ${runners[skillId].agent} (${runners[skillId].model})`, result: 'pass' });
    } catch (err: any) {
      const msg = `Error: ${err.message}`;
      debugHarnessEvent({ cwd: projectRoot, category: 'decision', event: 'runner-resolved', detail: `${skillId} error: ${err.message}`, result: 'fail' });
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
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

  const auditSkillId = loopSpec.audit;
  const auditRunner = auditSkillId ? runners[auditSkillId] : undefined;
  if (auditRunner) {
    const agentSupportsContinuity = deriveContinuity(auditRunner.agent);
    debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'continuity-support-check', detail: `${auditRunner.agent} supportsContinuity=${agentSupportsContinuity}`, result: agentSupportsContinuity ? 'pass' : 'info' });
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
  
  let ownership: any = null;
  try {
    const { parseLaunchInput, openOwnedRun } = await import('./ownership-launch.js');
    ownership = await openOwnedRun(parseLaunchInput(), projectRoot);
  } catch (err: any) {
    const msg = `Ownership setup failed: ${err.message}`;
    options.output.error(msg);
    return { exitCode: 2, message: msg };
  }

  try {
    const setupResult = await resolveSmashRunSetup(projectRoot, options);
    if ('errorResult' in setupResult) {
      if (ownership) {
        const { failRun } = await import('../run-ownership.js');
        try {
          failRun(ownership.runDir, ownership.projectDir, ownership.runId, setupResult.errorResult.message || 'Setup failed');
        } catch {}
      }
      return setupResult.errorResult;
    }

    const { setup } = setupResult;

    let runResult: any;
    let thrownError: any = null;
    try {
      runResult = await runLoop(projectRoot, setup.loopName, setup.loopSpec, setup.config, setup.runners, {
        maxIterations: setup.maxIterations,
        globalOverrides: setup.globalOverrides,
        interactive: setup.isInteractive,
        registry: setup.registry,
        output: options.output,
        ownership
      });
    } catch (err: any) {
      thrownError = err;
      const msg = `Error running loop: ${err.message}`;
      options.output.error(msg);
      runResult = { success: false, verdict: 'unknown', message: msg };
    }

    if (ownership) {
      const { finalizeOwnedRun } = await import('../run-ownership.js');
      try {
        await finalizeOwnedRun(ownership, runResult);
      } catch (err: any) {
        options.output.error(`Finalize owned run failed: ${err.message}`);
        return { exitCode: 2, message: err.message };
      }
    }

    if (thrownError) {
      return { exitCode: 1, message: thrownError.message };
    }

    if (runResult.success) {
      return { exitCode: 0, message: runResult.message };
    } else {
      if (runResult.verdict === 'ownership-lost') {
        return { exitCode: 2, message: runResult.message };
      }
      return { exitCode: runResult.verdict === 'unknown' ? 1 : 0, message: runResult.message };
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
