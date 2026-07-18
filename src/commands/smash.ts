import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { scan, requireApprovedPlanAuditPath } from '../state.js';
import { runLoop } from '../loop.js';
import { resolveRunner, type ResolvedRunner } from '../runner.js';
import {
  promptLoopSelect,
  promptMaxIterations
} from '../interactive.js';
import { deriveContinuity, type AuditContinuityPolicy } from '../stage-menu.js';
import { collectRunnerOverrides, type RunnerOverrideMap } from '../runner-overrides.js';
import { createProductionAdapterRegistry, type AgentRegistry } from '../adapters/registry.js';
import { setActiveProjectRoot, setActiveRunEventSink, quarantineInterruptedResume } from '../interrupted-artifact.js';
import type { CliOutput } from '../cli-output.js';
import type { CommandResult } from './types.js';
import type { LoopSpec } from '../manifest.js';
import { configureSpawnDebug, debugHarnessEvent } from '../debug-spawn.js';
import { makeRunEvent } from '../run-event.js';

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
  runner?: string[];
  runnerModel?: string[];
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
  runners: Record<string, ResolvedRunner>;
  maxIterations: number;
  globalOverrides: { agent?: string; model?: string };
  isInteractive: boolean;
  registry: AgentRegistry;
  runnerOverrides: RunnerOverrideMap;
  auditContinuity: AuditContinuityPolicy;
}

function deriveAuditContinuityPolicy(options: SmashOptions): AuditContinuityPolicy {
  if (options.auditContinuity) {
    return { enabled: true, requestedBy: 'audit-continuity' };
  }
  if (options.codexAuditContinuity) {
    return { enabled: true, requestedBy: 'codex-audit-continuity' };
  }
  return { enabled: false };
}

