import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { scanGlobalSnapshot } from '../state.js';
import { runLoop, runTask } from '../loop.js';
import { resolveRunner, validateRunnerCapabilities, type ResolvedRunner } from '../runner.js';
import { promptLoopSelect, promptMaxIterations } from '../interactive.js';
import { collectRunnerOverrides, collectEffortOverrides, type RunnerOverrideMap } from '../runner-overrides.js';
import { createProductionAdapterRegistry, type AgentRegistry } from '../adapters/registry.js';
import { setActiveProjectRoot, setActiveRunEventSink, quarantineInterruptedResume } from '../interrupted-artifact.js';
import type { CliOutput } from '../cli-output.js';
import type { CommandResult } from './types.js';
import type { LoopBinding, TaskBinding, V1Manifest } from '../manifest.js';
import { configureSpawnDebug, debugHarnessEvent } from '../debug-spawn.js';
import { makeRunEvent } from '../run-event.js';
import { mintRunContext, type RunContext } from '../pipeline-state.js';
import { resolveDefaultLoop } from '../loop-selector.js';
import type { BindingKind } from '../loops/binding-engine.js';
import type { LoopReturn, RunOutcome } from '../loops/runtime.js';

type SelectedBinding =
  | { kind: 'loop'; id: string; binding: LoopBinding }
  | { kind: 'task'; id: string; binding: TaskBinding };

export interface SmashOptions {
  project?: string;
  loop?: string;
  task?: string;
  pipeline?: string;
  config?: string;
  agent?: string;
  model?: string;
  effort?: string;
  maxIterations?: string;
  debugSpawn?: boolean;
  debugSpawnFile?: string;
  output: CliOutput;
  plain?: boolean;
  runner?: string[];
  runnerModel?: string[];
  runnerEffort?: string[];
  createAdapterRegistry?: (cfg: Config) => AgentRegistry;
}

interface SmashRunSetup {
  projectRoot: string;
  bindingKind: BindingKind;
  bindingId: string;
  binding: LoopBinding | TaskBinding;
  config: Config;
  runners: Record<string, ResolvedRunner>;
  maxIterations: number;
  globalOverrides: { agent?: string; model?: string; effort?: string };
  isInteractive: boolean;
  registry: AgentRegistry;
  runnerOverrides: RunnerOverrideMap;
  runContext?: RunContext;
}

type ResolveResult = { errorResult: CommandResult } | { setup: SmashRunSetup } | { retry: true };

function allBindings(manifest: V1Manifest): Record<string, LoopBinding | TaskBinding> {
  return {
    ...manifest.loops,
    ...(manifest.tasks ?? {}),
  };
}

function selectedFromPipeline(manifest: V1Manifest, pipelineId: string): { selected: SelectedBinding; stageId: string } | null {
  const pipeline = manifest.pipelines[pipelineId];
  const stage = pipeline?.stages[0];
  if (!stage) return null;
  if (stage.loop) {
    const binding = manifest.loops[stage.loop];
    return binding ? { selected: { kind: 'loop', id: stage.loop, binding }, stageId: stage.stageId } : null;
  }
  if (stage.task) {
    const binding = manifest.tasks?.[stage.task];
    return binding ? { selected: { kind: 'task', id: stage.task, binding }, stageId: stage.stageId } : null;
  }
  return null;
}

function selectedFromOptions(manifest: V1Manifest, options: SmashOptions): { selected: SelectedBinding; pipelineStageId?: string } | { error: string } | null {
  const selectedCount = [options.loop, options.task, options.pipeline].filter(Boolean).length;
  if (selectedCount > 1) {
    return { error: '--loop, --task, and --pipeline are mutually exclusive.' };
  }

  if (options.pipeline) {
    const result = selectedFromPipeline(manifest, options.pipeline);
    if (!result) return { error: `pipeline '${options.pipeline}' not found or has no valid first stage.` };
    return { selected: result.selected, pipelineStageId: result.stageId };
  }
  if (options.task) {
    const binding = manifest.tasks?.[options.task];
    return binding
      ? { selected: { kind: 'task', id: options.task, binding } }
      : { error: `task '${options.task}' not found in manifest.` };
  }
  if (options.loop) {
    const binding = manifest.loops[options.loop];
    return binding
      ? { selected: { kind: 'loop', id: options.loop, binding } }
      : { error: `loop '${options.loop}' not found in manifest.` };
  }
  return null;
}

