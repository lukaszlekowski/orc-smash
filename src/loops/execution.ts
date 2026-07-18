import { getAdapter, type AgentRegistry } from '../adapters/registry.js';
import type { RunResult } from '../adapters/types.js';
import type { LifecycleEvent } from '../adapter-lifecycle.js';
import type { CliOutput } from '../cli-output.js';
import type { Config } from '../config.js';
import { debugLoopSpawn } from '../debug-spawn.js';
import { setStepCtx } from '../interrupted-artifact.js';
import { roleForKind, type Step } from '../state.js';
import { buildPanelContext, latestAuditVersion, resolveLoopLabels } from '../status.js';
import type { PanelContext } from '../status.js';
import type { StepKind } from '../provenance.js';
import type { LoopSpec } from '../manifest.js';
import type { Runner } from './runtime.js';
import type { OwnershipContext } from '../run-ownership.js';
import { OwnedSpawnRuntime } from '../adapters/process-group.js';
import { makeRunEvent, MAX_PROGRESS_EVENTS, PROGRESS_MAX_LENGTH, TOOL_CALL_DISPLAY_CAP } from '../run-event.js';

export interface LoopExecutionDeps {
  projectRoot: string;
  loopName: string;
  loopSpec: LoopSpec;
  config: Config;
  registry: AgentRegistry;
  output: CliOutput;
  steps: Step[];
  maxIterations: number;
  ownership?: OwnershipContext | null;
}

export interface ExecuteLoopStep {
  runner: Runner;
  prompt: string;
  spawnLabel: string;
  kind: StepKind;
  skillId: string;
  version: number;
  iteration: number;
  continuity?: { mode: 'fresh' | 'resumed'; sessionId?: string };
}

export type ExecuteLoopStepOutcome =
  | { kind: 'ran'; result: RunResult; durationMs: number }
  | { kind: 'ownership-lost'; reason?: string };

