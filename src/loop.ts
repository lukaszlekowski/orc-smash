import type { Config } from './config.js';
import type { LoopSpec, TaskBinding } from './manifest.js';
import type { CliOutput } from './cli-output.js';
import type { AgentRegistry } from './adapters/registry.js';
import type { OwnershipContext } from './run-ownership.js';
import type { RunnerOverrideMap } from './runner-overrides.js';
import type { RunContext } from './pipeline-state.js';
import type { LoopReturn, Runner } from './loops/runtime.js';
import { runBinding } from './loops/binding-engine.js';

/** Options shared by the generic loop and one-off task executors. */
export interface LoopOptions {
  maxIterations: number;
  globalOverrides?: { agent?: string; model?: string; effort?: string };
  interactive?: boolean;
  registry: AgentRegistry;
  output: CliOutput;
  ownership?: OwnershipContext | null;
  runnerOverrides?: RunnerOverrideMap;
  runContext?: RunContext;
  /** smashAction owns terminal emission when false; direct callers default to true. */
  emitTerminal?: boolean;

  /** Deprecated migration input retained for source compatibility only. */
  seedResolved?: Set<string>;
}

/** Execute any configured approval-loop binding through the shared engine. */
export async function runLoop(
  projectRoot: string,
  loopName: string,
  loopSpec: LoopSpec | undefined,
  config: Config,
  runners: Record<string, Runner>,
  options: LoopOptions,
): Promise<LoopReturn> {
  // A direct caller from the pre-v1 surface may still pass the removed loop
  // entry for a binding that is now declared as a task. Resolve that through
  // the manifest without mutating it or creating a second execution engine.
  if (!loopSpec) {
    const task = config.manifest.tasks?.[loopName];
    if (task) return runTask(projectRoot, loopName, task, config, runners, options);
    throw new Error(`binding '${loopName}' is not a configured loop`);
  }
  return runBinding(projectRoot, loopName, 'loop', loopSpec, config, runners, options);
}

/** Execute one configured task exactly once through the same engine. */
export async function runTask(
  projectRoot: string,
  taskName: string,
  taskSpec: TaskBinding,
  config: Config,
  runners: Record<string, Runner>,
  options: LoopOptions,
): Promise<LoopReturn> {
  return runBinding(projectRoot, taskName, 'task', taskSpec, config, runners, options);
}
