import { describe, it, expect } from 'vitest';
import { buildPanelContext } from '../src/status.js';

describe('buildPanelContext (data model extension)', () => {
  it('builds a context with the documented field shape (inFlight/latestVersion/readOnly)', () => {
    const inFlight = {
      kind: 'evaluate' as const,
      role: 'auditor',
      skillId: 'plan-audit',
      agent: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      version: 1,
      iteration: 1,
      startedAtMs: 0,
      status: 'running' as const,
      spawnLabel: 'Spawning opencode for audit...',
      toolCallCount: 0,
      progressMessage: null,
      progressCapability: 'structured' as const,
    };
    const ctx = buildPanelContext('/p', 'plan', 'loop', 1, 5, null, [], 'next', inFlight, 1, false);
    expect(ctx.inFlight).toEqual(inFlight);
    expect(ctx.latestVersion).toBe(1);
    expect(ctx.readOnly).toBe(false);
  });

  it('defaults inFlight=null, latestVersion=0, readOnly=false for positional compatibility', () => {
    const ctx = buildPanelContext('/p', 'plan', 'loop', 0, 5, null, [], 'next');
    expect(ctx.inFlight).toBeNull();
    expect(ctx.latestVersion).toBe(0);
    expect(ctx.readOnly).toBe(false);
    expect(ctx.showFingerprints).toBeUndefined();
  });

  it('maps the trailing run-scoped display choice without changing existing positional callers', () => {
    const enabled = buildPanelContext('/p', 'plan', 'loop', 1, 5, null, [], 'next', null, 1, false, [], 2, undefined, true);
    const disabled = buildPanelContext('/p', 'plan', 'loop', 1, 5, null, [], 'next', null, 1, false, [], 2, undefined, false);
    expect(enabled.showFingerprints).toBe(true);
    expect(disabled.showFingerprints).toBe(false);
  });
});