/** Executes one provider step while keeping UI and interrupt state scoped to a loop instance. */
export async function executeLoopStep(
  deps: LoopExecutionDeps,
  request: ExecuteLoopStep
): Promise<ExecuteLoopStepOutcome> {
  const { runner, prompt, spawnLabel, kind, skillId, version, iteration, continuity } = request;
  const startedAtMs = Date.now();
  const labels = resolveLoopLabels(deps.loopSpec, deps.config.manifest);
  let lastProgressMessage = '';
  let toolCallCount = 0;
  let distinctProgressCount = 0;
  let progressEmitted = 0;
  let progressSuppressed = 0;
  const progressSeen = new Set<string>();

  const normalizedProgress = (text: string): string => text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, PROGRESS_MAX_LENGTH);

  const emitProviderCompletion = (result: RunResult, failed: boolean): void => {
    if (progressSuppressed > 0 && progressEmitted < MAX_PROGRESS_EVENTS) {
      deps.output.emit(makeRunEvent({
        type: 'provider.progress',
        atMs: Date.now(),
        agent: runner.agent,
        message: 'progress suppressed'
      }));
      progressEmitted += 1;
    }
    const toolCalls = toolCallCount > TOOL_CALL_DISPLAY_CAP ? '999+' as const : toolCallCount;
    if (failed) {
      deps.output.emit(makeRunEvent({
        type: 'provider.failed',
        atMs: Date.now(),
        agent: runner.agent,
        errorKind: result.error?.kind ?? (result.exitCode !== 0 ? 'nonzero-exit' : undefined),
        toolCalls,
        progressEmitted,
        progressSuppressed
      }));
    } else {
      deps.output.emit(makeRunEvent({
        type: 'provider.completed',
        atMs: Date.now(),
        agent: runner.agent,
        toolCalls,
        progressEmitted,
        progressSuppressed
      }));
    }
  };
  let liveInFlight: NonNullable<PanelContext['inFlight']> | null = {
    kind,
    role: deps.config.manifest.skills[skillId]?.role ?? roleForKind(kind),
    skillId,
    agent: runner.agent,
    model: runner.model,
    version,
    iteration,
    startedAtMs,
    status: 'running',
    spawnLabel,
    toolCallCount,
    progressMessage: null
  };

  const onLifecycle = (event: LifecycleEvent) => {
    if (event.type === 'message') {
      if (event.text) lastProgressMessage = event.text;
      toolCallCount += event.toolCalls ?? 0;
      const message = normalizedProgress(event.text);
      if (message && !progressSeen.has(message)) {
        progressSeen.add(message);
        distinctProgressCount += 1;
        const shouldEmit = distinctProgressCount === 1 || (distinctProgressCount - 1) % 4 === 0;
        if (shouldEmit && progressEmitted < MAX_PROGRESS_EVENTS - 1) {
          deps.output.emit(makeRunEvent({ type: 'provider.progress', atMs: Date.now(), agent: runner.agent, message }));
          progressEmitted += 1;
        } else {
          progressSuppressed += 1;
        }
      }
      if (liveInFlight) {
        liveInFlight.toolCallCount = toolCallCount;
        liveInFlight.progressMessage = lastProgressMessage || null;
      }
    }
    if (event.type === 'failed' && liveInFlight) liveInFlight.status = 'failed';
    if (event.type === 'completed') liveInFlight = null;
  };

  if (deps.output.attachLiveRegion) {
    deps.output.attachLiveRegion(() => {
      let activeLabel = skillId;
      if (kind === 'audit') activeLabel = labels.audit?.skillId ?? skillId;
      else if (kind === 'follow-up') activeLabel = labels.followUp?.skillId ?? skillId;
      else if (kind === 'implement') activeLabel = labels.implement?.skillId ?? skillId;

      return buildPanelContext(
        deps.projectRoot,
        deps.loopName,
        iteration,
        deps.maxIterations,
        { skillId, agent: runner.agent, model: runner.model },
        deps.steps,
        `Running ${activeLabel} v${version}...`,
        liveInFlight,
        latestAuditVersion(deps.steps),
        false
      );
    });
  }

  let watcher: { expired: Promise<void>; cancel(): void } | null = null;
  // The lease-expiry arm of the race MUST always resolve to an ownership-lost
  // outcome. `handleOwnershipLoss` records terminal ownership-failure state and
  // returns a structured result (it does not throw for expected terminal states
  // like unkillable survivors); the try/catch here is a defensive backstop so a
  // truly unexpected cleanup error can never reject the race and escape as a
  // generic transport failure in runLoop's error path.
  let ownershipLostPromise: Promise<{ kind: 'ownership-lost'; reason?: string }> = new Promise(() => {});

  if (deps.ownership) {
    const { watchLease } = await import('../run-ownership.js');
    watcher = watchLease(deps.ownership);
    ownershipLostPromise = watcher.expired.then(async () => {
      const { handleOwnershipLoss } = await import('../interrupted-artifact.js');
      let reason: string | undefined;
      try {
        const lossResult = await handleOwnershipLoss(deps.loopSpec, deps.ownership!);
        if (lossResult.kind === 'ownership-blocked') {
          reason = lossResult.reason;
        }
      } catch (err: any) {
        // handleOwnershipLoss resolves rather than throws for expected terminal
        // ownership states; reaching here is unexpected, but the step still
        // resolves to the ownership-lost outcome — never a generic escape.
        reason = (err as Error)?.message;
      }
      return { kind: 'ownership-lost' as const, reason };
    });
  }

  try {
    // Pre-step check
    if (deps.ownership) {
      const { readActive, mayStartStep } = await import('../run-ownership.js');
      const active = readActive(deps.ownership.runDir);
      if (!mayStartStep(deps.ownership.control, active, Date.now(), deps.ownership)) {
        if (watcher) watcher.cancel();
        deps.output.emit(makeRunEvent({ type: 'ownership.lost', atMs: Date.now(), reason: 'ownership fence rejected the step before spawn' }));
        return { kind: 'ownership-lost' };
      }
    }

    deps.output.stepStarted({ kind, skillId, agent: runner.agent, model: runner.model, iteration, version, message: spawnLabel });
    deps.output.emit(makeRunEvent({ type: 'provider.started', atMs: Date.now(), agent: runner.agent }));
    const adapter = getAdapter(deps.registry, runner.agent);
    debugLoopSpawn({ loopName: deps.loopName, skillId, kind, agent: runner.agent, model: runner.model, version, cwd: deps.projectRoot, prompt });
    setStepCtx({ loop: deps.loopName, kind, version, agent: runner.agent, model: runner.model, skillId });
    
    // Pre-spawn check
    if (deps.ownership) {
      const { readActive, mayStartStep } = await import('../run-ownership.js');
      const active = readActive(deps.ownership.runDir);
      if (!mayStartStep(deps.ownership.control, active, Date.now(), deps.ownership)) {
        if (watcher) watcher.cancel();
        deps.output.emit(makeRunEvent({ type: 'ownership.lost', atMs: Date.now(), reason: 'ownership fence rejected the provider spawn' }));
        return { kind: 'ownership-lost' };
      }
    }

    const runInput = {
      prompt,
      model: runner.model,
      cwd: deps.projectRoot,
      skillId,
      version,
      kind,
      onLifecycle,
      continuity,
      ownership: deps.ownership || undefined,
      spawnRuntime: deps.ownership ? new OwnedSpawnRuntime(deps.ownership.runId, deps.ownership.runDir) : undefined
    };

    const runPromise = adapter.run(runInput);
    let raceResult: { kind: 'ran'; result: RunResult } | { kind: 'ownership-lost'; reason?: string };
    try {
      raceResult = await Promise.race([
        runPromise.then((res) => ({ kind: 'ran' as const, result: res })),
        ownershipLostPromise
      ]);
    } catch (error) {
      const result: RunResult = { stdout: '', stderr: String(error), exitCode: 1, error: { kind: 'spawn', message: String(error) } };
      emitProviderCompletion(result, true);
      throw error;
    }

    if (raceResult.kind === 'ownership-lost') {
      deps.output.emit(makeRunEvent({ type: 'ownership.lost', atMs: Date.now(), reason: raceResult.reason }));
      const result: RunResult = { stdout: '', exitCode: 1, error: { kind: 'ownership', message: raceResult.reason ?? 'ownership lost' } };
      emitProviderCompletion(result, true);
      return { kind: 'ownership-lost', reason: raceResult.reason };
    }

    // Completion-side ownership fence
    if (deps.ownership) {
      const { ownershipFence } = await import('../run-ownership.js');
      const fencePassed = await ownershipFence(deps.ownership, deps.loopSpec);
      if (!fencePassed) {
        deps.output.emit(makeRunEvent({ type: 'ownership.lost', atMs: Date.now(), reason: 'ownership fence rejected provider completion' }));
        emitProviderCompletion({ ...raceResult.result, error: raceResult.result.error ?? { kind: 'ownership', message: 'ownership fence rejected provider completion' } }, true);
        return { kind: 'ownership-lost' };
      }
    }

    emitProviderCompletion(
      raceResult.result,
      Boolean(
        raceResult.result.error ||
        raceResult.result.exitCode !== 0 ||
        raceResult.result.completion === 'truncated' ||
        raceResult.result.completion === 'interrupted' ||
        raceResult.result.completion === 'missing'
      )
    );
    return { kind: 'ran', result: raceResult.result, durationMs: Date.now() - startedAtMs };
  } finally {
    if (watcher) {
      watcher.cancel();
    }
    setStepCtx(null);
    deps.output.detachLiveRegion?.();
  }
}
