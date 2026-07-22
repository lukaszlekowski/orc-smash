import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { loadConfig, type Config } from '../config.js';
import { scanGlobalSnapshot } from '../state.js';
import { runLoop, runTask } from '../loop.js';
import { resolveRunner, validateRunnerCapabilities, type ResolvedRunner } from '../runner.js';
import {
  promptLoopSelect,
  promptMaxIterations,
  promptPostRunRecovery,
  promptTopLevelMenu,
  promptLoopSubmenu,
  promptPipelineLaunchContext,
  promptCandidateSelection,
  promptTaskMenu,
  promptTaskDetailConfirmation,
  promptStatusAcknowledgement,
  type TaskDetailView,
} from '../interactive.js';
import { collectRunnerOverrides, collectEffortOverrides, type RunnerOverrideMap } from '../runner-overrides.js';
import { createProductionAdapterRegistry, type AgentRegistry } from '../adapters/registry.js';
import { setActiveProjectRoot, setActiveRunEventSink, quarantineInterruptedResume } from '../interrupted-artifact.js';
import type { CliOutput } from '../cli-output.js';
import type { CommandResult } from './types.js';
import type { LoopBinding, TaskBinding, V1Manifest } from '../manifest.js';
import { configureSpawnDebug, debugHarnessEvent } from '../debug-spawn.js';
import { makeRunEvent } from '../run-event.js';
import { continueRunContext, mintRunContext, type RunContext, recoverInProgressRun } from '../pipeline-state.js';
import { bindingHasInProgressChain, bindingHasCompletedAcceptance, resolveDefaultLoop } from '../loop-selector.js';
import { renderStatusPanel } from './status.js';
import { pipelineSuggestions } from '../next-step.js';
import { buildTopLevelMenu, buildLoopSubmenu, buildTaskMenu, pipelineLaunchContexts } from '../stage-menu.js';
import type { SuggestedStageAction } from '../stage-menu.js';
import { buildProjectSnapshotView } from '../project-snapshot-view.js';
import { renderCompactSnapshot } from '../project-snapshot-renderer.js';
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

type ResolveResult =
  | { errorResult: CommandResult }
  | { setup: SmashRunSetup }
  | { retry: true }
  | { exitSignal: true; message: string }
  | { displaySignal: true };

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
  let runContext: RunContext | undefined;
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
    // F7: Interactive top-level menu with submenus
    if (loopIds.length === 0 && taskIds.length === 0) {
      const msg = 'Error: no loops or tasks available for interactive selection.';
      options.output.error(msg);
      return { errorResult: { exitCode: 1, message: msg } };
    }

    const selection = await runInteractiveBindingSelection(projectRoot, config, registry, loopIds, taskIds, options);
    if (selection.kind === 'exit') {
      return { exitSignal: true, message: selection.reason };
    }
    if (selection.kind === 'retry') {
      return { retry: true };
    }
    if (selection.kind === 'display') {
      return { displaySignal: true };
    }
    selected = selection.selected;
    runContext = selection.runContext;
    pipelineStageId = selection.pipelineStageId;
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

  const resolvedRunContext = runContext ?? (options.pipeline
    ? mintRunContext({ mode: 'pipeline-start', pipelineId: options.pipeline, stageId: pipelineStageId })
    : mintRunContext({ mode: 'ad-hoc' }));

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
          effort: resolved.effort,
          effortSource: resolved.effortSource,
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
      runContext: resolvedRunContext,
    },
  };
}

/** Convert pipeline candidates into selectable suggested-stage actions. */
function buildSuggestedStageActions(projectRoot: string, manifest: V1Manifest): SuggestedStageAction[] {
  const candidates = pipelineSuggestions(projectRoot, manifest);
  return candidates.map(c => {
    const relArtifact = relative(projectRoot, c.predecessorArtifactPath);
    const decisionText = c.evidence.decision ?? c.evidence.completionOutcome ?? 'completed';
    const matchText = c.stale ? 'stale' : 'valid';
    const label = `Pipeline: ${c.pipelineId} | Run: ${c.pipelineRunId} | Successor: ${c.successorStageId} | Predecessor: ${c.predecessorStageId} | Artifact: ${relArtifact} | Identity: ${c.artifactIdentity.slice(0, 8)}... | Decision/Outcome: ${decisionText} | Fingerprint Match: ${matchText}`;
    return {
      pipelineId: c.pipelineId,
      pipelineRunId: c.pipelineRunId,
      successorStageId: c.successorStageId,
      predecessorStageId: c.predecessorStageId,
      predecessorArtifactIdentity: c.artifactIdentity,
      label,
    };
  });
}

