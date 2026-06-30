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
        // Headless autonomy: skip all approval prompts + sandbox so non-interactive runs can write artifacts.
        '--dangerously-bypass-approvals-and-sandbox',
        input.prompt
      ]
    };
  },

  async run(input: RunInput): Promise<RunResult> {
    const { command, args } = this.buildRun(input);
    return spawnAgentProcess(command, args, input.cwd, {
      agent: this.name,
      model: input.model,
      skillId: input.skillId,
      version: input.version,
      onLifecycle: input.onLifecycle
    });
  }
};
