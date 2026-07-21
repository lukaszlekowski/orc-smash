import { describe, it, expect } from 'vitest';
import { resolveRunner, isValidModelForAgent } from '../src/runner.js';
import type { Config } from '../src/config.js';

const config: Config = {
  projectRoot: process.cwd(),
  manifestPath: '/path/to/config/orc-smash.yaml',
  manifestRoot: '/path/to/config',
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
    schemaVersion: 1 as const,
    roles: { auditor: 'a' },
    skills: {
      audit: { file: 'a', role: 'auditor', runnerProfile: 'other' },
      exceptionalAudit: { file: 'a', role: 'auditor', runnerProfile: 'exceptional' },
      invalidExceptionalAudit: { file: 'a', role: 'auditor', runnerProfile: 'invalidExceptional' }
    },
    loops: {},
    tasks: {},
    pipelines: {}
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
  it('re-defaults agent-only per-skill overrides in each provider namespace', () => {
    expect(resolveRunner('audit', config, {}, undefined, { agent: 'claude' })).toMatchObject({ agent: 'claude', model: 'claude-x', agentSource: 'skill', modelSource: 'agent-default' });
    expect(resolveRunner('audit', config, {}, undefined, { agent: 'opencode' })).toMatchObject({ agent: 'opencode', model: 'opencode-go/x', agentSource: 'skill', modelSource: 'agent-default' });
    expect(resolveRunner('audit', config, {}, undefined, { agent: 'codex' })).toMatchObject({ agent: 'codex', model: 'gpt-x', agentSource: 'skill', modelSource: 'agent-default' });
    expect(resolveRunner('audit', config, {}, undefined, { agent: 'agy' })).toMatchObject({ agent: 'agy', model: 'Gemini', agentSource: 'skill', modelSource: 'agent-default' });
  });
  it('keeps agy a strict catalogue allow-list', () => {
    expect(isValidModelForAgent('agy', ' Gemini ', config.registry)).toBe(true);
    expect(isValidModelForAgent('agy', 'gpt-x', config.registry)).toBe(false);
  });
});
