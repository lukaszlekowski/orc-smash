import { describe, it, expect } from 'vitest';
import { resolveRunner, isValidModelForAgent } from '../src/runner.js';
import type { Config } from '../src/config.js';

describe('Runner selection and verification', () => {
  const dummyConfig: Config = {
    defaultAgent: 'opencode',
    defaultModel: 'opencode-go/deepseek-v4-flash',
    agentDefaultModels: {
      opencode: 'opencode-go/deepseek-v4-flash',
      codex: 'gpt-5-codex',
      claude: 'claude-sonnet-4-6'
    },
    apiKeys: {},
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
    expect(isValidModelForAgent('opencode', 'opencode-go/deepseek-v4-flash')).toBe(true);
    expect(isValidModelForAgent('opencode', 'zai-coding-plan/glm-5.2')).toBe(true);
    expect(isValidModelForAgent('opencode', 'opencode/deepseek')).toBe(true);
    expect(isValidModelForAgent('opencode', 'gpt-5-codex')).toBe(false);

    expect(isValidModelForAgent('claude', 'claude-sonnet-4-6')).toBe(true);
    expect(isValidModelForAgent('claude', 'opencode/deepseek')).toBe(false);

    expect(isValidModelForAgent('codex', 'gpt-5-codex')).toBe(true);
    expect(isValidModelForAgent('codex', 'opencode/deepseek')).toBe(false);
    expect(isValidModelForAgent('codex', 'claude-sonnet-4-6')).toBe(false);
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
});