/** Resolve the binding (loop or task) for a suggested stage's successor stage ID. */
export function resolveBindingForSuggested(
  manifest: V1Manifest,
  selected: SuggestedStageAction,
): SelectedBinding | null {
  const pipeline = manifest.pipelines?.[selected.pipelineId];
  if (!pipeline) return null;

  const successorIndex = pipeline.stages.findIndex(s => s.stageId === selected.successorStageId);
  if (successorIndex === -1) return null;

  const predecessorStage = pipeline.stages[successorIndex - 1];
  if (!predecessorStage || predecessorStage.stageId !== selected.predecessorStageId) {
    return null;
  }

  const stage = pipeline.stages[successorIndex];
  if (stage.loop && manifest.loops[stage.loop]) {
    return { kind: 'loop', id: stage.loop, binding: manifest.loops[stage.loop]! };
  }
  if (stage.task && manifest.tasks?.[stage.task]) {
    return { kind: 'task', id: stage.task, binding: manifest.tasks[stage.task]! };
  }
  return null;
}

type InteractiveSelectionResult =
  | { kind: 'selected'; selected: SelectedBinding; runContext?: RunContext; pipelineStageId?: string }
  | { kind: 'exit'; reason: string }
  | { kind: 'retry' }
  | { kind: 'display' };

/**
 * F7: Run the interactive top-level menu and submenus until the user selects a
 * specific binding to execute or chooses to exit. Handles the full menu
 * navigation: top-level → loop submenu → pipeline context → selected binding.
 */
