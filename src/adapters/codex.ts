import type { AgentAdapter, RunInput, RunResult } from './types.js';
import { spawnAgentProcess, resolveCodexTimeoutMs, type ProcessRunner } from './utils.js';

export interface CreateCodexAdapterOptions {
  /** Config-tier watchdog deadline in ms (0 / unset disables). */
  defaultTimeoutMs?: number;
  /**
   * Test seam: replaces the inner process runner for lifecycle/timeout tests,
   * independent of real-binary runs. Production code never passes this.
   */
  processRunner?: ProcessRunner;
}

export function createCodexAdapter(opts: CreateCodexAdapterOptions = {}): AgentAdapter {
  const defaultTimeoutMs = opts.defaultTimeoutMs;
  const processRunner = opts.processRunner;
  return {
    name: 'codex',

    buildRun(input: RunInput): { command: string; args: string[] } {
      return {
        command: 'codex',
        args: [
          'exec',
          '-m',
          input.model,
          '--skip-git-repo-check',
          // Headless autonomy: skip all approval prompts + sandbox so non-interactive runs can write artifacts.
          '--dangerously-bypass-approvals-and-sandbox',
          input.prompt
        ]
      };
    },

    async run(input: RunInput): Promise<RunResult> {
      const { command, args } = this.buildRun(input);
      // codex is config-only: timeouts.codex > built-in 0; no env var.
      return spawnAgentProcess(command, args, input.cwd, {
        agent: this.name,
        model: input.model,
        skillId: input.skillId,
        version: input.version,
        onLifecycle: input.onLifecycle,
        timeoutMs: resolveCodexTimeoutMs({ defaultTimeoutMs })
      }, processRunner);
    }
  };
}

/** Registry-facing default (no configured timeout). */
export const codexAdapter = createCodexAdapter();
