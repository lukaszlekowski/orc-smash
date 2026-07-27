import { describe, expect, it } from 'vitest';
import type { Step } from '../src/state.js';
import { createProductionAdapterRegistry } from '../src/adapters/registry.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { continuationRunnerDefaults, latestChainRunnerCandidate, resolveContinuity } from '../src/continuation-runners.js';
import { createTestConfig } from './helpers/test-config.js';

function step(overrides: Partial<Step> = {}): Step {
  return {
    kind: 'evaluate',
    skillId: 'plan-audit',
    role: 'auditor',
    agent: 'fake',
    model: 'fake-model',
    version: 1,
    status: 'done',
    artifactPath: '/tmp/artifact.md',
    mtime: 1,
    chainId: 'chain-1',
    sessionId: 'session-1',
    sessionStrategy: 'resume-per-skill',
    ...overrides,
  };
}

describe('continuation runner seam', () => {
  it('stops at an accepted boundary and does not resume across it', () => {
    const history = [
      { meta: { chainId: 'chain-1', skill: 'plan-audit', sessionId: 'old', agent: 'fake', model: 'fake-model' } },
      { meta: { chainId: 'chain-1', skill: 'plan-follow-up', sessionId: 'repair', agent: 'fake', model: 'fake-model' }, decision: 'accepted' },
    ];
    expect(latestChainRunnerCandidate(history, 'chain-1', 'plan-audit')).toBeUndefined();
    const result = resolveContinuity(undefined, { agent: 'fake', model: 'fake-model', sessionStrategy: 'resume-per-skill' }, createTestAdapterRegistry(), 'resume-per-skill', 'plan-audit', history, 'chain-1');
    expect(result).toEqual({ mode: 'fresh', freshReason: 'no-compatible-session' });
  });

  it('treats completion as a non-boundary', () => {
    const history = [
      step(),
      step({ skillId: 'plan-follow-up', kind: 'repair', completionOutcome: 'completed' }),
    ];
    expect(latestChainRunnerCandidate(history, 'chain-1', 'plan-audit')).toMatchObject({ skillId: 'plan-audit' });
  });

  it('reports no compatible session when the candidate has no session id', () => {
    const history = [step({ sessionId: 'none' })].map(item => ({
      meta: { chainId: item.chainId, skill: item.skillId!, sessionId: item.sessionId!, agent: item.agent, model: item.model },
    }));
    expect(resolveContinuity(undefined, { agent: 'fake', model: 'fake-model' }, createTestAdapterRegistry(), 'resume-per-skill', 'plan-audit', history, 'chain-1')).toEqual({ mode: 'fresh', freshReason: 'no-compatible-session' });
  });

  it('reports provider unsupported when the adapter cannot resume', () => {
    const registry = createTestAdapterRegistry();
    registry.adapters.set('no-resume', {
      name: 'no-resume',
      capabilities: { resumeSession: false, effort: true, progress: 'structured' },
      buildRun: () => ({ command: 'no-resume', args: [] }),
      run: async () => ({ stdout: '', exitCode: 0 }),
    });
    const history = [{ meta: { chainId: 'chain-1', skill: 'plan-audit', sessionId: 'session-1', agent: 'no-resume', model: 'm' } }];
    expect(resolveContinuity(undefined, { agent: 'no-resume', model: 'm' }, registry, 'resume-per-skill', 'plan-audit', history, 'chain-1')).toEqual({ mode: 'fresh', freshReason: 'provider-unsupported' });
  });

  it('offers valid non-catalogue opencode candidates, including one with effort, with a note', () => {
    const config = createTestConfig();
    const registry = createProductionAdapterRegistry(config.registry);
    const customModel = 'opencode-go/custom-continuation-model';
    const steps = [
      step({ agent: 'opencode', model: customModel, effort: undefined, sessionId: 's1' }),
      step({ agent: 'opencode', model: customModel, effort: 'max', sessionId: 's2', version: 2 }),
    ];
    const result = continuationRunnerDefaults({ steps, chainId: 'chain-1', skillIds: ['plan-audit'], config, registry }).get('plan-audit')!;
    expect(result).toMatchObject({ source: 'chain', agent: 'opencode', model: customModel, effort: 'max', note: 'model not in current catalogue' });
  });

  it('offers an effortless non-catalogue opencode candidate as the default', () => {
    const config = createTestConfig();
    const registry = createProductionAdapterRegistry(config.registry);
    const customModel = 'opencode-go/effortless-custom-model';
    const steps = [
      step({ agent: 'opencode', model: customModel, effort: undefined, sessionId: 's1' }),
    ];
    const result = continuationRunnerDefaults({ steps, chainId: 'chain-1', skillIds: ['plan-audit'], config, registry }).get('plan-audit')!;
    expect(result).toMatchObject({ source: 'chain', agent: 'opencode', model: customModel });
    expect(result.effort).toBeUndefined();
    expect(result.note).toBe('model not in current catalogue');
  });
});