async function runInteractiveBindingSelection(
  projectRoot: string,
  config: Config,
  registry: AgentRegistry,
  loopIds: string[],
  taskIds: string[],
  options: SmashOptions,
): Promise<InteractiveSelectionResult> {
  const manifest = config.manifest;
  let lastPickedLoop: string | null = null;

  while (true) {
    const snapshot = scanGlobalSnapshot(projectRoot, config.manifest);
    const view = buildProjectSnapshotView(config, snapshot);
    options.output.writeStatic(renderCompactSnapshot(view));

    const topActions = buildTopLevelMenu(manifest, view.eligibleCandidates.length > 0);
    const topActionId = await promptTopLevelMenu(topActions);

    // Stop for manual review
    if (topActionId === 'stop') {
      return { kind: 'exit', reason: 'Stop for manual review' };
    }

    // Display pipeline and project state → render detailed snapshot, wait for acknowledgement, return to menu
    if (topActionId === 'display-status') {
      renderStatusPanel(projectRoot, config, options.output);
      await promptStatusAcknowledgement();
      continue;
    }

    // Change loop — persist the selection so Start loop uses it
    if (topActionId === 'change-loop') {
      if (loopIds.length > 0) {
        const { loopName: defaultLoop } = resolveDefaultLoop(projectRoot, manifest);
        lastPickedLoop = await promptLoopSelect(loopIds, defaultLoop);
      }
      continue;
    }

    // F9: Start suggested stage — show eligible candidates, let the operator
    // pick one, and bind that candidate's pipeline identity into the executor.
    if (topActionId === 'start-suggested-stage') {
      const candidates = buildSuggestedStageActions(projectRoot, manifest);
      if (candidates.length === 0) continue;
      const selected = await promptCandidateSelection(candidates);
      if (!selected) continue;

      // Recompute eligibility to prevent TOCTOU drift
      const currentEligible = pipelineSuggestions(projectRoot, manifest);
      const stillEligible = currentEligible.some(c =>
        c.pipelineId === selected.pipelineId &&
        c.pipelineRunId === selected.pipelineRunId &&
        c.successorStageId === selected.successorStageId &&
        c.artifactIdentity === selected.predecessorArtifactIdentity
      );
      if (!stillEligible) {
        options.output.error(`Selected candidate is no longer eligible (target files have been modified since selection).`);
        continue;
      }

      const binding = resolveBindingForSuggested(manifest, selected);
      if (!binding) continue;

      return {
        kind: 'selected',
        selected: binding,
        runContext: mintRunContext({
          mode: 'stage-continuation',
          pipelineId: selected.pipelineId,
          pipelineRunId: selected.pipelineRunId,
          stageId: selected.successorStageId,
          parentArtifactIdentity: selected.predecessorArtifactIdentity,
        }),
      };
    }

    // Execute one-off task: open generic task chooser menu
    if (topActionId === 'run-task') {
      let taskSelectionResult: { selectedTaskId: string; taskBinding: any; runContext: RunContext } | null = null;
      while (true) {
        const taskMenu = buildTaskMenu(manifest, snapshot.missingInputs);
        const selectedTaskId = await promptTaskMenu(taskMenu);
        if (selectedTaskId === 'back') {
          break;
        }

        const taskBinding = config.manifest.tasks?.[selectedTaskId];
        if (!taskBinding) continue;

        const skillDef = manifest.skills[taskBinding.skill];
        const role = skillDef?.role ?? 'unknown';
        const skillPath = skillDef?.file ? resolve(config.manifestRoot, skillDef.file) : 'unknown';
        const detail: TaskDetailView = {
          taskId: selectedTaskId,
          skillId: taskBinding.skill,
          role,
          skillPath,
          targetPath: taskBinding.target.path,
          outputPattern: taskBinding.output.pattern,
          contract: taskBinding.output.contract,
          missingInputs: snapshot.missingInputs.get(selectedTaskId),
        };

        const confirmation = await promptTaskDetailConfirmation(detail);
        if (confirmation === 'back') {
          continue;
        }

        const contexts = pipelineLaunchContexts(manifest, selectedTaskId, 'task');
        let ctxRunContext: RunContext;
        if (contexts.length > 0) {
          const ctx = await promptPipelineLaunchContext(selectedTaskId, contexts);
          if (ctx.kind === 'pipeline') {
            ctxRunContext = mintRunContext({ mode: 'pipeline-start', pipelineId: ctx.pipelineId, stageId: ctx.stageId });
          } else {
            ctxRunContext = mintRunContext({ mode: 'ad-hoc' });
          }
        } else {
          ctxRunContext = mintRunContext({ mode: 'ad-hoc' });
        }

        taskSelectionResult = { selectedTaskId, taskBinding, runContext: ctxRunContext };
        break;
      }

      if (!taskSelectionResult) {
        continue;
      }

      return {
        kind: 'selected',
        selected: { kind: 'task', id: taskSelectionResult.selectedTaskId, binding: taskSelectionResult.taskBinding },
        runContext: taskSelectionResult.runContext,
      };
    }

    // Start loop
    if (topActionId === 'start-loop') {
      // Pick which loop
      let loopId: string;
      if (loopIds.length === 0) {
        return { kind: 'retry' };
      }
      if (loopIds.length === 1) {
        loopId = loopIds[0]!;
      } else {
        const defaultLoop = lastPickedLoop ?? resolveDefaultLoop(projectRoot, manifest).loopName;
        loopId = await promptLoopSelect(loopIds, defaultLoop);
      }

      const loopBinding = manifest.loops[loopId]!;

      // Build submenu with state checks and missing-input awareness
      const bindingSteps = snapshot.byBinding.get(loopId) ?? [];
      const hasInProgressChain = bindingHasInProgressChain(projectRoot, manifest, loopId);
      const hasAccepted = bindingHasCompletedAcceptance(projectRoot, manifest, loopId);
      const loopMissing = snapshot.missingInputs.get(loopId);

      // Compute continueDetail from the recovered chain when in-progress.
      // Uses the manifest's next skill to resolve the correct runner for that
      // skill (repair's runner when repair is next, evaluate's when evaluate
      // is next), rather than copying the previous evaluator's runner.
      let continueDetail: { phase: string; version: number; skillId: string; agent: string; model: string; effort?: string; sessionStrategy?: string } | undefined;
      if (hasInProgressChain) {
        const recovered = recoverInProgressRun(bindingSteps as any);
        if (recovered) {
          const lastEval = [...bindingSteps].reverse()
            .find(s => s.kind === 'evaluate' && !s.unclassified);
          if (lastEval && lastEval.decision === 'retry') {
            const repairSkillId = loopBinding.repair.skill;
            const repairSkill = config.manifest.skills[repairSkillId];
            const repairRunner = repairSkill ? resolveRunner(repairSkillId, config) : null;
            continueDetail = {
              phase: 'repair',
              version: lastEval.version,
              skillId: repairSkillId,
              agent: repairRunner?.agent ?? lastEval.agent,
              model: repairRunner?.model ?? lastEval.model,
              effort: repairRunner?.effort ?? lastEval.effort,
              sessionStrategy: repairRunner?.sessionStrategy ?? lastEval.sessionStrategy,
            };
          } else if (lastEval) {
            const evalSkillId = loopBinding.evaluate.skill;
            const evalSkill = config.manifest.skills[evalSkillId];
            const evalRunner = evalSkill ? resolveRunner(evalSkillId, config) : null;
            continueDetail = {
              phase: 'evaluate',
              version: lastEval.version + 1,
              skillId: evalSkillId,
              agent: evalRunner?.agent ?? lastEval.agent,
              model: evalRunner?.model ?? lastEval.model,
              effort: evalRunner?.effort ?? lastEval.effort,
              sessionStrategy: evalRunner?.sessionStrategy ?? lastEval.sessionStrategy,
            };
          } else if (recovered) {
            const evalSkillId = loopBinding.evaluate.skill;
            continueDetail = {
              phase: 'evaluate',
              version: 1,
              skillId: evalSkillId,
              agent: '',
              model: '',
            };
          }
        }
      }

      const subItems = buildLoopSubmenu(loopId, hasInProgressChain, hasAccepted, loopMissing, continueDetail);
      const subItemId = await promptLoopSubmenu(subItems);

      // Back to top-level menu
      if (subItemId === 'back') {
        continue;
      }

      // Continue current loop – reuse the recovered chain identity
      if (subItemId === 'continue-current-loop') {
        if (!hasInProgressChain) continue;
        const recovered = recoverInProgressRun(bindingSteps as any);
        if (recovered) {
          const lastValid = [...bindingSteps].reverse()
            .find(s => !s.unclassified && s.artifactIdentity);
          return {
            kind: 'selected',
            selected: { kind: 'loop', id: loopId, binding: loopBinding },
            runContext: continueRunContext({
              chainId: recovered.chainId,
              chainMode: recovered.chainMode,
              pipelineId: recovered.pipelineId,
              pipelineRunId: recovered.pipelineRunId,
              stageId: recovered.stageId,
              parentArtifactIdentity: lastValid?.artifactIdentity ?? null,
            }),
          };
        }
      }

      // Run second opinion
      if (subItemId === 'run-second-opinion') {
        if (!hasAccepted) continue;
        const latestAccepted = [...bindingSteps].reverse()
          .find(s => s.decision === 'accepted' && !s.unclassified);
        if (latestAccepted) {
          return {
            kind: 'selected',
            selected: { kind: 'loop', id: loopId, binding: loopBinding },
            runContext: mintRunContext({
              mode: 'second-opinion',
              pipelineId: latestAccepted.pipelineId ?? undefined,
              pipelineRunId: latestAccepted.pipelineRunId ?? undefined,
              stageId: latestAccepted.stageId ?? undefined,
            }),
          };
        }
        continue;
      }

      // Start fresh loop — check for pipeline launch context
      if (subItemId === 'start-fresh-loop') {
        const contexts = pipelineLaunchContexts(manifest, loopId, 'loop');
        let ctxRunContext: RunContext;
        if (contexts.length > 0) {
          const ctx = await promptPipelineLaunchContext(loopId, contexts);
          if (ctx.kind === 'pipeline') {
            ctxRunContext = mintRunContext({ mode: 'pipeline-start', pipelineId: ctx.pipelineId, stageId: ctx.stageId });
          } else {
            ctxRunContext = mintRunContext({ mode: 'ad-hoc' });
          }
        } else {
          ctxRunContext = mintRunContext({ mode: 'ad-hoc' });
        }

        return {
          kind: 'selected',
          selected: { kind: 'loop', id: loopId, binding: loopBinding },
          runContext: ctxRunContext,
        };
      }
    }
  }
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

    let isInteractiveRun = false;
    while (true) {
      let setupResult: ResolveResult;
      let retryCount = 0;
      while (true) {
        setupResult = await resolveSmashRunSetup(projectRoot, options);
        if ('exitSignal' in setupResult) {
          return flushResult({ exitCode: 0, message: setupResult.message });
        }
        if ('errorResult' in setupResult) {
          return finish(setupResult.errorResult, { success: false, verdict: 'unknown', errorKind: 'setup' });
        }
        // displaySignal is a menu-navigation action, not a missing-input
        // retry — it should not consume the retry budget.
        if ('displaySignal' in setupResult) {
          retryCount = 0;
          continue;
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
      isInteractiveRun = setup.isInteractive;
      
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
      const cmdResult = await finish(result, terminal, {
        success: terminal.success,
        verdict: terminal.verdict,
        message: outcome.message,
      });

      if (!isInteractiveRun) {
        return cmdResult;
      }

      const nextAction = await promptPostRunRecovery();
      if (nextAction === 'exit') {
        return cmdResult;
      }

      // Reset state for next iteration
      ownership = null;
      ownershipFinalized = false;
    }
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
