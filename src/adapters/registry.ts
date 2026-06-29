import type { AgentAdapter } from './types.js';
import { opencodeAdapter } from './opencode.js';
import { codexAdapter } from './codex.js';
import { claudeAdapter } from './claude.js';

export interface AgentRegistry {
  adapters: Map<string, AgentAdapter>;
}

export function createProductionAdapterRegistry(): AgentRegistry {
  const adapters = new Map<string, AgentAdapter>();
  adapters.set(opencodeAdapter.name, opencodeAdapter);
  adapters.set(codexAdapter.name, codexAdapter);
  adapters.set(claudeAdapter.name, claudeAdapter);
  return { adapters };
}

export function getAdapter(registry: AgentRegistry, name: string): AgentAdapter {
  const adapter = registry.adapters.get(name);
  if (!adapter) {
    const known = [...registry.adapters.keys()].join(' | ');
    throw new Error(`unknown agent '${name}'; expected ${known}`);
  }
  return adapter;
}