async function resolveSmashRunSetup(
  projectRoot: string,
  options: SmashOptions
): Promise<{ errorResult: CommandResult } | { setup: SmashRunSetup }> {
  let config: Config;
  try {
    config = loadConfig(projectRoot);
    debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'config-load', result: 'pass' });
    options.output.emit(makeRunEvent({ type: 'config.loaded', atMs: Date.now(), path: resolve(projectRoot, 'skills.yaml') }));
  } catch (err: any) {
    const msg = `Error: failed to load config or manifest: ${err.message}`;
    debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'config-load', detail: err.message, result: 'fail' });
    options.output.emit(makeRunEvent({ type: 'config.failed', atMs: Date.now(), message: msg }));
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

  // Reject per-skill overrides without explicit --loop
  if (isInteractive && (options.runner?.length || options.runnerModel?.length)) {
    const msg = 'Error: --runner / --runner-model require an explicit --loop.';
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

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
  options.output.emit(makeRunEvent({ type: 'loop.selected', atMs: Date.now(), loopName }));

  // 1a. Mutual-exclusion check before policy derivation
  if (options.auditContinuity && options.codexAuditContinuity) {
    const msg = 'Error: --audit-continuity and --codex-audit-continuity are mutually exclusive.';
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }
  const auditContinuity = deriveAuditContinuityPolicy(options);

  // Audit-continuity is only valid for plan/review loops
  if (auditContinuity.enabled && loopSpec.kind !== 'doc-audit' && loopSpec.kind !== 'code-review') {
    const msg = `Error: --audit-continuity is not supported for loop '${loopName}' (kind: ${loopSpec.kind}). Only plan and review loops support continuity.`;
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
    options.output.emit(makeRunEvent({ type: 'state.scanned', atMs: Date.now(), latestVerdict: stateScan.latestVerdict ?? 'none', version: stateScan.latestVersion }));
    if (stateScan.latestVerdict === 'unknown' && stateScan.auditSteps.length > 0) {
      const msg = 'latest audit is unparseable; resolve or delete it before smashing';
      debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'state-scan-preflight', detail: 'latest audit unparseable', result: 'fail' });
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
    debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'state-scan-preflight', detail: `latestVerdict=${stateScan.latestVerdict}`, result: 'pass' });
  }

  // 3. Runners selection & validation
  const loopSkills = loopSpec.kind === 'implement'
    ? (loopSpec.implement ? [loopSpec.implement] : [])
    : [loopSpec.audit, loopSpec['follow-up']].filter((s): s is string => !!s);
  const runners: Record<string, ResolvedRunner> = {};

  const globalOverrides = {
    agent: options.agent,
    model: options.model
  };

  // Collect per-skill overrides
  let runnerOverrides: RunnerOverrideMap = {};
  try {
    runnerOverrides = collectRunnerOverrides(
      options.runner ?? [],
      options.runnerModel ?? [],
      loopSkills
    );
  } catch (err: any) {
    const msg = `Error: ${err.message}`;
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

  // Interactive implement: defer runner selection to runLoop's implement branch
  // (promptRunners with forceSelect). Pre-seeding the skill default here would
  // silence that prompt and silently use the configured default model.
  // Non-interactive runs and explicit --agent/--model overrides still seed below.
  const deferImplementToPrompt =
    isInteractive && loopSpec.kind === 'implement' && !globalOverrides.agent && !globalOverrides.model;
  const deferInteractiveStageRunners = isInteractive && loopSpec.kind !== 'implement';

  for (const skillId of loopSkills) {
    if (deferImplementToPrompt || deferInteractiveStageRunners) break;
    try {
      const perSkillOverride = runnerOverrides[skillId];
      const resolved = resolveRunner(skillId, config, globalOverrides, undefined, perSkillOverride);
      runners[skillId] = resolved;
      options.output.emit(makeRunEvent({
        type: 'runner.resolved',
        atMs: Date.now(),
        skillId,
        agent: resolved.agent,
        model: resolved.model,
        agentSource: resolved.agentSource,
        modelSource: resolved.modelSource,
        inheritedSession: resolved.inheritedSession
      }));
      debugHarnessEvent({ cwd: projectRoot, category: 'decision', event: 'runner-resolved', detail: `${skillId} → ${runners[skillId].agent} (${runners[skillId].model})`, result: 'pass' });
    } catch (err: any) {
      const msg = `Error: ${err.message}`;
      options.output.emit(makeRunEvent({ type: 'runner.rejected', atMs: Date.now(), skillId, message: msg }));
      debugHarnessEvent({ cwd: projectRoot, category: 'decision', event: 'runner-resolved', detail: `${skillId} error: ${err.message}`, result: 'fail' });
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }

  }

  // Validate continuity against the fully resolved coupled runner pair. Raw
  // overrides do not contain enough information when a profile or agent-only
  // override supplies the other half of the pair.
  if (auditContinuity.enabled && loopSpec.audit && loopSpec['follow-up']) {
    const auditRunner = runners[loopSpec.audit];
    const followUpRunner = runners[loopSpec['follow-up']];
    if (!auditRunner || !followUpRunner) {
      const msg = 'Error: --audit-continuity requires resolved audit and follow-up runners.';
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
    if (auditRunner.agent !== followUpRunner.agent || auditRunner.model !== followUpRunner.model) {
      const msg = 'Error: --audit-continuity requires the same agent/model for both audit and follow-up skills.';
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
    if (auditContinuity.requestedBy === 'codex-audit-continuity' && auditRunner.agent !== 'codex') {
      const msg = `Error: --codex-audit-continuity requires codex, but the resolved agent is '${auditRunner.agent}'.`;
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
    if (!deriveContinuity(auditRunner.agent)) {
      const msg = `Error: --audit-continuity requires codex, opencode, or claude, but the resolved agent is '${auditRunner.agent}'.`;
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
      registry,
      runnerOverrides,
      auditContinuity
    }
  };
}

export async function smashAction(options: SmashOptions): Promise<CommandResult> {
  const flushResult = async (result: CommandResult): Promise<CommandResult> => {
    try {
      await options.output.flush();
      return result;
    } catch (err: any) {
      const message = `Output flush failed: ${err?.message ?? String(err)}`;
      process.stderr.write(`${message}\n`);
      return result.exitCode === 0 ? { exitCode: 1, message } : result;
    }
  };

  const emitTerminal = (result: CommandResult, terminal: { success: boolean; verdict: string; errorKind?: string }): void => {
    if (terminal.success) {
      options.output.emit(makeRunEvent({ type: 'run.completed', atMs: Date.now(), verdict: terminal.verdict, outcome: result.message ?? 'completed' }));
    } else {
      options.output.emit(makeRunEvent({ type: 'run.failed', atMs: Date.now(), reason: result.message ?? 'run failed', errorKind: terminal.errorKind }));
    }
  };

  let ownership: import('../run-ownership.js').OwnershipContext | null = null;
  let ownershipFinalized = false;

  const finish = async (
    result: CommandResult,
    terminal: { success: boolean; verdict: string; errorKind?: string } = {
      success: false,
      verdict: 'unknown',
      errorKind: 'setup'
    },
    ownershipOutcome: { success: boolean; verdict: string; message?: string } = {
      success: terminal.success,
      verdict: terminal.verdict,
      message: result.message
    }
  ): Promise<CommandResult> => {
    let finalResult = result;
    if (ownership && !ownershipFinalized) {
      ownershipFinalized = true;
      try {
        const { finalizeOwnedRun } = await import('../run-ownership.js');
        await finalizeOwnedRun(ownership, ownershipOutcome);
        options.output.emit(makeRunEvent({ type: 'ownership.finalized', atMs: Date.now(), success: true }));
      } catch (err: any) {
        const message = `Finalize owned run failed: ${err?.message ?? String(err)}`;
        options.output.error(message);
        options.output.emit(makeRunEvent({ type: 'ownership.finalized', atMs: Date.now(), success: false }));
        finalResult = { exitCode: finalResult.exitCode === 0 ? 2 : finalResult.exitCode, message };
        terminal = { success: false, verdict: 'ownership-lost', errorKind: 'ownership' };
      }
    }
    emitTerminal(finalResult, terminal);
    return flushResult(finalResult);
  };

  if (!options.project) {
    const msg = 'Error: project path is required. Use --project <path>';
    options.output.error(msg);
    return finish({ exitCode: 1, message: msg }, { success: false, verdict: 'unknown', errorKind: 'config' });
  }

  configureSpawnDebug({
    enabled: options.debugSpawn,
    filePath: options.debugSpawnFile
  });

  const projectRoot = resolve(options.project);

  try {
    setActiveRunEventSink((event) => options.output.emit(makeRunEvent(event)));
    options.output.emit(makeRunEvent({ type: 'run.started', atMs: Date.now() }));
    const setupResult = await resolveSmashRunSetup(projectRoot, options);
    if ('errorResult' in setupResult) {
      return finish(setupResult.errorResult, { success: false, verdict: 'unknown', errorKind: 'setup' });
    }

    const { setup } = setupResult;
    try {
      const { parseLaunchInput, openOwnedRun } = await import('./ownership-launch.js');
      ownership = await openOwnedRun(parseLaunchInput(), projectRoot);
      if (ownership) {
        options.output.emit(makeRunEvent({ type: 'ownership.opened', atMs: Date.now(), projectRoot }));
      }
    } catch (err: any) {
      const msg = `Ownership setup failed: ${err.message}`;
      options.output.error(msg);
      return finish({ exitCode: 2, message: msg }, { success: false, verdict: 'ownership-lost', errorKind: 'ownership' });
    }

    let runResult: import('../loops/runtime.js').LoopReturn;
    let thrownError: any = null;
    try {
      runResult = await runLoop(projectRoot, setup.loopName, setup.loopSpec, setup.config, setup.runners, {
        maxIterations: setup.maxIterations,
        globalOverrides: setup.globalOverrides,
        interactive: setup.isInteractive,
        registry: setup.registry,
        output: options.output,
        ownership,
        runnerOverrides: setup.runnerOverrides,
        auditContinuity: setup.auditContinuity,
        emitTerminal: false
      });
    } catch (err: any) {
      thrownError = err;
      const msg = `Error running loop: ${err.message}`;
      options.output.error(msg);
      runResult = { success: false, verdict: 'unknown', message: msg, lastAuditPath: null, terminalEventEmitted: false };
    }

    if (thrownError) {
      const result = { exitCode: 1, message: thrownError.message };
      return finish(result, { success: false, verdict: 'unknown', errorKind: 'loop' }, runResult);
    }

    let result: CommandResult;
    if (runResult.success) {
      result = { exitCode: 0, message: runResult.message };
    } else {
      if (runResult.verdict === 'ownership-lost') {
        result = { exitCode: 2, message: runResult.message };
      } else {
        result = { exitCode: runResult.verdict === 'unknown' ? 1 : 0, message: runResult.message };
      }
    }
    return finish(result, {
      success: runResult.success,
      verdict: runResult.verdict,
      errorKind: runResult.verdict === 'ownership-lost' ? 'ownership' : runResult.verdict === 'unknown' ? 'unknown' : undefined
    }, runResult);
  } catch (err: any) {
    const message = `Error running smash setup: ${err?.message ?? String(err)}`;
    options.output.error(message);
    return finish({ exitCode: 1, message }, { success: false, verdict: 'unknown', errorKind: 'setup' });
  } finally {
    // §3: clear the active project root on completion (normal or error) so a
    // later signal in the same process cannot write a stale interrupt marker.
    setActiveProjectRoot(null);
    setActiveRunEventSink(null);
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
