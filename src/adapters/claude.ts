import type { AgentAdapter, RunInput, RunResult } from './types.js';
import { spawnAgentProcess, resolveClaudeTimeoutMs, type ProcessRunner } from './utils.js';
import { debugCommandBuild } from '../debug-spawn.js';
import { ClaudeStreamParser } from './claude-stream.js';
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
    capabilities: { resumeSession: true, effort: true, progress: 'structured' },

    buildRun(input: RunInput): { command: string; args: string[] } {
      const args = [
        '-p',
        input.prompt,
        '--model',
        input.model
      ];
      if (input.effort) {
        args.push('--effort', input.effort);
      }
      args.push('--output-format', 'stream-json', '--verbose');
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

      const parser = new ClaudeStreamParser({ agent: this.name, version: input.version });

      const onStdoutChunk = (chunk: string) => {
        const events = parser.push(chunk);
        for (const event of events) {
          input.onLifecycle?.(event);
        }
      };

      // claude is config-only: timeouts.claude > built-in 0; no env var.
      const result = await spawnAgentProcess(command, args, input.cwd, {
        agent: this.name,
        model: input.model,
        skillId: input.skillId,
        version: input.version,
        onLifecycle: input.onLifecycle,
        timeoutMs: resolveClaudeTimeoutMs({ defaultTimeoutMs }),
        spawnRuntime: groupRuntime ?? input.spawnRuntime,
        ownership: input.ownership,
        onStdoutChunk,
        adapterFinalized: true,
      }, processRunner);

      if (result.error || result.exitCode !== 0) {
        return result;
      }

      try {
        const parsed = parser.finish();
        if (input.continuity?.mode === 'resumed' && input.continuity.sessionId) {
          if (parsed.sessionId !== input.continuity.sessionId) {
            throw new Error(`Resumed thread ID mismatch: expected ${input.continuity.sessionId}, got ${parsed.sessionId}`);
          }
        }

        if (input.onLifecycle && input.version !== undefined) {
          input.onLifecycle({
            type: 'completed',
            agent: this.name,
            version: input.version,
            atMs: Date.now(),
          });
        }

        return {
          ...result,
          stdout: parsed.assistantText,
          sessionId: parsed.sessionId
        };
      } catch (err: any) {
        if (input.onLifecycle && input.version !== undefined) {
          input.onLifecycle({
            type: 'failed',
            agent: this.name,
            version: input.version,
            errorKind: 'server',
            atMs: Date.now(),
          });
        }
        return {
          ...result,
          error: {
            kind: 'server',
            message: err.message
          }
        };
      }
    }
  };
}

/** Registry-facing default (no configured timeout). */
export const claudeAdapter = createClaudeAdapter();
