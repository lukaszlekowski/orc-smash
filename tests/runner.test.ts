import { describe, it, expect } from 'vitest';
import { resolveRunner, isValidModelForAgent } from '../src/runner.js';
import type { Config } from '../src/config.js';

const config: Config = {
  registry: {
    providers: {
      opencode: { models: ['opencode-go/x'], defaultModel: 'opencode-go/x' },
      claude: { models: ['claude-x', 'claude-custom'], defaultModel: 'claude-x' },
      codex: { models: ['gpt-x'], defaultModel: 'gpt-x' },
      agy: { models: ['Gemini'], defaultModel: 'Gemini' },
      fake: { models: ['fake'], defaultModel: 'fake' }
    },
    defaultProfile: 'arbitrary-profile',
    profiles: {
      'arbitrary-profile': { provider: 'opencode' },
      other: { provider: 'claude' },
      exceptional: { provider: 'claude', model: 'claude-custom' },
      invalidExceptional: { provider: 'claude', model: 'foreign-model' }
    }
  },
  manifest: {
    roles: { auditor: 'a' },
    skills: {
      audit: { file: 'a', role: 'auditor', kind: 'audit', runnerProfile: 'other' },
      exceptionalAudit: { file: 'a', role: 'auditor', kind: 'audit', runnerProfile: 'exceptional' },
      invalidExceptionalAudit: { file: 'a', role: 'auditor', kind: 'audit', runnerProfile: 'invalidExceptional' }
    },
    loops: {}
  }
};

describe('runner selection', () => {
  it('resolves an arbitrary profile name to its provider default', () => {
    expect(resolveRunner('audit', config)).toMatchObject({ agent: 'claude', model: 'claude-x' });
  });
  it('resolves an exceptional profile to its explicit model', () => {
    expect(resolveRunner('exceptionalAudit', config)).toMatchObject({ agent: 'claude', model: 'claude-custom' });
  });
  it('throws when resolving a profile with a foreign model', () => {
    expect(() => resolveRunner('invalidExceptionalAudit', config)).toThrow(/is not a claude model/);
  });
  it('uses CLI agent/model overrides and model-only uses defaultProfile provider', () => {
    expect(resolveRunner('audit', config, { agent: 'codex' })).toMatchObject({ agent: 'codex', model: 'gpt-x' });
    expect(resolveRunner('audit', config, { model: 'opencode-go/y' })).toMatchObject({ agent: 'opencode', model: 'opencode-go/y' });
  });
  it('keeps agy a strict catalogue allow-list', () => {
    expect(isValidModelForAgent('agy', ' Gemini ', config.registry)).toBe(true);
    expect(isValidModelForAgent('agy', 'gpt-x', config.registry)).toBe(false);
  });
});
