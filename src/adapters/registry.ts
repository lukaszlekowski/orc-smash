import type { AgentAdapter } from './types.js';
import type { ModelRegistry } from '../config.js';
import { registryTimeoutFor } from '../config.js';
import { createOpencodeAdapter, type OpencodeSpawn } from './opencode.js';
import { createCodexAdapter } from './codex.js';
import { createClaudeAdapter } from './claude.js';
import { createAgyAdapter } from './agy.js';
import type { ProcessRunner } from './utils.js';
import type { SpawnRuntime } from './process-group.js';

export interface AgentRegistry {
  adapters: Map<string, AgentAdapter>;
}

export interface CreateProductionRegistryOptions {
  /**
   * Test seam: forwarded to `createOpencodeAdapter` so the integration test
   * can observe the resolved timeout through the production wiring without
   * spawning a real process. Production code never passes this.
   */
  opencodeSpawn?: OpencodeSpawn;
  /**
   * Test seam: forwarded to `createCodexAdapter` so the registry-timeout
   * integration test can observe the configured `timeouts.codex` reaching the
   * codex adapter (as the resolved `timeoutMs` passed to the runner) without
   * spawning the real `codex` binary. Production code never passes this.
   */
  codexProcessRunner?: ProcessRunner;
  /**
   * Test seam: forwarded to `createClaudeAdapter` (same purpose as
   * `codexProcessRunner`, for `timeouts.claude`). Production code never passes this.
   */
  claudeProcessRunner?: ProcessRunner;
  /**
   * Test seam: forwarded to `createAgyAdapter` so the registry-timeout
   * integration test can observe the configured `timeouts.agy` reaching the agy
   * adapter (as the resolved `timeoutMs` passed to the runner) without spawning
   * the real `agy` binary. Production code never passes this.
   */
  agyProcessRunner?: ProcessRunner;
  groupRuntime?: SpawnRuntime;
}

export function createProductionAdapterRegistry(
  registry?: ModelRegistry,
  options: CreateProductionRegistryOptions = {}
): AgentRegistry {
  const adapters = new Map<string, AgentAdapter>();

  const opencodeDefaultTimeout = registry ? registryTimeoutFor(registry, 'opencode') : undefined;
  const opencode = createOpencodeAdapter({
    defaultTimeoutMs: opencodeDefaultTimeout,
    spawn: options.opencodeSpawn,
    groupRuntime: options.groupRuntime
  });
  adapters.set(opencode.name, opencode);

  const codexDefaultTimeout = registry ? registryTimeoutFor(registry, 'codex') : undefined;
  const codex = createCodexAdapter({
    defaultTimeoutMs: codexDefaultTimeout,
    processRunner: options.codexProcessRunner,
    groupRuntime: options.groupRuntime
  });
  adapters.set(codex.name, codex);

  const claudeDefaultTimeout = registry ? registryTimeoutFor(registry, 'claude') : undefined;
  const claude = createClaudeAdapter({
    defaultTimeoutMs: claudeDefaultTimeout,
    processRunner: options.claudeProcessRunner,
    groupRuntime: options.groupRuntime
  });
  adapters.set(claude.name, claude);

  const agyDefaultTimeout = registry ? registryTimeoutFor(registry, 'agy') : undefined;
  const agy = createAgyAdapter({
    defaultTimeoutMs: agyDefaultTimeout,
    processRunner: options.agyProcessRunner,
    groupRuntime: options.groupRuntime
  });
  adapters.set(agy.name, agy);

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
