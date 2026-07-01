import type { AgentAdapter, RunInput, RunResult } from './types.js';
import { spawnAgentProcess, resolveClaudeTimeoutMs, type ProcessRunner } from './utils.js';
import { debugCommandBuild } from '../debug-spawn.js';

export interface CreateClaudeAdapterOptions {
  /** Config-tier watchdog deadline in ms (0 / unset disables). */
  defaultTimeoutMs?: number;
  /**
   * Test seam: replaces the inner process runner for lifecycle/timeout tests,
   * independent of real-binary runs. Production code never passes this.
   */
  processRunner?: ProcessRunner;
}

export function createClaudeAdapter(opts: CreateClaudeAdapterOptions = {}): AgentAdapter {
  const defaultTimeoutMs = opts.defaultTimeoutMs;
  const processRunner = opts.processRunner;
  return {
    name: 'claude',

    buildRun(input: RunInput): { command: string; args: string[] } {
      return {
        command: 'claude',
        args: [
          '-p',
          input.prompt,
          '--model',
          input.model,
          '--output-format',
          'json',
          '--permission-mode',
          'bypassPermissions'
        ]
      };
    },

    async run(input: RunInput): Promise<RunResult> {
      const { command, args } = this.buildRun(input);
      debugCommandBuild({
        adapter: 'claude',
        command,
        args,
        cwd: input.cwd
      });
      // claude is config-only: timeouts.claude > built-in 0; no env var.
      return spawnAgentProcess(command, args, input.cwd, {
        agent: this.name,
        model: input.model,
        skillId: input.skillId,
        version: input.version,
        onLifecycle: input.onLifecycle,
        timeoutMs: resolveClaudeTimeoutMs({ defaultTimeoutMs })
      }, processRunner);
    }
  };
}

/** Registry-facing default (no configured timeout). */
export const claudeAdapter = createClaudeAdapter();
