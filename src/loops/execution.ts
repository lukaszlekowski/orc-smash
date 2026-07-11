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

export interface LoopExecutionDeps {
  projectRoot: string;
  loopName: string;
  loopSpec: LoopSpec;
  config: Config;
  registry: AgentRegistry;
  output: CliOutput;
  steps: Step[];
  maxIterations: number;
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

/** Executes one provider step while keeping UI and interrupt state scoped to a loop instance. */
export async function executeLoopStep(
  deps: LoopExecutionDeps,
  request: ExecuteLoopStep
): Promise<{ result: RunResult; durationMs: number }> {
  const { runner, prompt, spawnLabel, kind, skillId, version, iteration, continuity } = request;
  const startedAtMs = Date.now();
  const labels = resolveLoopLabels(deps.loopSpec, deps.config.manifest);
  let lastProgressMessage = '';
  let toolCallCount = 0;
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

  try {
    deps.output.stepStarted({ kind, skillId, agent: runner.agent, model: runner.model, iteration, version, message: spawnLabel });
    const adapter = getAdapter(deps.registry, runner.agent);
    debugLoopSpawn({ loopName: deps.loopName, skillId, kind, agent: runner.agent, model: runner.model, version, cwd: deps.projectRoot, prompt });
    setStepCtx({ loop: deps.loopName, kind, version, agent: runner.agent, model: runner.model, skillId });
    const result = await adapter.run({ prompt, model: runner.model, cwd: deps.projectRoot, skillId, version, kind, onLifecycle, continuity });
    return { result, durationMs: Date.now() - startedAtMs };
  } finally {
    setStepCtx(null);
    deps.output.detachLiveRegion?.();
  }
}
