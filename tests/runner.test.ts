import { describe, it, expect } from 'vitest';
import { resolveRunner, isValidModelForAgent } from '../src/runner.js';
import type { Config } from '../src/config.js';

describe('Runner selection and verification', () => {
  const dummyConfig: Config = {
    registry: {
      providers: {
        opencode: [
          'opencode-go/deepseek-v4-flash',
          'opencode/deepseek-v4-flash-free'
        ],
        claude: [
          'claude-sonnet-4-6'
        ],
        codex: [
          'gpt-5-codex'
        ],
        agy: [
          'Gemini 3.5 Flash (Medium)',
          'Gemini 3.5 Pro (Medium)'
        ],
        fake: [
          'fake-model'
        ]
      },
      defaults: {
        agent: 'opencode',
        model: 'opencode-go/deepseek-v4-flash'
      }
    },
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
  };

  it('verifies valid models for agents', () => {
    // Note: full model-level validity is resolved at runtime via stream error; this is just a sync shape check.
    expect(isValidModelForAgent('opencode', 'opencode-go/deepseek-v4-flash', dummyConfig.registry)).toBe(true);
    expect(isValidModelForAgent('opencode', 'zai-coding-plan/glm-5.2', dummyConfig.registry)).toBe(true);
    expect(isValidModelForAgent('opencode', 'opencode/deepseek', dummyConfig.registry)).toBe(true);
    expect(isValidModelForAgent('opencode', 'gpt-5-codex', dummyConfig.registry)).toBe(false);

    expect(isValidModelForAgent('claude', 'claude-sonnet-4-6', dummyConfig.registry)).toBe(true);
    expect(isValidModelForAgent('claude', 'opencode/deepseek', dummyConfig.registry)).toBe(false);

    expect(isValidModelForAgent('codex', 'gpt-5-codex', dummyConfig.registry)).toBe(true);
    expect(isValidModelForAgent('codex', 'opencode/deepseek', dummyConfig.registry)).toBe(false);
    expect(isValidModelForAgent('codex', 'claude-sonnet-4-6', dummyConfig.registry)).toBe(false);
  });

  it('resolves using global overrides', () => {
    const resolved = resolveRunner('plan-audit', dummyConfig, { agent: 'claude' });
    expect(resolved).toEqual({ agent: 'claude', model: 'claude-sonnet-4-6' });
  });

  it('rejects invalid agent/model combo', () => {
    expect(() => {
      resolveRunner('plan-audit', dummyConfig, { agent: 'opencode', model: 'gpt-5-codex' });
    }).toThrow(/model 'gpt-5-codex' is not a opencode model/);
  });

  it('rejects unknown agent', () => {
    expect(() => {
      resolveRunner('plan-audit', dummyConfig, { agent: 'unknown-agent' });
    }).toThrow(/unknown agent 'unknown-agent'/);
  });

  // ---------------------------------------------------------------------
  // §2 agy strict allow-list: agy accepts ONLY the configured providers.agy
  // names (with input trimming); namespace-style / foreign ids are rejected.
  // ---------------------------------------------------------------------
  it('agy accepts only configured providers.agy names (strict allow-list)', () => {
    expect(isValidModelForAgent('agy', 'Gemini 3.5 Flash (Medium)', dummyConfig.registry)).toBe(true);
    expect(isValidModelForAgent('agy', 'Gemini 3.5 Pro (Medium)', dummyConfig.registry)).toBe(true);
    // Input trimming normalizes surrounding whitespace.
    expect(isValidModelForAgent('agy', '  Gemini 3.5 Flash (Medium)  ', dummyConfig.registry)).toBe(true);
  });

  it('agy rejects foreign / namespace-style / unconfigured ids', () => {
    expect(isValidModelForAgent('agy', 'gpt-5.5', dummyConfig.registry)).toBe(false);
    expect(isValidModelForAgent('agy', 'opencode-go/deepseek-v4-flash', dummyConfig.registry)).toBe(false);
    expect(isValidModelForAgent('agy', 'claude-sonnet-4-6', dummyConfig.registry)).toBe(false);
    // Human-readable but not configured for agy.
    expect(isValidModelForAgent('agy', 'Gemini 2.0 Flash', dummyConfig.registry)).toBe(false);
    expect(isValidModelForAgent('agy', 'fake-model', dummyConfig.registry)).toBe(false);
  });

  it('selecting agy re-defaults to providers.agy[0] without changing the global defaults pair', () => {
    const resolved = resolveRunner('plan-audit', dummyConfig, { agent: 'agy' });
    expect(resolved).toEqual({ agent: 'agy', model: 'Gemini 3.5 Flash (Medium)' });
    // The global defaults pair is unchanged by this resolution.
    expect(dummyConfig.registry.defaults.agent).toBe('opencode');
    expect(dummyConfig.registry.defaults.model).toBe('opencode-go/deepseek-v4-flash');
  });

  it('trims whitespace when resolving agy models from CLI overrides', () => {
    const resolved = resolveRunner('plan-audit', dummyConfig, {
      agent: 'agy',
      model: '  Gemini 3.5 Flash (Medium)  '
    });
    expect(resolved).toEqual({ agent: 'agy', model: 'Gemini 3.5 Flash (Medium)' });
  });
});