function bindingMissingInputs(projectRoot: string, binding: LoopBinding | TaskBinding): string[] {
  const missing: string[] = [];
  if (binding.target.kind === 'file' && binding.target.path !== '.') {
    if (!existsSync(resolve(projectRoot, binding.target.path))) {
      missing.push(`target: ${binding.target.path}`);
    }
  }
  for (const [key, projectPath] of Object.entries(binding.files ?? {})) {
    if (!existsSync(resolve(projectRoot, projectPath))) {
      missing.push(`file: ${key}=${projectPath}`);
    }
  }
  return missing;
}

function bindingSkills(selected: SelectedBinding): string[] {
  return selected.kind === 'task'
    ? [selected.binding.skill]
    : [selected.binding.evaluate.skill, selected.binding.repair.skill];
}

async function resolveSmashRunSetup(
  projectRoot: string,
  options: SmashOptions,
): Promise<ResolveResult> {
  let config: Config;
  try {
    config = loadConfig(projectRoot, options.config);
    debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'config-load', result: 'pass' });
    options.output.emit(makeRunEvent({ type: 'config.loaded', atMs: Date.now(), path: config.manifestPath }));
  } catch (err: any) {
    const msg = `Error: failed to load config or manifest: ${err.message}`;
    debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'config-load', detail: err.message, result: 'fail' });
    options.output.emit(makeRunEvent({ type: 'config.failed', atMs: Date.now(), message: msg }));
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

  setActiveProjectRoot(projectRoot);
  quarantineInterruptedResume(projectRoot, allBindings(config.manifest));

  const loopIds = Object.keys(config.manifest.loops);
  const taskIds = Object.keys(config.manifest.tasks ?? {});
  if (loopIds.length === 0 && taskIds.length === 0) {
    const msg = 'Error: no loops or tasks defined in manifest.';
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

  const buildRegistry = options.createAdapterRegistry ?? buildDefaultAdapterRegistry;
  const registry = buildRegistry(config);
  const isInteractive = !options.loop && !options.task && !options.pipeline;

  if (isInteractive && (options.runner?.length || options.runnerModel?.length || options.runnerEffort?.length)) {
    const msg = 'Error: --runner / --runner-model / --runner-effort require an explicit --loop, --task, or --pipeline.';
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

  let selected: SelectedBinding;
  let pipelineStageId: string | undefined;
  const explicit = selectedFromOptions(config.manifest, options);
  if (explicit && 'error' in explicit) {
    const msg = `Error: ${explicit.error}`;
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }
  if (explicit) {
    selected = explicit.selected;
    pipelineStageId = explicit.pipelineStageId;
  } else {
    if (loopIds.length === 0) {
      const msg = 'Error: interactive selection requires at least one configured loop.';
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
    const { loopName: defaultLoop } = resolveDefaultLoop(projectRoot, config.manifest);
    const id = await promptLoopSelect(loopIds, defaultLoop);
    selected = { kind: 'loop', id, binding: config.manifest.loops[id]! };
  }

  debugHarnessEvent({ cwd: projectRoot, category: 'decision', event: 'binding-selected', detail: `${selected.kind}/${selected.id}`, result: 'pass' });
  options.output.emit(makeRunEvent({ type: 'binding.selected', atMs: Date.now(), bindingId: selected.id, bindingKind: selected.kind }));

  const missing = bindingMissingInputs(projectRoot, selected.binding);
  if (missing.length > 0) {
    const message = `Project inputs missing: ${missing.join(', ')}`;
    debugHarnessEvent({ cwd: projectRoot, category: 'preflight', event: 'input-missing', detail: message, result: 'fail' });
    options.output.emit(makeRunEvent({ type: 'input.missing', atMs: Date.now(), missing }));
    if (!isInteractive) {
      options.output.error(`Error: ${message}`);
      return { errorResult: { exitCode: 1, message } };
    }
    return { retry: true };
  }

  const runContext = options.pipeline
    ? mintRunContext({ mode: 'pipeline-start', pipelineId: options.pipeline, stageId: pipelineStageId })
    : undefined;

  if (selected.kind === 'loop') {
    const snapshot = scanGlobalSnapshot(projectRoot, config.manifest);
    const stateSteps = snapshot.byBinding.get(selected.id) ?? [];
    const latest = stateSteps.at(-1);
    options.output.emit(makeRunEvent({
      type: 'state.scanned',
      atMs: Date.now(),
      latestResult: latest?.decision ?? latest?.completionOutcome ?? (latest?.unclassified ? 'unknown' : 'none'),
      version: latest?.version ?? 0,
    }));
  }

  const skills = bindingSkills(selected);
  const runners: Record<string, ResolvedRunner> = {};
  const globalOverrides = { agent: options.agent, model: options.model, effort: options.effort };
  let runnerOverrides: RunnerOverrideMap = {};
  try {
    runnerOverrides = collectRunnerOverrides(options.runner ?? [], options.runnerModel ?? [], skills);
    if (options.runnerEffort?.length) {
      const effortOverrides = collectEffortOverrides(options.runnerEffort, skills);
      for (const [skillId, override] of Object.entries(effortOverrides)) {
        runnerOverrides[skillId] = { ...runnerOverrides[skillId], ...override };
      }
    }
  } catch (err: any) {
    const msg = `Error: ${err.message}`;
    options.output.error(msg);
    return { errorResult: { exitCode: 1, message: msg } };
  }

  const deferInteractiveRunnerSelection = isInteractive && !globalOverrides.agent && !globalOverrides.model;
  if (!deferInteractiveRunnerSelection) {
    for (const skillId of [...new Set(skills)]) {
      try {
        const resolved = resolveRunner(skillId, config, globalOverrides, undefined, runnerOverrides[skillId], options.effort);
        validateRunnerCapabilities(resolved, registry);
        runners[skillId] = resolved;
        options.output.emit(makeRunEvent({
          type: 'runner.resolved',
          atMs: Date.now(),
          skillId,
          agent: resolved.agent,
          model: resolved.model,
          agentSource: resolved.agentSource,
          modelSource: resolved.modelSource,
          inheritedSession: resolved.inheritedSession,
        }));
        debugHarnessEvent({ cwd: projectRoot, category: 'decision', event: 'runner-resolved', detail: `${skillId} → ${resolved.agent} (${resolved.model})`, result: 'pass' });
      } catch (err: any) {
        const msg = `Error: ${err.message}`;
        options.output.emit(makeRunEvent({ type: 'runner.rejected', atMs: Date.now(), skillId, message: msg }));
        options.output.error(msg);
        return { errorResult: { exitCode: 1, message: msg } };
      }
    }
  }

  let maxIterations = 4;
  if (isInteractive && selected.kind === 'loop') {
    maxIterations = await promptMaxIterations(4);
  } else if (options.maxIterations) {
    maxIterations = parseInt(options.maxIterations, 10);
    if (Number.isNaN(maxIterations) || maxIterations <= 0) {
      const msg = 'Error: max-iterations must be a positive integer.';
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }
  }

  return {
    setup: {
      projectRoot,
      bindingKind: selected.kind,
      bindingId: selected.id,
      binding: selected.binding,
      config,
      runners,
      maxIterations,
      globalOverrides,
      isInteractive,
      registry,
      runnerOverrides,
      runContext,
    },
  };
}

function outcomeForResult(runResult: LoopReturn): RunOutcome {
  if (runResult.outcome) return runResult.outcome;
  return runResult.success
    ? { kind: 'completed', message: runResult.message, artifactPath: runResult.lastAuditPath }
    : { kind: 'unknown', message: runResult.message, artifactPath: runResult.lastAuditPath };
}

function commandResultForOutcome(outcome: RunOutcome): CommandResult {
  if (outcome.kind === 'completed') return { exitCode: 0, message: outcome.message };
  if (outcome.kind === 'ownership-lost') return { exitCode: 2, message: outcome.message };
  if (outcome.kind === 'interrupted') return { exitCode: 130, message: outcome.message };
  return { exitCode: 1, message: outcome.message };
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

  let ownership: import('../run-ownership.js').OwnershipContext | null = null;
  let ownershipFinalized = false;
  const finish = async (
    result: CommandResult,
    terminal: { success: boolean; verdict: string; errorKind?: string },
    ownershipOutcome: { success: boolean; verdict: string; message?: string } = {
      success: terminal.success,
      verdict: terminal.verdict,
      message: result.message,
    },
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
        terminal = { success: false, verdict: 'ownership-lost', errorKind: 'ownership' };
        finalResult = { exitCode: finalResult.exitCode === 0 ? 2 : finalResult.exitCode, message };
      }
    }
    if (terminal.success) {
      options.output.emit(makeRunEvent({ type: 'run.completed', atMs: Date.now(), result: terminal.verdict, outcome: finalResult.message ?? 'completed' }));
    } else {
      options.output.emit(makeRunEvent({ type: 'run.failed', atMs: Date.now(), reason: finalResult.message ?? 'run failed', errorKind: terminal.errorKind }));
    }
    return flushResult(finalResult);
  };

  if (!options.project) {
    const msg = 'Error: project path is required. Use --project <path>';
    options.output.error(msg);
    return finish({ exitCode: 1, message: msg }, { success: false, verdict: 'unknown', errorKind: 'config' });
  }

  configureSpawnDebug({ enabled: options.debugSpawn, filePath: options.debugSpawnFile });
  const projectRoot = resolve(options.project);

  try {
    setActiveRunEventSink((event) => options.output.emit(makeRunEvent(event)));
    options.output.emit(makeRunEvent({ type: 'run.started', atMs: Date.now() }));

    let setupResult: ResolveResult;
    let retryCount = 0;
    while (true) {
      setupResult = await resolveSmashRunSetup(projectRoot, options);
      if ('errorResult' in setupResult) {
        return finish(setupResult.errorResult, { success: false, verdict: 'unknown', errorKind: 'setup' });
      }
      if (!('retry' in setupResult)) break;
      retryCount += 1;
      if (retryCount >= 10) {
        const message = 'Project inputs still missing after multiple retries.';
        options.output.error(`Error: ${message}`);
        return finish({ exitCode: 1, message }, { success: false, verdict: 'unknown', errorKind: 'setup' });
      }
    }

    const { setup } = setupResult;
    try {
      const { parseLaunchInput, openOwnedRun } = await import('./ownership-launch.js');
      ownership = await openOwnedRun(parseLaunchInput(), projectRoot);
      if (ownership) options.output.emit(makeRunEvent({ type: 'ownership.opened', atMs: Date.now(), projectRoot }));
    } catch (err: any) {
      const msg = `Ownership setup failed: ${err.message}`;
      options.output.error(msg);
      return finish({ exitCode: 2, message: msg }, { success: false, verdict: 'ownership-lost', errorKind: 'ownership' });
    }

    let runResult: LoopReturn;
    try {
      const executorOptions = {
        maxIterations: setup.maxIterations,
        globalOverrides: setup.globalOverrides,
        interactive: setup.isInteractive,
        registry: setup.registry,
        output: options.output,
        ownership,
        runnerOverrides: setup.runnerOverrides,
        runContext: setup.runContext,
        emitTerminal: false,
      };
      runResult = setup.bindingKind === 'task'
        ? await runTask(setup.projectRoot, setup.bindingId, setup.binding as TaskBinding, setup.config, setup.runners, executorOptions)
        : await runLoop(setup.projectRoot, setup.bindingId, setup.binding as LoopBinding, setup.config, setup.runners, executorOptions);
    } catch (err: any) {
      const message = `Error running ${setup.bindingKind} '${setup.bindingId}': ${err.message}`;
      options.output.error(message);
      runResult = {
        success: false,
        verdict: 'unknown',
        message,
        lastAuditPath: null,
        terminalEventEmitted: false,
        outcome: { kind: 'unknown', message, artifactPath: null },
      };
    }

    const outcome = outcomeForResult(runResult);
    const result = commandResultForOutcome(outcome);
    const terminal = {
      success: outcome.kind === 'completed',
      verdict: runResult.verdict,
      errorKind: outcome.kind === 'ownership-lost' ? 'ownership' : outcome.kind === 'completed' ? undefined : outcome.kind,
    };
    return finish(result, terminal, {
      success: terminal.success,
      verdict: terminal.verdict,
      message: outcome.message,
    });
  } catch (err: any) {
    const message = `Error running smash setup: ${err?.message ?? String(err)}`;
    options.output.error(message);
    return finish({ exitCode: 1, message }, { success: false, verdict: 'unknown', errorKind: 'setup' });
  } finally {
    setActiveProjectRoot(null);
    setActiveRunEventSink(null);
  }
}

export function buildDefaultAdapterRegistry(config: Config): AgentRegistry {
  return createProductionAdapterRegistry(config.registry);
}
