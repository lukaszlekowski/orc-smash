import { describe, it, expect } from 'vitest';
import { latestVersion, buildPanelContext } from '../src/status.js';
import type { Step } from '../src/state.js';

function makeStep(overrides: Partial<Step>): Step {
  return {
    kind: 'evaluate',
    role: 'auditor',
    agent: 'fake',
    model: 'fake-model',
    version: 1,
    status: 'done',
    artifactPath: '/tmp/audit.md',
    mtime: 0,
    ...overrides
  };
}

describe('latestVersion (shared helper)', () => {
  it('returns 0 for an empty steps array', () => {
    expect(latestVersion([])).toBe(0);
  });

  it('returns the max audit version for a mixed steps array', () => {
    const steps: Step[] = [
      makeStep({ kind: 'evaluate', version: 1 }),
      makeStep({ kind: 'repair', version: 1 }),
      makeStep({ kind: 'evaluate', version: 2 }),
      makeStep({ kind: 'task', version: 2 })
    ];
    expect(latestVersion(steps)).toBe(2);
  });

  it('matches the audit-only max for an audit-only timeline', () => {
    const steps: Step[] = [
      makeStep({ kind: 'evaluate', version: 3 }),
      makeStep({ kind: 'evaluate', version: 5 }),
      makeStep({ kind: 'evaluate', version: 2 })
    ];
    expect(latestVersion(steps)).toBe(5);
  });

  it('uses the highest artifact version across configured step kinds', () => {
    const steps: Step[] = [
      makeStep({ kind: 'repair', version: 99 }),
      makeStep({ kind: 'task', version: 99 })
    ];
    expect(latestVersion(steps)).toBe(99);
  });
});

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
      progressMessage: null
    };
    const ctx = buildPanelContext('/p', 'plan', 1, 5, null, [], 'next', inFlight, 1, false);
    expect(ctx.inFlight).toEqual(inFlight);
    expect(ctx.latestVersion).toBe(1);
    expect(ctx.readOnly).toBe(false);
  });

  it('defaults inFlight=null, latestVersion=0, readOnly=false for positional compatibility', () => {
    const ctx = buildPanelContext('/p', 'plan', 0, 5, null, [], 'next');
    expect(ctx.inFlight).toBeNull();
    expect(ctx.latestVersion).toBe(0);
    expect(ctx.readOnly).toBe(false);
  });
});
