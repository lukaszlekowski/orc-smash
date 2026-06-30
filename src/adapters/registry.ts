import type { AgentAdapter } from './types.js';
import type { ModelRegistry } from '../config.js';
import { registryTimeoutFor } from '../config.js';
import { createOpencodeAdapter, type OpencodeSpawn } from './opencode.js';
import { codexAdapter } from './codex.js';
import { claudeAdapter } from './claude.js';

export interface AgentRegistry {
  adapters: Map<string, AgentAdapter>;
}

export interface CreateProductionRegistryOptions {
  /**
   * Test seam: forwarded to `createOpencodeAdapter` so the integration test
   * (Step 11) can observe the resolved timeout through the production wiring
   * without spawning a real process. Production code never passes this.
   */
  opencodeSpawn?: OpencodeSpawn;
}

export function createProductionAdapterRegistry(
  registry?: ModelRegistry,
  options: CreateProductionRegistryOptions = {}
): AgentRegistry {
  const adapters = new Map<string, AgentAdapter>();
  const opencodeDefaultTimeout = registry ? registryTimeoutFor(registry, 'opencode') : undefined;
  const opencode = createOpencodeAdapter({
    defaultTimeoutMs: opencodeDefaultTimeout,
    spawn: options.opencodeSpawn
  });
  adapters.set(opencode.name, opencode);
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
