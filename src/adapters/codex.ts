import type { AgentAdapter, RunInput, RunResult } from './types.js';
import { spawnAgentProcess, resolveCodexTimeoutMs, type ProcessRunner } from './utils.js';
import { CodexJsonParser } from './codex-json.js';
import type { SpawnRuntime } from './process-group.js';

export interface CreateCodexAdapterOptions {
  /** Config-tier watchdog deadline in ms (0 / unset disables). */
  defaultTimeoutMs?: number;
  /**
   * Test seam: replaces the inner process runner for lifecycle/timeout tests,
   * independent of real-binary runs. Production code never passes this.
   */
  processRunner?: ProcessRunner;
  groupRuntime?: SpawnRuntime;
}
export function createCodexAdapter(opts: CreateCodexAdapterOptions = {}): AgentAdapter {
  const defaultTimeoutMs = opts.defaultTimeoutMs;
  const processRunner = opts.processRunner;
  const groupRuntime = opts.groupRuntime;
  return {
    name: 'codex',
    capabilities: { resumeSession: true, effort: true, progress: 'structured' },

    buildRun(input: RunInput): { command: string; args: string[] } {
      const isResumed = input.continuity?.mode === 'resumed';
      
      const args: string[] = [];
      if (isResumed && input.continuity?.sessionId) {
        args.push('exec', 'resume', input.continuity.sessionId);
      } else {
        args.push('exec');
      }

      args.push(
        '-m',
        input.model,
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox'
      );

      if (input.effort) {
        args.push('-c', `model_reasoning_effort=${input.effort}`);
      }

      args.push('--json');

      args.push(input.prompt);

      return {
        command: 'codex',
        args
      };
    },

    async run(input: RunInput): Promise<RunResult> {
      const { command, args } = this.buildRun(input);
      const parser = new CodexJsonParser({ agent: this.name, version: input.version });

      const onStdoutChunk = (chunk: string) => {
        const events = parser.push(chunk);
        for (const event of events) {
          input.onLifecycle?.(event);
        }
      };

      // codex is config-only: timeouts.codex > built-in 0; no env var.
      const result = await spawnAgentProcess(command, args, input.cwd, {
        agent: this.name,
        model: input.model,
        skillId: input.skillId,
        version: input.version,
        onLifecycle: input.onLifecycle,
        timeoutMs: resolveCodexTimeoutMs({ defaultTimeoutMs }),
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
          sessionId: parsed.sessionId,
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
            message: err.message,
          },
        };
      }
    }
  };
}

/** Registry-facing default (no configured timeout). */
export const codexAdapter = createCodexAdapter();
