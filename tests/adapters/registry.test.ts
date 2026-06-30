import { describe, it, expect } from 'vitest';
import { createProductionAdapterRegistry, getAdapter } from '../../src/adapters/registry.js';
import { createTestAdapterRegistry } from '../../src/adapters/testing.js';

describe('Adapter Registries', () => {
  it('production registry has opencode, codex, claude but excludes fake', () => {
    const registry = createProductionAdapterRegistry();
    expect(registry.adapters.has('opencode')).toBe(true);
    expect(registry.adapters.has('codex')).toBe(true);
    expect(registry.adapters.has('claude')).toBe(true);
    expect(registry.adapters.has('fake')).toBe(false);

    expect(() => getAdapter(registry, 'fake')).toThrow(/unknown agent 'fake'/);
  });

  it('test registry includes fake', () => {
    const registry = createTestAdapterRegistry();
    expect(registry.adapters.has('opencode')).toBe(true);
    expect(registry.adapters.has('codex')).toBe(true);
    expect(registry.adapters.has('claude')).toBe(true);
    expect(registry.adapters.has('fake')).toBe(true);

    const adapter = getAdapter(registry, 'fake');
    expect(adapter.name).toBe('fake');
  });

  it('accepts ModelRegistry config and parses timeouts', () => {
    const registry = createProductionAdapterRegistry({
      providers: {
        opencode: ['opencode-go/x'],
        codex: ['gpt-5.5'],
        claude: ['glm-5.2']
      },
      defaults: { agent: 'opencode', model: 'opencode-go/x' },
      timeouts: { opencode: 12345 }
    });
    expect(registry.adapters.has('opencode')).toBe(true);
    expect(registry.adapters.has('codex')).toBe(true);
    expect(registry.adapters.has('claude')).toBe(true);
  });
});
