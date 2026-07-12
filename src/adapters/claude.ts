import type { AgentAdapter, RunInput, RunResult } from './types.js';
import { spawnAgentProcess, resolveClaudeTimeoutMs, type ProcessRunner } from './utils.js';
import { debugCommandBuild } from '../debug-spawn.js';
import { parseClaudeResult } from './claude-result.js';
import type { SpawnRuntime } from './process-group.js';

export interface CreateClaudeAdapterOptions {
  /** Config-tier watchdog deadline in ms (0 / unset disables). */
  defaultTimeoutMs?: number;
  /**
   * Test seam: replaces the inner process runner for lifecycle/timeout tests,
   * independent of real-binary runs. Production code never passes this.
   */
  processRunner?: ProcessRunner;
  groupRuntime?: SpawnRuntime;
}

export function createClaudeAdapter(opts: CreateClaudeAdapterOptions = {}): AgentAdapter {
  const defaultTimeoutMs = opts.defaultTimeoutMs;
  const processRunner = opts.processRunner;
  const groupRuntime = opts.groupRuntime;
  return {
    name: 'claude',

    buildRun(input: RunInput): { command: string; args: string[] } {
      const args = [
        '-p',
        input.prompt,
        '--model',
        input.model
      ];
      if (input.kind !== 'implement') {
        args.push('--output-format', 'json');
      }
      args.push(
        '--permission-mode',
        'bypassPermissions'
      );
      if (input.continuity?.mode === 'resumed' && input.continuity.sessionId) {
        args.push('--resume', input.continuity.sessionId);
      }
      return {
        command: 'claude',
        args
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
      const result = await spawnAgentProcess(command, args, input.cwd, {
        agent: this.name,
        model: input.model,
        skillId: input.skillId,
        version: input.version,
        onLifecycle: input.onLifecycle,
        timeoutMs: resolveClaudeTimeoutMs({ defaultTimeoutMs }),
        spawnRuntime: groupRuntime ?? input.spawnRuntime,
        ownership: input.ownership
      }, processRunner);

      if (!result.error && result.exitCode === 0) {
        if (input.kind === 'implement') {
          return result;
        }
        try {
          const parsed = parseClaudeResult(result.stdout);
          if (input.continuity?.mode === 'resumed' && input.continuity.sessionId) {
            if (parsed.sessionId !== input.continuity.sessionId) {
              throw new Error(`Resumed thread ID mismatch: expected ${input.continuity.sessionId}, got ${parsed.sessionId}`);
            }
          }
          return {
            ...result,
            stdout: parsed.assistantText,
            sessionId: parsed.sessionId
          };
        } catch (err: any) {
          return {
            ...result,
            error: {
              kind: 'server',
              message: err.message,
              raw: result.stdout
            }
          };
        }
      }

      return result;
    }
  };
}

/** Registry-facing default (no configured timeout). */
export const claudeAdapter = createClaudeAdapter();
