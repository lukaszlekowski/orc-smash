import type { AgentAdapter, RunInput, RunResult } from './types.js';
import { spawnAgentProcess } from './utils.js';

export const claudeAdapter: AgentAdapter = {
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
    return spawnAgentProcess(command, args, input.cwd);
  }
};
