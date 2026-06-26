import type { AgentAdapter, RunInput, RunResult } from './types.js';
import { spawnAgentProcess } from './utils.js';

export const codexAdapter: AgentAdapter = {
  name: 'codex',

  buildRun(input: RunInput): { command: string; args: string[] } {
    return {
      command: 'codex',
      args: [
        'exec',
        '-m',
        input.model,
        '--skip-git-repo-check',
        input.prompt
      ]
    };
  },

  async run(input: RunInput): Promise<RunResult> {
    const { command, args } = this.buildRun(input);
    return spawnAgentProcess(command, args, input.cwd);
  }
};
