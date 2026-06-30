import type { AgentRegistry } from './registry.js';
import { createProductionAdapterRegistry } from './registry.js';
import { fakeAdapter } from './fake.js';
import { fakeAdapterState } from './fake.js';

export function createTestAdapterRegistry(): AgentRegistry {
  const registry = createProductionAdapterRegistry();
  registry.adapters.set(fakeAdapter.name, fakeAdapter);
  return registry;
}

export function resetFakeAdapterState(): void {
  fakeAdapterState.verdicts = [];
  fakeAdapterState.stdout = '';
  fakeAdapterState.exitCode = 0;
  fakeAdapterState.writeVerdictFile = true;
  fakeAdapterState.auditError = undefined;
  fakeAdapterState.followUpError = undefined;
  fakeAdapterState.stderr = undefined;
  fakeAdapterState.delayMs = undefined;
  fakeAdapterState.lifecycleMessages = [];
  fakeAdapterState.failAfterMs = undefined;
}
