import type { AgentAdapter, RunInput, RunResult } from './types.js';
import { spawnAgentProcess, resolveCodexTimeoutMs, type ProcessRunner } from './utils.js';
import { parseCodexJsonOutput } from './codex-json.js';
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

    buildRun(input: RunInput): { command: string; args: string[] } {
      const isContinuity = !!input.continuity;
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

      if (isContinuity) {
        args.push('--json');
      }

      args.push(input.prompt);

      return {
        command: 'codex',
        args
      };
    },

    async run(input: RunInput): Promise<RunResult> {
      const { command, args } = this.buildRun(input);
      // codex is config-only: timeouts.codex > built-in 0; no env var.
      const result = await spawnAgentProcess(command, args, input.cwd, {
        agent: this.name,
        model: input.model,
        skillId: input.skillId,
        version: input.version,
        onLifecycle: input.onLifecycle,
        timeoutMs: resolveCodexTimeoutMs({ defaultTimeoutMs }),
        spawnRuntime: groupRuntime ?? input.spawnRuntime,
        ownership: input.ownership
      }, processRunner);

      if (input.continuity && !result.error && result.exitCode === 0) {
        try {
          const parsed = parseCodexJsonOutput(result.stdout);
          if (input.continuity.mode === 'resumed' && input.continuity.sessionId) {
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
export const codexAdapter = createCodexAdapter();
