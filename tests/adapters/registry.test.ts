import { describe, it, expect } from 'vitest';
import { createProductionAdapterRegistry, getAdapter } from '../../src/adapters/registry.js';
import { createTestAdapterRegistry } from '../../src/adapters/testing.js';

describe('Adapter Registries', () => {
  it('production registry has opencode, codex, claude, agy but excludes fake', () => {
    const registry = createProductionAdapterRegistry();
    expect(registry.adapters.has('opencode')).toBe(true);
    expect(registry.adapters.has('codex')).toBe(true);
    expect(registry.adapters.has('claude')).toBe(true);
    expect(registry.adapters.has('agy')).toBe(true);
    expect(registry.adapters.has('fake')).toBe(false);

    expect(() => getAdapter(registry, 'fake')).toThrow(/unknown agent 'fake'/);
    // agy is selectable as a fourth real provider.
    expect(getAdapter(registry, 'agy').name).toBe('agy');
  });

  it('test registry includes fake', () => {
    const registry = createTestAdapterRegistry();
    expect(registry.adapters.has('opencode')).toBe(true);
    expect(registry.adapters.has('codex')).toBe(true);
    expect(registry.adapters.has('claude')).toBe(true);
    expect(registry.adapters.has('agy')).toBe(true);
    expect(registry.adapters.has('fake')).toBe(true);

    const adapter = getAdapter(registry, 'fake');
    expect(adapter.name).toBe('fake');
  });

  it('accepts ModelRegistry config and parses timeouts', () => {
    const registry = createProductionAdapterRegistry({
      providers: {
        opencode: { models: ['opencode-go/x'], defaultModel: 'opencode-go/x' },
        codex: { models: ['gpt-5.5'], defaultModel: 'gpt-5.5' },
        claude: { models: ['glm-5.2'], defaultModel: 'glm-5.2' }
      },
      defaultProfile: 'default', profiles: { default: { provider: 'opencode' } },
      timeouts: { opencode: 12345 }
    });
    expect(registry.adapters.has('opencode')).toBe(true);
    expect(registry.adapters.has('codex')).toBe(true);
    expect(registry.adapters.has('claude')).toBe(true);
  });
});
