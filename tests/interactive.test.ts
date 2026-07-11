import { describe, it, expect, beforeEach, vi } from 'vitest';
import { select, confirm, input } from '@inquirer/prompts';
import {
  promptRunners,
  promptStageAction
} from '../src/interactive.js';
import { DEFAULT_REGISTRY } from '../src/config.js';
import { createProductionAdapterRegistry } from '../src/adapters/registry.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import type { Config } from '../src/config.js';
import type { StageAction } from '../src/stage-menu.js';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn()
}));

describe('Interactive registry selection', () => {
  const dummyConfig = (providers: Record<string, string[]>, defaults: { agent: string; model: string }): Config => ({
    registry: {
      providers: Object.fromEntries(Object.entries(providers).map(([provider, models]) => [provider, { models, defaultModel: models[0]! }])),
      defaultProfile: 'default',
      profiles: { default: { provider: defaults.agent } }
    },
    manifest: {
      roles: { auditor: 'roles/auditor.md' },
      skills: {
        'plan-audit': {
          file: 'skills/plan-audit/SKILL.md',
          role: 'auditor',
          kind: 'audit',
          runnerProfile: 'default'
        }
      },
      loops: {}
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
    expect(output).toHaveBeenCalledWith('  plan-audit: opencode (opencode-model)');
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
        roles: { auditor: 'roles/auditor.md' },
        skills: {
          'plan-audit': {
            file: 'skills/plan-audit/SKILL.md',
            role: 'auditor',
            kind: 'audit',
            runnerProfile: 'selectableProfile'
          }
        },
        loops: {}
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

  it('promptStageAction returns selected action and sets recommended first', async () => {
    vi.mocked(select).mockResolvedValueOnce('continue');

    const actions: StageAction[] = [
      { id: 'start-new-new-session', group: 'start-new', stage: 'audit', version: 1, sessionPolicy: 'new', label: 'Start New', recommended: false },
      { id: 'continue', group: 'continue', stage: 'audit', version: 1, sessionPolicy: 'resumed', label: 'Continue', recommended: true }
    ];

    const result = await promptStageAction(actions, 'continue');
    expect(result).toBe('continue');
    expect(vi.mocked(select)).toHaveBeenCalled();
    const selectArgs = vi.mocked(select).mock.calls[0]![0] as any;
    expect(selectArgs.choices[0].value).toBe('continue');
    expect(selectArgs.choices[0].name).toContain('(recommended)');
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
    expect(vi.mocked(select)).toHaveBeenCalledTimes(2);
    expect(runners['plan-audit']).toEqual({ agent: 'codex', model: 'codex-model' });
  });
});
