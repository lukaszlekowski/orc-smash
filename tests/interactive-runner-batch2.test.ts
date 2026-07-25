import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { select, input } from '@inquirer/prompts';
import { promptRunners } from '../src/interactive.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { continuationRunnerDefaults } from '../src/continuation-runners.js';
import { createTestConfig } from './helpers/test-config.js';
import type { Step } from '../src/state.js';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  input: vi.fn(),
  confirm: vi.fn(),
}));

function chainStep(overrides: Partial<Step> = {}): Step {
  return {
    kind: 'evaluate',
    skillId: 'plan-audit',
    role: 'auditor',
    agent: 'fake',
    model: 'fake-model',
    version: 3,
    status: 'done',
    artifactPath: '/tmp/plan-audit-v3-fake.md',
    mtime: 1,
    chainId: 'active-chain',
    sessionId: 'session-abcdef',
    sessionStrategy: 'resume-per-skill',
    decision: 'retry',
    ...overrides,
  };
}

describe('Batch 2 interactive runner selection', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('accepts a chain preselection with session attribution and predicted resume', async () => {
    const config = createTestConfig();
    const registry = createTestAdapterRegistry();
    const steps = [chainStep()];
    const preselections = continuationRunnerDefaults({
      steps,
      chainId: 'active-chain',
      skillIds: ['plan-audit'],
      config,
      registry,
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(select).mockResolvedValueOnce('use-default');

    const result = await promptRunners(['plan-audit'], config, registry, {}, {
      preselections,
      continuitySteps: steps,
      continuationChainId: 'active-chain',
    });

    expect(result['plan-audit']).toMatchObject({
      agent: 'fake',
      model: 'fake-model',
      agentSource: 'session',
      modelSource: 'session',
      inheritedSession: { sessionId: 'session-abcdef' },
    });
    expect(log.mock.calls.flat().join('\n')).toContain('from chain evaluate v3');
  });

  it('changes effort without re-selecting provider or model and distinguishes Provider default', async () => {
    const config = createTestConfig();
    config.registry.providers.fake!.modelEfforts = { 'fake-model': ['low', 'high'] };
    config.registry.profiles[config.registry.defaultProfile] = { provider: 'fake', effort: 'high' };
    const registry = createTestAdapterRegistry();
    vi.mocked(select)
      .mockResolvedValueOnce('effort-only')
      .mockResolvedValueOnce('default');

    const result = await promptRunners(['plan-audit'], config, registry);

    expect(result['plan-audit']).toMatchObject({ agent: 'fake', model: 'fake-model' });
    expect(result['plan-audit']!.effort).toBeUndefined();
    expect((result['plan-audit'] as any)!.effortSource).toBeUndefined();
    expect(vi.mocked(select)).toHaveBeenCalledTimes(2);
    expect(input).not.toHaveBeenCalled();
  });

  it('accepts a non-catalogue model effort without throwing (D3 compatibility)', async () => {
    const config = createTestConfig();
    const nonCatalogueModel = 'opencode-go/custom-non-catalogue';
    config.registry.providers.fake = {
      models: ['fake-model'],
      defaultModel: 'fake-model',
      efforts: ['max'],
    };
    config.registry.profiles[config.registry.defaultProfile] = { provider: 'fake', model: nonCatalogueModel };
    const registry = createTestAdapterRegistry();
    registry.adapters.get('fake')!.capabilities.effort = true;
    vi.mocked(select)
      .mockResolvedValueOnce('effort-only')
      .mockResolvedValueOnce('max');

    const result = await promptRunners(['plan-audit'], config, registry);

    expect(result['plan-audit']).toMatchObject({ agent: 'fake', model: nonCatalogueModel, effort: 'max' });
    expect(vi.mocked(select)).toHaveBeenCalledTimes(2);
  });
});
