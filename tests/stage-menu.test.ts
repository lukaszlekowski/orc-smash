import { describe, it, expect } from 'vitest';
import { buildStageActions, findResumableSession } from '../src/stage-menu.js';
import type { Step } from '../src/state.js';

describe('generic stage actions', () => {
  const base = {
    latestVersion: 1,
    pendingRepairVersion: null,
    decisionPoint: 'startup' as const,
    loopName: 'quality-check',
  };

  it('offers a fresh evaluation for an accepted or fresh binding', () => {
    const result = buildStageActions({ ...base, phase: 'fresh' });
    expect(result.recommendedId).toBe('start-new');
    expect(result.actions[0]!.stage).toBe('evaluate');
  });

  it('offers repair as the recommended action for retry-pending state', () => {
    const result = buildStageActions({
      ...base,
      phase: 'retry-pending',
      pendingRepairVersion: 1,
    });
    expect(result.recommendedId).toBe('continue-repair');
    expect(result.actions[0]).toMatchObject({ stage: 'repair', version: 1 });
    expect(result.actions[0]!.label).toContain('quality-check');
  });
});

describe('capability-aware resumable session lookup', () => {
  const step = (overrides: Partial<Step>): Step => ({
    kind: 'evaluate',
    role: 'auditor',
    agent: 'opencode',
    model: 'opencode-go/model',
    version: 1,
    status: 'done',
    artifactPath: '/tmp/a.md',
    mtime: 1,
    sessionId: 'session-a',
    ...overrides,
  });

  it('matches provider, model, effort, and session id', () => {
    const result = findResumableSession(
      [step({ effort: 'medium' })],
      ['evaluate'],
      'opencode',
      'opencode-go/model',
      { effort: 'medium' },
    );
    expect(result?.sessionId).toBe('session-a');
  });

  it('does not resume across an accepted boundary or runner mismatch', () => {
    expect(findResumableSession(
      [step({ decision: 'accepted' }), step({ version: 2, sessionId: 'session-b' })],
      ['evaluate'],
      'opencode',
      'opencode-go/model',
    )).toBeNull();
    expect(findResumableSession(
      [step({ agent: 'codex' })],
      ['evaluate'],
      'opencode',
      'opencode-go/model',
    )).toBeNull();
  });
});
