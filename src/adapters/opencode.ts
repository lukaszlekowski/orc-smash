import type { AgentAdapter, RunInput, RunResult } from './types.js';
import { spawnOpencode, type ProcessRunner } from './utils.js';

export interface OpencodeSpawn {
  (input: RunInput, args: string[], options?: { defaultTimeoutMs?: number; processRunner?: ProcessRunner }): Promise<RunResult>;
}

export interface CreateOpencodeAdapterOptions {
  defaultTimeoutMs?: number;
  /**
   * Test seam: replaces the default `spawnOpencode` so the integration test
   * (Step 11) can observe the resolved timeout without spawning a real
   * process. Production code never passes this — `spawnOpencode` is the default.
   */
  spawn?: OpencodeSpawn;
  /**
   * Test seam: replaces the inner process runner for lifecycle tests,
   * independent of the spawn seam. Production code never passes this.
   */
  processRunner?: ProcessRunner;
}

export function createOpencodeAdapter(opts: CreateOpencodeAdapterOptions = {}): AgentAdapter {
  const defaultTimeoutMs = opts.defaultTimeoutMs;
  const spawn: OpencodeSpawn = opts.spawn ?? spawnOpencode;
  const processRunner = opts.processRunner;
  return {
    name: 'opencode',

    buildRun(input: RunInput): { command: string; args: string[] } {
      return {
        command: 'opencode',
        args: [
          'run',
          '-m',
          input.model,
          '--dir',
          input.cwd,
          '--dangerously-skip-permissions',
          '--format',
          'json',
          input.prompt
        ]
      };
    },

    async run(input: RunInput): Promise<RunResult> {
      const { args } = this.buildRun(input);
      return spawn(input, args, { defaultTimeoutMs, processRunner });
    }
  };
}

export const opencodeAdapter = createOpencodeAdapter();
