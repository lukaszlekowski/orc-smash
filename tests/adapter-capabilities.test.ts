import { describe, expect, it } from 'vitest';
import { createOpencodeAdapter } from '../src/adapters/opencode.js';
import { createCodexAdapter } from '../src/adapters/codex.js';
import { createClaudeAdapter } from '../src/adapters/claude.js';
import { createAgyAdapter } from '../src/adapters/agy.js';
import { fakeAdapter } from '../src/adapters/fake.js';

describe('adapter capabilities contract', () => {
  it('asserts progress capability declarations across all built-in adapters', () => {
    const opencode = createOpencodeAdapter();
    const codex = createCodexAdapter();
    const claude = createClaudeAdapter();
    const agy = createAgyAdapter();

    expect(opencode.capabilities.progress).toBe('structured');
    expect(codex.capabilities.progress).toBe('structured');
    expect(claude.capabilities.progress).toBe('structured');
    expect(fakeAdapter.capabilities.progress).toBe('structured');
    expect(agy.capabilities.progress).toBe('unavailable');
  });
});
