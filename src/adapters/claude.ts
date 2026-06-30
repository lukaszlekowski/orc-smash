import type { AgentAdapter, RunInput, RunResult } from './types.js';
import { spawnAgentProcess } from './utils.js';
import { debugCommandBuild } from '../debug-spawn.js';

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
    debugCommandBuild({
      adapter: 'claude',
      command,
      args,
      cwd: input.cwd
    });
    return spawnAgentProcess(command, args, input.cwd, {
      agent: this.name,
      model: input.model,
      skillId: input.skillId,
      version: input.version,
      onLifecycle: input.onLifecycle
    });
  }
};
