import { describe, it, expect } from 'vitest';
import { resolveRunner, isValidEffortForModel, isValidModelForAgent } from '../src/runner.js';
import type { Config } from '../src/config.js';

const config: Config = {
  projectRoot: process.cwd(),
  manifestPath: '/path/to/config/orc-smash.yaml',
  manifestRoot: '/path/to/config',
  manifestDeclarationOrder: { loops: ['plan'], tasks: [], pipelines: [] },
  registry: {
    providers: {
      opencode: { models: ['opencode-go/x'], defaultModel: 'opencode-go/x' },
      claude: { models: ['claude-x', 'claude-custom'], defaultModel: 'claude-x' },
      codex: { models: ['gpt-x'], defaultModel: 'gpt-x' },
      agy: {
        models: ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.1-pro', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b-medium'],
        defaultModel: 'gemini-3.6-flash',
        modelEfforts: {
          'gemini-3.6-flash': ['low', 'medium', 'high'],
          'gemini-3.5-flash': ['low', 'medium', 'high'],
          'gemini-3.1-pro': ['low', 'high'],
        },
      },
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
    expect(resolveRunner('audit', config, {}, undefined, { agent: 'agy' })).toMatchObject({ agent: 'agy', model: 'gemini-3.6-flash', agentSource: 'skill', modelSource: 'agent-default' });
  });
  it('keeps agy a strict catalogue allow-list', () => {
    expect(isValidModelForAgent('agy', ' gemini-3.6-flash ', config.registry)).toBe(true);
    expect(isValidModelForAgent('agy', 'Gemini 3.5 Flash (Medium)', config.registry)).toBe(false);
    expect(isValidModelForAgent('agy', 'gpt-x', config.registry)).toBe(false);
    expect(isValidEffortForModel('agy', ' gemini-3.6-flash ', 'high', config.registry)).toBe(true);
    expect(isValidEffortForModel('agy', 'gemini-3.1-pro', 'medium', config.registry)).toBe(false);
  });
});
