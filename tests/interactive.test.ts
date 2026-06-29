import { describe, it, expect, beforeEach, vi } from 'vitest';
import { select, confirm, input } from '@inquirer/prompts';
import {
  promptRunners,
  promptSecondOpinionRunner,
  promptSecondOpinionDecision
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
    registry: { providers, defaults },
    manifest: {
      roles: { auditor: 'roles/auditor.md' },
      skills: {
        'plan-audit': {
          file: 'skills/plan-audit/SKILL.md',
          role: 'auditor',
          kind: 'audit',
          agent: 'opencode',
          model: 'opencode-go/deepseek-v4-flash'
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

  it('throws error if defaults.agent is not in selectable agents', async () => {
    const config = dummyConfig({
      codex: ['codex-model']
    }, { agent: 'opencode', model: 'opencode-model' }); // opencode has adapter but not configured

    const prodRegistry = createProductionAdapterRegistry();
    
    await expect(
      promptRunners(['plan-audit'], config, prodRegistry)
    ).rejects.toThrow(/Default agent 'opencode' is not selectable/);
  });

  it('promptSecondOpinionRunner default swap respects configuration', async () => {
    const config = dummyConfig({
      opencode: ['opencode-model'],
      codex: ['codex-model']
    }, { agent: 'opencode', model: 'opencode-model' });

    const prodRegistry = createProductionAdapterRegistry();
    
    // Non-customized second opinion
    vi.mocked(confirm).mockResolvedValueOnce(false); 

    const runner = await promptSecondOpinionRunner('opencode', config, prodRegistry);
    expect(runner).toEqual({ agent: 'codex', model: 'codex-model' });
  });

  it('promptSecondOpinionDecision filters allowedActions correctly', async () => {
    vi.mocked(select).mockResolvedValueOnce('stop');
    await promptSecondOpinionDecision(['stop', 'implement']);

    expect(vi.mocked(select)).toHaveBeenCalled();
    const selectArgs = vi.mocked(select).mock.calls[0]![0] as any;
    const choiceValues = selectArgs.choices.map((c: any) => c.value);
    expect(choiceValues).toEqual(['stop', 'implement']);
  });
});
