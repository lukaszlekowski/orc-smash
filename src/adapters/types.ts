export interface RunInput {
  prompt: string;
  model: string;
  cwd: string;
}

export interface RunResult {
  stdout: string;
  exitCode: number;
}

export interface AgentAdapter {
  name: string;
  buildRun(input: RunInput): { command: string; args: string[] };
  run(input: RunInput): Promise<RunResult>;
}

export const adapterRegistry = new Map<string, AgentAdapter>();

export function registerAdapter(adapter: AgentAdapter): void {
  adapterRegistry.set(adapter.name, adapter);
}

export function getAdapter(name: string): AgentAdapter {
  const adapter = adapterRegistry.get(name);
  if (!adapter) {
    const known = [...adapterRegistry.keys()].join(' | ');
    throw new Error(`unknown agent '${name}'; expected ${known}`);
  }
  return adapter;
}

import { opencodeAdapter } from './opencode.js';
import { codexAdapter } from './codex.js';
import { claudeAdapter } from './claude.js';
import { fakeAdapter } from './fake.js';

registerAdapter(opencodeAdapter);
registerAdapter(codexAdapter);
registerAdapter(claudeAdapter);
registerAdapter(fakeAdapter);
