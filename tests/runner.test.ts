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
});
