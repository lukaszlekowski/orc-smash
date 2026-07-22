import { describe, it, expect, beforeEach, vi } from 'vitest';
import { select, confirm, input } from '@inquirer/prompts';
import {
  promptRunners,
  promptCandidateSelection,
} from '../src/interactive.js';
import { DEFAULT_REGISTRY } from '../src/config.js';
import { createProductionAdapterRegistry } from '../src/adapters/registry.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import type { Config } from '../src/config.js';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn()
}));

describe('Interactive registry selection', () => {
  const dummyConfig = (providers: Record<string, string[]>, defaults: { agent: string; model: string }): Config => ({
    projectRoot: process.cwd(),
    manifestPath: '/path/to/config/orc-smash.yaml',
    manifestRoot: '/path/to/config',
    registry: {
      providers: Object.fromEntries(Object.entries(providers).map(([provider, models]) => [provider, { models, defaultModel: models[0]! }])),
      defaultProfile: 'default',
      profiles: { default: { provider: defaults.agent } }
    },
    manifest: {
      schemaVersion: 1 as const,
      roles: { auditor: 'roles/auditor.md' },
      skills: {
        'plan-audit': {
          file: 'skills/plan-audit/SKILL.md',
          role: 'auditor',
          runnerProfile: 'default'
        }
      },
      loops: {},
      tasks: {},
      pipelines: {}
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DEFAULT_REGISTRY excludes fake', () => {
    expect(Object.keys(DEFAULT_REGISTRY.providers)).not.toContain('fake');
  });

  it('shows resolved default runners before asking whether to customize', async () => {
    const config = dummyConfig({ opencode: ['opencode-model'] }, { agent: 'opencode', model: 'opencode-model' });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.mocked(confirm).mockResolvedValueOnce(false);

    await promptRunners(['plan-audit'], config, createProductionAdapterRegistry());

    expect(output).toHaveBeenCalledWith('Default skill runners:');
    expect(output).toHaveBeenCalledWith('  plan-audit: opencode (opencode-model), effort: provider default, session: fresh-per-invocation');
    expect(output.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(confirm).mock.invocationCallOrder[0]!);
  });

  it('promptRunners uses intersection of configured and runnable agents', async () => {
    const config = dummyConfig({
      opencode: ['opencode-model'],
      codex: ['codex-model'],
      fake: ['fake-model']
    }, { agent: 'opencode', model: 'opencode-model' });

    const prodRegistry = createProductionAdapterRegistry(); // has opencode, codex, claude
    
    vi.mocked(confirm).mockResolvedValueOnce(true); // customize = true
    vi.mocked(select).mockResolvedValueOnce('codex'); // choose agent
    vi.mocked(select).mockResolvedValueOnce('codex-model'); // choose model

    await promptRunners(['plan-audit'], config, prodRegistry);

    // The first select should have choices intersected (opencode, codex), but not fake (no adapter)
    expect(vi.mocked(select)).toHaveBeenCalled();
    const selectArgs = vi.mocked(select).mock.calls[0]![0] as any;
    const choices = selectArgs.choices.map((c: any) => c.value);
    expect(choices).toContain('opencode');
    expect(choices).toContain('codex');
    expect(choices).not.toContain('fake');
  });

  it('promptRunners includes fake if test adapter registry and config allows it', async () => {
    const config = dummyConfig({
      opencode: ['opencode-model'],
      fake: ['fake-model']
    }, { agent: 'fake', model: 'fake-model' });

    const testRegistry = createTestAdapterRegistry(); // has fake
    
    vi.mocked(confirm).mockResolvedValueOnce(true); // customize = true
    vi.mocked(select).mockResolvedValueOnce('fake');
    vi.mocked(select).mockResolvedValueOnce('fake-model');

    await promptRunners(['plan-audit'], config, testRegistry);

    const selectArgs = vi.mocked(select).mock.calls[0]![0] as any;
    const choices = selectArgs.choices.map((c: any) => c.value);
    expect(choices).toContain('fake');
  });

  it('does not throw when defaultProfile provider is unselectable but skill profile provider is selectable', async () => {
    const config: Config = {
      projectRoot: process.cwd(),
      manifestPath: '/path/to/config/orc-smash.yaml',
      manifestRoot: '/path/to/config',
      registry: {
        providers: {
          codex: { models: ['codex-model'], defaultModel: 'codex-model' }
        },
        defaultProfile: 'unselectableProfile',
        profiles: {
          unselectableProfile: { provider: 'opencode' },
          selectableProfile: { provider: 'codex' }
        }
      },
      manifest: {
        schemaVersion: 1 as const,
        roles: { auditor: 'roles/auditor.md' },
        skills: {
          'plan-audit': {
            file: 'skills/plan-audit/SKILL.md',
            role: 'auditor',
            runnerProfile: 'selectableProfile'
          }
        },
        loops: {},
        tasks: {},
        pipelines: {}
      }
    };

    const prodRegistry = createProductionAdapterRegistry(); // has codex, opencode

    vi.mocked(confirm).mockResolvedValueOnce(true); // customize = true
    vi.mocked(select).mockResolvedValueOnce('codex'); // choose agent
    vi.mocked(select).mockResolvedValueOnce('codex-model'); // choose model

    const runners = await promptRunners(['plan-audit'], config, prodRegistry);
    expect(runners['plan-audit']).toEqual({ agent: 'codex', model: 'codex-model' });

    // The default agent choice in select should be 'codex'
    const selectArgs = vi.mocked(select).mock.calls[0]![0] as any;
    expect(selectArgs.default).toBe('codex');
  });

  it('selecting agy re-defaults to providers.agy[0] and does not mutate global defaults', async () => {
    const config = dummyConfig({
      opencode: ['opencode-model'],
      agy: ['Gemini 3.5 Flash (Medium)', 'Claude Sonnet 4.6 (Thinking)']
    }, { agent: 'opencode', model: 'opencode-model' });

    const prodRegistry = createProductionAdapterRegistry(); // now includes agy

    vi.mocked(confirm).mockResolvedValueOnce(false); // customize = false

    const runners = await promptRunners(['plan-audit'], config, prodRegistry, { agent: 'agy' });
    expect(runners['plan-audit']).toEqual({ agent: 'agy', model: 'Gemini 3.5 Flash (Medium)' });
    // Global defaults pair is untouched.
    expect(config.registry.profiles.default.provider).toBe('opencode');
    expect(config.registry.providers.opencode.defaultModel).toBe('opencode-model');
  });

  it('agy model choices come from providers.agy (foreign models are not offered)', async () => {
    const config = dummyConfig({
      opencode: ['opencode-model'],
      agy: ['Gemini 3.5 Flash (Medium)', 'GPT-OSS 120B (Medium)']
    }, { agent: 'opencode', model: 'opencode-model' });
    const prodRegistry = createProductionAdapterRegistry();

    vi.mocked(confirm).mockResolvedValueOnce(true); // customize = true
    vi.mocked(select).mockResolvedValueOnce('agy'); // choose agent
    vi.mocked(select).mockResolvedValueOnce('Gemini 3.5 Flash (Medium)'); // choose model

    await promptRunners(['plan-audit'], config, prodRegistry, { agent: 'agy' });

    // Second select (model) choices are the configured providers.agy names + custom.
    const modelSelectArgs = vi.mocked(select).mock.calls[1]![0] as any;
    const modelChoices = modelSelectArgs.choices.map((c: any) => c.value);
    expect(modelChoices).toContain('Gemini 3.5 Flash (Medium)');
    expect(modelChoices).toContain('GPT-OSS 120B (Medium)');
    expect(modelChoices).not.toContain('gpt-5.5');
  });

  it('custom-model validation for agy rejects foreign ids and accepts configured names', async () => {
    const config = dummyConfig({
      opencode: ['opencode-model'],
      agy: ['Gemini 3.5 Flash (Medium)']
    }, { agent: 'opencode', model: 'opencode-model' });
    const prodRegistry = createProductionAdapterRegistry();

    vi.mocked(confirm).mockResolvedValueOnce(true); // customize = true
    vi.mocked(select).mockResolvedValueOnce('agy'); // choose agent
    vi.mocked(select).mockResolvedValueOnce('custom'); // choose custom model
    vi.mocked(input).mockResolvedValueOnce('  Gemini 3.5 Flash (Medium)  ');

    const runners = await promptRunners(['plan-audit'], config, prodRegistry, { agent: 'agy' });
    expect(runners['plan-audit']).toEqual({ agent: 'agy', model: 'Gemini 3.5 Flash (Medium)' });

    // The input prompt carried the validate callback; drive it directly to prove
    // the custom-model path enforces the providers.agy allow-list.
    const inputArgs = vi.mocked(input).mock.calls[0]![0] as any;
    const validate = inputArgs.validate as (val: string) => string | true;
    expect(validate('gpt-5.5')).not.toBe(true);
    expect(validate('opencode-go/deepseek-v4-flash')).not.toBe(true);
    expect(validate('claude-sonnet-4-6')).not.toBe(true);
    expect(validate('Gemini 3.5 Flash (Medium)')).toBe(true);
  });

  it('renders disabled effort/resume choices for a non-effort non-resume adapter', async () => {
    const config = dummyConfig({
      'non-resume-agent': ['m1'],
    }, { agent: 'non-resume-agent', model: 'm1' });

    // Create a registry with an adapter that has both capabilities disabled
    const testRegistry = createTestAdapterRegistry();
    testRegistry.adapters.set('non-resume-agent', {
      name: 'non-resume-agent',
      capabilities: { resumeSession: false, effort: false },
      buildRun: () => ({ command: '', args: [] }),
      run: async () => ({ stdout: '', exitCode: 0 }),
    });

    vi.mocked(confirm).mockResolvedValueOnce(true); // customize = true
    vi.mocked(select)
      .mockResolvedValueOnce('non-resume-agent') // choose agent
      .mockResolvedValueOnce('m1') // choose model
      .mockResolvedValueOnce('default') // effort prompt — always has Provider default enabled
      .mockResolvedValueOnce('fresh-per-invocation'); // session prompt — always has Fresh enabled

    await promptRunners(['plan-audit'], config, testRegistry);

    // Find effort and session strategy select calls (skip agent + model)
    const effortCall = vi.mocked(select).mock.calls[2]![0] as any;
    const sessionCall = vi.mocked(select).mock.calls[3]![0] as any;

    // Effort choices: Provider default (enabled) + disabled entry with reason
    expect(effortCall.choices.length).toBeGreaterThanOrEqual(2);
    const effortEnabled = effortCall.choices.find((c: any) => !c.disabled);
    expect(effortEnabled).toBeDefined();
    expect(effortEnabled.value).toBe('default');
    const effortDisabled = effortCall.choices.find((c: any) => c.disabled);
    expect(effortDisabled).toBeDefined();
    expect(effortDisabled.disabled).toBe(true);
    expect(effortDisabled.name).toContain('(unavailable: non-resume-agent does not support effort)');

    // Session choices: Fresh per invocation (enabled) + disabled entry with reason
    expect(sessionCall.choices.length).toBeGreaterThanOrEqual(2);
    const sessionEnabled = sessionCall.choices.find((c: any) => !c.disabled);
    expect(sessionEnabled).toBeDefined();
    expect(sessionEnabled.value).toBe('fresh-per-invocation');
    const sessionDisabled = sessionCall.choices.find((c: any) => c.disabled);
    expect(sessionDisabled).toBeDefined();
    expect(sessionDisabled.disabled).toBe(true);
    expect(sessionDisabled.name).toContain('(unavailable: non-resume-agent does not support session resumption)');
  });

  it('promptRunners with forceSelect bypasses the customize confirm and shows the model list', async () => {
    const config = dummyConfig({
      opencode: ['opencode-model'],
      codex: ['codex-model']
    }, { agent: 'opencode', model: 'opencode-model' });
    const prodRegistry = createProductionAdapterRegistry();

    // No confirm mock is set up: forceSelect must short-circuit the gate so the
    // run never blocks on the "customize skill runners?" yes/no.
    vi.mocked(select).mockResolvedValueOnce('codex'); // choose agent
    vi.mocked(select).mockResolvedValueOnce('codex-model'); // choose model

    const runners = await promptRunners(['plan-audit'], config, prodRegistry, {}, { forceSelect: true });

    expect(vi.mocked(confirm)).not.toHaveBeenCalled();
    expect(vi.mocked(select)).toHaveBeenCalledTimes(4);
    expect(runners['plan-audit']).toEqual({ agent: 'codex', model: 'codex-model', effort: undefined, sessionStrategy: undefined });
  });

  it('selects effort after the provider/model pair when the adapter supports it', async () => {
    const config = dummyConfig({ opencode: ['opencode-model'] }, { agent: 'opencode', model: 'opencode-model' });
    config.registry.providers.opencode!.efforts = ['low', 'medium', 'high'];
    config.registry.providers.opencode!.defaultEffort = 'medium';
    const prodRegistry = createProductionAdapterRegistry();

    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.mocked(select)
      .mockResolvedValueOnce('opencode')
      .mockResolvedValueOnce('opencode-model')
      .mockResolvedValueOnce('high')
      .mockResolvedValueOnce('fresh-per-invocation'); // session strategy

    const runners = await promptRunners(['plan-audit'], config, prodRegistry);
    expect(runners['plan-audit']).toEqual({ agent: 'opencode', model: 'opencode-model', effort: 'high', sessionStrategy: undefined });
    expect(vi.mocked(select)).toHaveBeenCalledTimes(4);
  });
});

describe('promptCandidateSelection', () => {
  it('returns null when candidates list is empty', async () => {
    const result = await promptCandidateSelection([]);
    expect(result).toBeNull();
  });

  it('renders a confirmation select menu even for a single candidate and returns it on select', async () => {
    const candidate = {
      pipelineId: 'default',
      pipelineRunId: 'run-123',
      successorStageId: 'implement',
      predecessorStageId: 'plan',
      predecessorArtifactIdentity: 'artifact-abc',
      label: 'Pipeline default | Run: run-123 | Successor: implement | Predecessor: plan | Artifact: plan.md | Identity: artifact-abc | Decision: accepted | Fingerprint: valid',
    };

    const expectedKey = 'default:run-123:implement:artifact-abc';
    vi.mocked(select).mockResolvedValueOnce(expectedKey);

    const result = await promptCandidateSelection([candidate]);

    expect(vi.mocked(select)).toHaveBeenCalledWith({
      message: 'Select a pipeline stage to advance:',
      choices: [
        { name: candidate.label, value: expectedKey },
        { name: 'Cancel (Go back)', value: 'cancel' }
      ]
    });
    expect(result).toEqual(candidate);
  });

  it('returns null when Cancel is chosen', async () => {
    const candidate = {
      pipelineId: 'default',
      pipelineRunId: 'run-123',
      successorStageId: 'implement',
      predecessorStageId: 'plan',
      predecessorArtifactIdentity: 'artifact-abc',
      label: 'Pipeline default | Run: run-123 | Successor: implement | Predecessor: plan | Artifact: plan.md | Identity: artifact-abc | Decision: accepted | Fingerprint: valid',
    };

    vi.mocked(select).mockResolvedValueOnce('cancel');

    const result = await promptCandidateSelection([candidate]);
    expect(result).toBeNull();
  });

  it('correctly distinguishes and returns the selected candidate when multiple choices are offered', async () => {
    const cand1 = {
      pipelineId: 'default',
      pipelineRunId: 'run-123',
      successorStageId: 'implement',
      predecessorStageId: 'plan',
      predecessorArtifactIdentity: 'art-1',
      label: 'Cand 1',
    };
    const cand2 = {
      pipelineId: 'default',
      pipelineRunId: 'run-123',
      successorStageId: 'implement',
      predecessorStageId: 'plan',
      predecessorArtifactIdentity: 'art-2',
      label: 'Cand 2',
    };

    const key2 = 'default:run-123:implement:art-2';
    vi.mocked(select).mockResolvedValueOnce(key2);

    const result = await promptCandidateSelection([cand1, cand2]);
    expect(result).toEqual(cand2);
  });
});
