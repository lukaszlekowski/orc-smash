import type { AgentAdapter, RunInput, RunResult } from './types.js';
import { spawnAgentProcess } from './utils.js';

export const opencodeAdapter: AgentAdapter = {
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
    const { command, args } = this.buildRun(input);
    return spawnAgentProcess(command, args, input.cwd);
  }
};
