import { existsSync, readFileSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import type { CliOutput } from '../cli-output.js';
import type { Config } from '../config.js';
import { parseCompletionContent, parseDecisionContent, type DecisionOutcome } from '../artifact-contract.js';
import { composePrompt } from '../prompt-composer.js';
import { writeArtifactWithMeta, type ArtifactMeta } from '../provenance.js';
import { renderPattern } from '../patterns.js';
import type {
  LoopBinding,
  LoopSpec,
  OutputSpec,
  SkillSpec,
  TaskBinding,
} from '../manifest.js';
import { priorArtifactNone, resolvePriorArtifact, type PriorArtifactResolution } from '../binding-inputs.js';
import { computeArtifactIdentity, computeInputFingerprint, mintRunContext, type RunContext } from '../pipeline-state.js';
import { captureFileDigests, captureTargetFingerprint } from '../target-snapshot.js';
import { getAdapter, type AgentRegistry } from '../adapters/registry.js';
import type { RunResult } from '../adapters/types.js';
import { structuredMessage } from '../adapters/errors.js';
import { resolveRunner, validateRunnerCapabilities } from '../runner.js';
import type { Runner, LoopReturn, RunOutcome } from './runtime.js';
import { executeLoopStep } from './execution.js';
import type { OwnershipContext } from '../run-ownership.js';
import type { RunnerOverrideMap } from '../runner-overrides.js';
import type { Step } from '../state.js';
import { quarantineArtifact, quarantineInterruptedResume } from '../interrupted-artifact.js';
import { validateImplementLedger } from '../implement-ledger.js';
import { promptRunners } from '../interactive.js';
import { makeRunEvent } from '../run-event.js';
import { scanGlobalSnapshot } from '../artifact-index.js';

export type Binding = LoopBinding | TaskBinding;
export type BindingKind = 'loop' | 'task';

export interface BindingEngineOptions {
  maxIterations: number;
  globalOverrides?: { agent?: string; model?: string; effort?: string };
  interactive?: boolean;
  registry: AgentRegistry;
  output: CliOutput;
  ownership?: OwnershipContext | null;
  runnerOverrides?: RunnerOverrideMap;
  runContext?: RunContext;
  emitTerminal?: boolean;
}

interface StepRequest {
  phase: 'evaluate' | 'repair' | 'task';
  version: number;
  skillId: string;
  skill: SkillSpec;
  output: OutputSpec;
  priorArtifact: PriorArtifactResolution;
  parentArtifactIdentity: string | null;
}

interface PersistedArtifact {
  path: string;
  version: number;
  phase: 'evaluate' | 'repair' | 'task';
  mtime: number;
  meta: ArtifactMeta;
  decision?: DecisionOutcome;
  completion?: 'completed' | 'blocked' | 'unknown';
  classified: boolean;
  valid: boolean;
}

interface ContractResult {
  kind: 'accepted' | 'retry' | 'completed' | 'blocked' | 'valid' | 'unknown';
  detail?: string;
}

/**
 * The one execution engine for configured loops and tasks. A task is simply a
 * single binding invocation; loop repair/evaluate steps use the same provider,
 * ownership, contract, and provenance path.
 */
export async function runBinding(
  projectRoot: string,
  bindingId: string,
  bindingKind: BindingKind,
  binding: Binding,
  config: Config,
  suppliedRunners: Record<string, Runner>,
  options: BindingEngineOptions,
): Promise<LoopReturn> {
  quarantineInterruptedResume(projectRoot, {
    ...config.manifest.loops,
    ...(config.manifest.tasks ?? {}),
  });

  const runners = suppliedRunners;
  const executionSpec = toExecutionLoop(binding);
  const steps: Step[] = [];
  let lastArtifact: PersistedArtifact | null = null;
  let lastPath: string | null = null;

  const emit = (event: Parameters<CliOutput['emit']>[0]): void => options.output.emit(event);

  const finish = (
    outcome: RunOutcome,
    verdict: string,
    message: string,
  ): LoopReturn => {
    const success = outcome.kind === 'completed';
    if (outcome.kind === 'completed') {
      emit(makeRunEvent({ type: 'stage.completed', atMs: Date.now(), bindingId, bindingKind }));
    } else if (outcome.kind === 'blocked') {
      emit(makeRunEvent({ type: 'stage.blocked', atMs: Date.now(), bindingId, bindingKind }));
    } else if (outcome.kind === 'budget-exhausted') {
      emit(makeRunEvent({ type: 'stage.incomplete', atMs: Date.now(), bindingId, bindingKind, reason: message }));
    }
    if (options.emitTerminal !== false) {
      if (success) {
        emit(makeRunEvent({ type: 'run.completed', atMs: Date.now(), result: verdict, outcome: message }));
      } else {
        emit(makeRunEvent({ type: 'run.failed', atMs: Date.now(), reason: message, errorKind: outcome.kind }));
      }
    }
    options.output.finalSummary({
      success,
      verdict,
      message,
      lastAuditPath: lastPath,
      details: [`binding: ${bindingKind}/${bindingId}`],
    });
    return {
      success,
      verdict,
      message,
      lastAuditPath: lastPath,
      terminalEventEmitted: options.emitTerminal !== false,
      outcome,
    };
  };

  const loopBinding = bindingKind === 'loop' ? binding as LoopBinding : null;
  const taskBinding = bindingKind === 'task' ? binding as TaskBinding : null;
  const skillIds = taskBinding
    ? [taskBinding.skill]
    : [loopBinding!.evaluate.skill, loopBinding!.repair.skill];
  await resolveBindingRunners(skillIds, config, options, runners);

  const history = discoverArtifacts(projectRoot, bindingId, config);
  const latestClassified = history.filter(item => item.classified).at(-1);
  if (latestClassified && !latestClassified.valid) {
    const message = `latest ${latestClassified.phase} artifact is invalid at ${relative(projectRoot, latestClassified.path)}; resolve or quarantine it before continuing`;
    emit(makeRunEvent({
      type: latestClassified.phase === 'evaluate' ? 'decision.unknown' : 'artifact.unknown',
      atMs: Date.now(),
      path: relative(projectRoot, latestClassified.path),
      reason: message,
    } as any));
    return finish({ kind: 'unknown', message, artifactPath: latestClassified.path }, 'unknown', message);
  }
  const context = options.runContext ?? mintRunContext({ mode: 'ad-hoc' });
  const version = allocateVersion(projectRoot, binding, history, runners, bindingKind);
  const initial = initialRequest(binding, bindingKind, history, version, config, context);
  let request: StepRequest | null = initial;
  let evaluationCount = 0;

  while (request) {
    if (bindingKind === 'loop' && request.phase === 'evaluate' && evaluationCount >= options.maxIterations) {
      const message = `Iteration budget exhausted after ${evaluationCount} evaluator rounds; the latest retry remains available for a later continuation.`;
      return finish(
        { kind: 'budget-exhausted', message, artifactPath: lastPath },
        'retry',
        message,
      );
    }
    if (request.phase === 'evaluate') evaluationCount += 1;

    const runner = runners[request.skillId];
    if (!runner) {
      const message = `No runner resolved for skill '${request.skillId}'.`;
      return finish({ kind: 'unknown', message, artifactPath: lastPath }, 'unknown', message);
    }

    let result: RunResult;
    let durationMs = 0;
    const parentIdentityForLookup = request.parentArtifactIdentity;
    const predecessor = lastArtifact
      ?? history.find(item => item.meta.artifactIdentity === parentIdentityForLookup);
    const sessionStrategy = runner.sessionStrategy ?? (options.globalOverrides as any)?.sessionStrategy ?? (bindingKind === 'loop' && predecessor ? 'resume-per-skill' : 'fresh-per-invocation');
    const continuity = resolveContinuity(predecessor, runner, options.registry, sessionStrategy, request.skillId);
    // Prompt-semantic inputs are captured before the provider can mutate the
    // target or the referenced predecessor artifact.
    let inputFingerprint: string;
    try {
      inputFingerprint = buildInputFingerprint(projectRoot, binding, request, config);
    } catch (error: any) {
      const message = `Unable to resolve inputs for ${request.phase} v${request.version}: ${error?.message ?? String(error)}`;
      emit(makeRunEvent({ type: 'artifact.unknown', atMs: Date.now(), path: relative(projectRoot, renderPattern(request.output.pattern, { version: request.version, provider: runner.agent })), reason: message }));
      return finish({ kind: 'unknown', message, artifactPath: lastPath }, 'unknown', message);
    }
    try {
      const prompt = buildPrompt(projectRoot, config, binding, request, runner);
      const execution = await executeLoopStep(
        {
          projectRoot,
          loopName: bindingId,
          bindingKind,
          loopSpec: executionSpec,
          config,
          registry: options.registry,
          output: options.output,
          steps,
          maxIterations: options.maxIterations,
          ownership: options.ownership,
          runContext: context,
        },
        {
          runner,
          prompt,
          spawnLabel: `Running ${request.skillId} v${request.version}...`,
          kind: request.phase,
          skillId: request.skillId,
          version: request.version,
          iteration: evaluationCount,
          continuity,
          sessionStrategy,
          inputFingerprint,
        },
      );
      if (execution.kind === 'ownership-lost') {
        const message = execution.reason
          ? `Ownership of the run was lost: ${execution.reason}.`
          : 'Ownership of the run was lost.';
        return finish({ kind: 'ownership-lost', message, artifactPath: lastPath }, 'ownership-lost', message);
      }
      result = execution.result;
      durationMs = execution.durationMs;
    } catch (error: any) {
      const message = `${request.skillId} failed: ${error?.message ?? String(error)}`;
      options.output.stepFailed({
        kind: request.phase,
        skillId: request.skillId,
        version: request.version,
        message,
        errorKind: 'spawn',
      });
      return finish({ kind: 'provider-failed', message, errorKind: 'spawn', artifactPath: lastPath }, 'unknown', message);
    }

    const outputPath = resolve(projectRoot, renderPattern(request.output.pattern, {
      version: request.version,
      provider: runner.agent,
    }));
    const providerFailure = providerFailureResult(result);
    if (providerFailure) {
      if (result.error?.kind === 'auth') {
        quarantineArtifact(projectRoot, outputPath, { reason: 'auth' });
      }
      const message = structuredMessage(result, {
        label: request.phase,
        model: runner.model,
        agent: runner.agent,
      });
      options.output.stepFailed({
        kind: request.phase,
        skillId: request.skillId,
        version: request.version,
        message,
        errorKind: result.error?.kind ?? 'provider',
      });
      return finish(
        { kind: 'provider-failed', message, errorKind: result.error?.kind ?? 'provider', artifactPath: lastPath },
        'unknown',
        message,
      );
    }

    if (!existsSync(outputPath)) {
      const message = `${runner.agent} exited cleanly but produced no artifact at ${relative(projectRoot, outputPath)}.`;
      emit(makeRunEvent({ type: 'artifact.missing', atMs: Date.now(), path: relative(projectRoot, outputPath), reason: message }));
      options.output.stepFailed({
        kind: request.phase,
        skillId: request.skillId,
        version: request.version,
        message,
        errorKind: 'missing_output',
      });
      return finish({ kind: 'unknown', message, artifactPath: lastPath }, 'unknown', message);
    }

    const body = readFileSync(outputPath, 'utf8');
    const contract = validateOutput(request.output, body, outputPath);
    if (contract.kind === 'unknown') {
      const message = `${request.phase} artifact is invalid at ${relative(projectRoot, outputPath)}${contract.detail ? `: ${contract.detail}` : '.'}`;
      emit(makeRunEvent({ type: request.phase === 'evaluate' ? 'decision.unknown' : 'artifact.unknown', atMs: Date.now(), path: relative(projectRoot, outputPath), reason: message } as any));
      options.output.stepFailed({
        kind: request.phase,
        skillId: request.skillId,
        version: request.version,
        message,
        errorKind: 'invalid_output',
      });
      return finish({ kind: 'unknown', message, artifactPath: lastPath }, 'unknown', message);
    }

    if (contract.kind === 'accepted' || contract.kind === 'retry') {
      emit(makeRunEvent({ type: 'decision.parsed', atMs: Date.now(), decision: contract.kind }));
    } else if (contract.kind === 'completed' || contract.kind === 'blocked') {
      emit(makeRunEvent({ type: 'completion.parsed', atMs: Date.now(), outcome: contract.kind }));
    }

    const resultFingerprint = captureTargetFingerprint(projectRoot, binding.target, config.manifest);
    const sessionMode = continuity.mode;
    const sessionId = result.sessionId ?? 'none';
    const parentArtifactIdentity = lastArtifact?.meta.artifactIdentity ?? request.parentArtifactIdentity ?? null;
    const artifactIdentity = computeArtifactIdentity({
      schemaVersion: 1,
      pipelineId: context.pipelineId,
      pipelineRunId: context.pipelineRunId,
      stageId: context.stageId,
      bindingKind,
      bindingId,
      chainId: context.chainId,
      chainMode: context.chainMode,
      step: request.phase,
      version: request.version,
      provider: runner.agent,
      model: runner.model,
      effort: runner.effort,
      sessionMode,
      sessionId,
      parentArtifactIdentity,
      inputFingerprint,
      resultFingerprint,
    });
    const skill = request.skill;
    const meta = buildMeta({
      bindingId,
      bindingKind,
      context,
      request,
      skill,
      runner,
      durationMs,
      sessionMode,
      sessionId,
      sessionStrategy,
      parentArtifactIdentity,
      artifactIdentity,
      inputFingerprint,
      resultFingerprint,
      projectRoot,
      targetPath: binding.target.kind === 'worktree'
        ? '.'
        : relative(projectRoot, resolve(projectRoot, binding.target.path)),
    });
    writeArtifactWithMeta(outputPath, body, meta);
    const persistedArtifact: PersistedArtifact = {
      path: outputPath,
      version: request.version,
      phase: request.phase,
      mtime: statSync(outputPath).mtimeMs,
      meta,
      decision: contract.kind === 'accepted' || contract.kind === 'retry' ? contract.kind : undefined,
      completion: contract.kind === 'completed' || contract.kind === 'blocked' ? contract.kind : undefined,
      classified: true,
      valid: true,
    };
    lastArtifact = persistedArtifact;
    lastPath = outputPath;
    steps.push(stepFromArtifact(persistedArtifact, request));
    options.output.stepSucceeded({
      kind: request.phase,
      skillId: request.skillId,
      version: request.version,
      message: `${request.skillId} completed and wrote ${relative(projectRoot, outputPath)}`,
    });
    emit(makeRunEvent({ type: 'artifact.verified', atMs: Date.now(), path: relative(projectRoot, outputPath), result: contract.kind }));

    if (bindingKind === 'task') {
      const contractKind = contract.kind as string;
      if (contractKind === 'blocked' || contractKind === 'retry') {
        const message = `${bindingId} ended with non-completed decision/outcome (${contractKind}): ${contract.detail ?? 'task output did not pass contract'}`;
        return finish({ kind: 'blocked', message, artifactPath: lastPath }, 'blocked', message);
      }
      if (contractKind === 'unknown') {
        const message = `${bindingId} task artifact is invalid at ${relative(projectRoot, outputPath)}.`;
        return finish({ kind: 'unknown', message, artifactPath: lastPath }, 'unknown', message);
      }
      return finish({ kind: 'completed', message: `${bindingId} completed successfully.`, artifactPath: lastPath }, 'accepted', `${bindingId} completed successfully.`);
    }

    if (request.phase === 'evaluate') {
      if (contract.kind === 'accepted' || contract.kind === 'valid' || contract.kind === 'completed') {
        const message = `${bindingId} accepted at version ${request.version}.`;
        return finish({ kind: 'completed', message, artifactPath: lastPath }, 'accepted', message);
      }
      if (contract.kind === 'blocked') {
        const message = `${bindingId} is blocked at version ${request.version}.`;
        return finish({ kind: 'blocked', message, artifactPath: lastPath }, 'blocked', message);
      }
      if (evaluationCount >= options.maxIterations) {
        const message = `Iteration budget exhausted after ${evaluationCount} evaluator rounds; the latest retry remains available for a later continuation.`;
        return finish({ kind: 'budget-exhausted', message, artifactPath: lastPath }, 'retry', message);
      }
      const repair = loopBinding!.repair;
      request = {
        phase: 'repair',
        version: request.version,
        skillId: repair.skill,
        skill: config.manifest.skills[repair.skill]!,
        output: repair.output,
        priorArtifact: resolvePriorArtifact(outputPath, artifactIdentity, body),
        parentArtifactIdentity: artifactIdentity,
      };
      continue;
    }

    if (contract.kind === 'blocked') {
      const message = `${bindingId} repair is blocked at version ${request.version}.`;
      return finish({ kind: 'blocked', message, artifactPath: lastPath }, 'blocked', message);
    }
      request = nextEvaluationRequest(loopBinding!, config, request.version + 1, outputPath, artifactIdentity, body);
  }

  const message = `${bindingId} stopped without a terminal result.`;
  return finish({ kind: 'unknown', message, artifactPath: lastPath }, 'unknown', message);
}

function toExecutionLoop(binding: Binding): LoopSpec {
  if ('type' in binding) return binding;
  return {
    type: 'approval-loop',
    target: binding.target,
    inputs: binding.inputs,
    files: binding.files,
    evaluate: { skill: binding.skill, output: binding.output },
    repair: { skill: binding.skill, output: binding.output },
  };
}

async function resolveBindingRunners(
  skillIds: string[],
  config: Config,
  options: BindingEngineOptions,
  runners: Record<string, Runner>,
): Promise<void> {
  const missing = [...new Set(skillIds)].filter((skillId) => !runners[skillId]);
  if (missing.length > 0 && options.interactive) {
    const selected = await promptRunners(missing, config, options.registry, options.globalOverrides);
    Object.assign(runners, selected);
  }
  for (const skillId of [...new Set(skillIds)]) {
    if (runners[skillId]) continue;
    const runner = resolveRunner(
      skillId,
      config,
      options.globalOverrides,
      undefined,
      options.runnerOverrides?.[skillId],
      options.globalOverrides?.effort,
    );
    runners[skillId] = runner;
    validateRunnerCapabilities(runner, options.registry);
    options.output.emit(makeRunEvent({
      type: 'runner.resolved',
      atMs: Date.now(),
      skillId,
      agent: runner.agent,
      model: runner.model,
      effort: runner.effort,
      effortSource: runner.effortSource,
      agentSource: runner.agentSource,
      modelSource: runner.modelSource,
    }));
  }
}

function buildPrompt(
  projectRoot: string,
  config: Config,
  binding: Binding,
  request: StepRequest,
  runner: Runner,
): string {
  const roleFile = config.manifest.roles[request.skill.role];
  if (!roleFile) throw new Error(`Role file '${request.skill.role}' not found in manifest.`);
  return composePrompt(
    request.skillId,
    roleFile,
    request.skill.file,
    binding.inputs,
    {
      projectRoot,
      target: binding.target,
      version: request.version,
      provider: runner.agent,
      priorArtifact: request.priorArtifact,
      outputPattern: request.output.pattern,
      files: binding.files,
    },
    config.manifestRoot,
  );
}

function buildInputFingerprint(
  projectRoot: string,
  binding: Binding,
  request: StepRequest,
  config: Config,
): string {
  const targetDigest = captureTargetFingerprint(projectRoot, binding.target, config.manifest);
  return computeInputFingerprint({
    targetDigest,
    priorArtifact: request.priorArtifact,
    fileDigests: captureFileDigests(projectRoot, binding.files),
  });
}

function buildMeta(params: {
  bindingId: string;
  bindingKind: BindingKind;
  context: RunContext;
  request: StepRequest;
  skill: SkillSpec;
  runner: Runner;
  durationMs: number;
  sessionMode: 'fresh' | 'resumed' | 'none';
  sessionId: string;
  sessionStrategy?: string;
  parentArtifactIdentity: string | null;
  artifactIdentity: string;
  inputFingerprint: string;
  resultFingerprint: string;
  projectRoot: string;
  targetPath: string;
}): ArtifactMeta {
  return {
    loop: params.bindingId,
    skill: params.request.skillId,
    kind: params.request.phase,
    role: params.skill.role,
    version: params.request.version,
    step: params.request.phase,
    agent: params.runner.agent,
    provider: params.runner.agent,
    model: params.runner.model,
    effort: params.runner.effort,
    target: params.targetPath,
    priorAudit: isPriorNone(params.request.priorArtifact)
      ? 'none'
      : relative(params.projectRoot, params.request.priorArtifact.path),
    timestamp: new Date().toISOString(),
    durationMs: params.durationMs,
    sessionMode: params.sessionMode,
    sessionId: params.sessionId,
    sessionStrategy: params.sessionStrategy ?? 'fresh-per-invocation',
    schemaVersion: 1,
    bindingKind: params.bindingKind,
    bindingId: params.bindingId,
    chainId: params.context.chainId,
    chainMode: params.context.chainMode,
    artifactIdentity: params.artifactIdentity,
    inputFingerprint: params.inputFingerprint,
    resultFingerprint: params.resultFingerprint,
    parentArtifactIdentity: params.parentArtifactIdentity,
    pipelineId: params.context.pipelineId,
    pipelineRunId: params.context.pipelineRunId,
    stageId: params.context.stageId,
  };
}

function isPriorNone(prior: PriorArtifactResolution): prior is { kind: 'none' } {
  return 'kind' in prior;
}

function providerFailureResult(result: RunResult): boolean {
  return Boolean(result.error) || result.exitCode !== 0 || result.completion === 'truncated' || result.completion === 'interrupted' || result.completion === 'missing';
}

function validateOutput(output: OutputSpec, body: string, path: string): ContractResult {
  try {
    switch (output.contract) {
      case 'decision-artifact': {
        if (!output.decision) return { kind: 'unknown', detail: 'decision configuration is missing' };
        return { kind: parseDecisionContent(body, output.decision.heading, output.decision.accepted, output.decision.retry) };
      }
      case 'completion-artifact': {
        const result = parseCompletionContent(body);
        return result === 'COMPLETED'
          ? { kind: 'completed' }
          : result === 'BLOCKED'
            ? { kind: 'blocked' }
            : { kind: 'unknown', detail: 'exactly one Outcome section with COMPLETED or BLOCKED is required' };
      }
      case 'required-artifact': {
        if (!body.trim()) return { kind: 'unknown', detail: 'artifact is empty' };
        if (output.validator === 'implement-ledger' && !validateImplementLedger(body).valid) {
          return { kind: 'unknown', detail: 'implementation evidence ledger validator failed' };
        }
        return { kind: 'valid' };
      }
      default:
        return { kind: 'unknown', detail: `unsupported contract for ${path}` };
    }
  } catch (error: any) {
    return { kind: 'unknown', detail: error?.message ?? String(error) };
  }
}

function initialRequest(
  binding: Binding,
  bindingKind: BindingKind,
  history: PersistedArtifact[],
  version: number,
  config: Config,
  context: RunContext,
): StepRequest {
  if (bindingKind === 'task') {
    const task = binding as TaskBinding;
    let priorArtifact = priorArtifactNone();
    if (context.chainMode === 'stage-continuation' && context.parentArtifactIdentity) {
      const globalSnapshot = scanGlobalSnapshot(config.projectRoot, config.manifest);
      const predStep = globalSnapshot.steps.find(s => s.artifactIdentity === context.parentArtifactIdentity);
      if (predStep) {
        try {
          priorArtifact = resolvePriorArtifact(predStep.artifactPath, predStep.artifactIdentity!, readFileSync(predStep.artifactPath));
        } catch {
          priorArtifact = priorArtifactNone();
        }
      }
    }
    return {
      phase: 'task',
      version,
      skillId: task.skill,
      skill: config.manifest.skills[task.skill]!,
      output: task.output,
      priorArtifact,
      parentArtifactIdentity: context.parentArtifactIdentity ?? null,
    };
  }

  const loop = binding as LoopBinding;

  if (context.chainMode === 'ad-hoc' || context.chainMode === 'pipeline-start' || context.chainMode === 'second-opinion') {
    return {
      phase: 'evaluate',
      version,
      skillId: loop.evaluate.skill,
      skill: config.manifest.skills[loop.evaluate.skill]!,
      output: loop.evaluate.output,
      priorArtifact: priorArtifactNone(),
      parentArtifactIdentity: null,
    };
  }

  if (context.chainMode === 'stage-continuation') {
    let prior = priorArtifactNone();
    if (context.parentArtifactIdentity) {
      const globalSnapshot = scanGlobalSnapshot(config.projectRoot, config.manifest);
      const predStep = globalSnapshot.steps.find(s => s.artifactIdentity === context.parentArtifactIdentity);
      if (predStep) {
        try {
          prior = resolvePriorArtifact(predStep.artifactPath, predStep.artifactIdentity!, readFileSync(predStep.artifactPath));
        } catch {
          prior = priorArtifactNone();
        }
      }
    }
    return {
      phase: 'evaluate',
      version,
      skillId: loop.evaluate.skill,
      skill: config.manifest.skills[loop.evaluate.skill]!,
      output: loop.evaluate.output,
      priorArtifact: prior,
      parentArtifactIdentity: context.parentArtifactIdentity ?? null,
    };
  }

  const chainHistory = history.filter((item) => item.meta.chainId === context.chainId);
  const latestEvaluate = chainHistory.filter((item) => item.phase === 'evaluate' && item.classified && item.valid).at(-1);
  const latestRepair = chainHistory.filter((item) => item.phase === 'repair' && item.classified && item.valid).at(-1);
  const pendingRepair = latestEvaluate?.decision === 'retry' && (!latestRepair || latestRepair.version !== latestEvaluate.version || !latestRepair.valid);

  if (pendingRepair && latestEvaluate) {
    return {
      phase: 'repair',
      version: latestEvaluate.version,
      skillId: loop.repair.skill,
      skill: config.manifest.skills[loop.repair.skill]!,
      output: loop.repair.output,
      priorArtifact: priorForPersisted(latestEvaluate),
      parentArtifactIdentity: latestEvaluate.meta.artifactIdentity ?? null,
    };
  }
  const prior = latestRepair?.valid && latestEvaluate?.decision === 'retry'
    ? priorForPersisted(latestRepair)
    : priorArtifactNone();
  return {
    phase: 'evaluate',
    version: latestRepair?.valid && latestEvaluate?.decision === 'retry' ? latestEvaluate.version + 1 : version,
    skillId: loop.evaluate.skill,
    skill: config.manifest.skills[loop.evaluate.skill]!,
    output: loop.evaluate.output,
    priorArtifact: prior,
    parentArtifactIdentity: latestRepair?.valid && latestEvaluate?.decision === 'retry'
      ? latestRepair.meta.artifactIdentity ?? null
      : null,
  };
}

function resolveContinuity(
  predecessor: PersistedArtifact | undefined,
  runner: Runner,
  registry: AgentRegistry,
  sessionStrategy: string = 'fresh-per-invocation',
  skillId: string,
): { mode: 'fresh' | 'resumed'; sessionId?: string } {
  if (sessionStrategy === 'fresh-per-invocation') return { mode: 'fresh' };
  if (!predecessor) return { mode: 'fresh' };
  if (predecessor.meta.skill !== skillId) return { mode: 'fresh' };
  const sessionId = predecessor.meta.sessionId;
  if (!sessionId || sessionId === 'none') return { mode: 'fresh' };
  if (predecessor.meta.agent !== runner.agent
    || predecessor.meta.model !== runner.model
    || (predecessor.meta.effort ?? undefined) !== (runner.effort ?? undefined)) {
    return { mode: 'fresh' };
  }
  let adapter;
  try {
    adapter = getAdapter(registry, runner.agent);
  } catch {
    return { mode: 'fresh' };
  }
  return adapter.capabilities.resumeSession
    ? { mode: 'resumed', sessionId }
    : { mode: 'fresh' };
}

function nextEvaluationRequest(
  binding: LoopBinding,
  config: Config,
  version: number,
  previousPath: string,
  previousIdentity: string,
  previousBody: string,
): StepRequest {
  return {
    phase: 'evaluate',
    version,
    skillId: binding.evaluate.skill,
    skill: config.manifest.skills[binding.evaluate.skill]!,
    output: binding.evaluate.output,
    priorArtifact: resolvePriorArtifact(previousPath, previousIdentity, previousBody),
    parentArtifactIdentity: previousIdentity,
  };
}

function priorForPersisted(item: PersistedArtifact): PriorArtifactResolution {
  try {
    return resolvePriorArtifact(item.path, item.meta.artifactIdentity ?? null, readFileSync(item.path));
  } catch {
    return priorArtifactNone();
  }
}

function discoverArtifacts(projectRoot: string, bindingId: string, config: Config): PersistedArtifact[] {
  const snapshot = scanGlobalSnapshot(projectRoot, config.manifest);
  const bindingSteps = snapshot.byBinding.get(bindingId) ?? [];
  return bindingSteps.map(step => ({
    path: step.artifactPath,
    version: step.version,
    phase: step.kind === 'repair' ? 'repair' : step.kind === 'task' ? 'task' : 'evaluate',
    mtime: step.mtime,
    meta: {
      loop: step.bindingId ?? bindingId,
      skill: step.role,
      kind: step.kind,
      role: step.role,
      agent: step.agent,
      model: step.model,
      version: step.version,
      target: '.',
      priorAudit: 'none',
      timestamp: new Date(step.mtime).toISOString(),
      durationMs: step.durationMs,
      sessionMode: step.sessionMode,
      sessionId: step.sessionId,
      pipelineId: step.pipelineId,
      pipelineRunId: step.pipelineRunId,
      stageId: step.stageId,
      chainId: step.chainId,
      chainMode: step.chainMode as any,
      artifactIdentity: step.artifactIdentity,
      inputFingerprint: step.inputFingerprint,
      resultFingerprint: step.resultFingerprint,
      parentArtifactIdentity: step.parentArtifactIdentity,
      effort: step.effort,
      provider: step.provider,
    },
    decision: step.decision as any,
    completion: step.completionOutcome as any,
    classified: !step.unclassified,
    valid: step.contractValid !== false && !step.unclassified,
  }));
}

function bindingKindOutputs(binding: Binding): Array<{ phase: PersistedArtifact['phase']; output: OutputSpec }> {
  if ('type' in binding) {
    return [
      { phase: 'evaluate', output: binding.evaluate.output },
      { phase: 'repair', output: binding.repair.output },
    ];
  }
  return [{ phase: 'task', output: binding.output }];
}

function allocateVersion(
  projectRoot: string,
  binding: Binding,
  history: PersistedArtifact[],
  runners: Record<string, Runner>,
  bindingKind: BindingKind,
): number {
  const max = history.reduce((value, item) => Math.max(value, item.version), 0);
  const provider = bindingKind === 'task'
    ? runners[(binding as TaskBinding).skill]?.agent
    : runners[(binding as LoopBinding).evaluate.skill]?.agent;
  if (!provider) return max + 1;
  let version = max + 1;
  const outputs = bindingKindOutputs(binding).map((item) => item.output.pattern);
  while (outputs.some((pattern) => existsSync(resolve(projectRoot, renderPattern(pattern, { version, provider }))))) {
    version += 1;
  }
  return version;
}

function stepFromArtifact(item: PersistedArtifact, request: StepRequest): Step {
  return {
    kind: request.phase,
    role: request.skill.role,
    agent: item.meta.agent,
    model: item.meta.model,
    version: item.version,
    status: 'done',
    artifactPath: item.path,
    mtime: item.mtime,
    durationMs: item.meta.durationMs,
    sessionMode: item.meta.sessionMode,
    sessionId: item.meta.sessionId,
    decision: item.decision,
    verdict: item.decision,
    completionOutcome: item.completion,
    outcome: item.completion,
    pipelineId: item.meta.pipelineId,
    pipelineRunId: item.meta.pipelineRunId,
    stageId: item.meta.stageId,
    chainId: item.meta.chainId,
    chainMode: item.meta.chainMode,
    artifactIdentity: item.meta.artifactIdentity,
    inputFingerprint: item.meta.inputFingerprint,
    resultFingerprint: item.meta.resultFingerprint,
    parentArtifactIdentity: item.meta.parentArtifactIdentity,
    provider: item.meta.provider,
    effort: item.meta.effort,
  };
}
