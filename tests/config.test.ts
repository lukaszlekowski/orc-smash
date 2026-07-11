import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_REGISTRY, loadModelRegistry, loadPackagedRegistry, ModelRegistrySchema, registryTimeoutFor } from '../src/config.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

describe('provider catalogue configuration', () => {
  it('loads only the committed package registry', () => {
    expect(loadModelRegistry('/a/project')).toEqual(DEFAULT_REGISTRY);
    expect(DEFAULT_REGISTRY.providers.codex.models).toEqual([
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini'
    ]);
  });

  it('requires a non-empty catalogue and a listed default model', () => {
    const base = structuredClone(DEFAULT_REGISTRY);
    base.providers.codex.models = [];
    expect(ModelRegistrySchema.safeParse(base).success).toBe(false);
    const wrongDefault = structuredClone(DEFAULT_REGISTRY);
    wrongDefault.providers.codex.defaultModel = 'missing';
    expect(ModelRegistrySchema.safeParse(wrongDefault).success).toBe(false);
  });

  it('requires profiles to name configured providers and defaultProfile to exist', () => {
    const unknownProvider = structuredClone(DEFAULT_REGISTRY);
    unknownProvider.profiles.audit.provider = 'missing';
    expect(ModelRegistrySchema.safeParse(unknownProvider).success).toBe(false);
    const unknownProfile = structuredClone(DEFAULT_REGISTRY);
    unknownProfile.defaultProfile = 'missing';
    expect(ModelRegistrySchema.safeParse(unknownProfile).success).toBe(false);
  });

  it('validates profile explicit models', () => {
    const validModel = structuredClone(DEFAULT_REGISTRY);
    validModel.profiles.audit.model = 'opencode-go/deepseek-v4-pro';
    expect(ModelRegistrySchema.safeParse(validModel).success).toBe(true);

    const invalidModel = structuredClone(DEFAULT_REGISTRY);
    invalidModel.profiles.audit.model = 'foreign-model';
    expect(ModelRegistrySchema.safeParse(invalidModel).success).toBe(false);
  });

  it('ignores any target-local config file (override-is-ignored regression)', () => {
    const tempWorkspace = join(process.cwd(), 'temp-override-ignore-test');
    createTempDir('temp-override-ignore-test');
    writeFileSync(
      join(tempWorkspace, 'orc.config.yaml'),
      'providers:\n  fake:\n    - fake-model-from-local\n'
    );
    const registry = loadModelRegistry(tempWorkspace);
    expect(registry.providers.fake).toBeUndefined();
    expect(registry).toEqual(DEFAULT_REGISTRY);
    removeTempDir(tempWorkspace);
  });

  it('every provider defaultModel matches its pre-migration effective default', () => {
    expect(DEFAULT_REGISTRY.providers.claude.defaultModel).toBe('glm-4.7');
    expect(DEFAULT_REGISTRY.providers.codex.defaultModel).toBe('gpt-5.5');
    expect(DEFAULT_REGISTRY.providers.opencode.defaultModel).toBe('opencode-go/deepseek-v4-flash');
    expect(DEFAULT_REGISTRY.providers.agy.defaultModel).toBe('Gemini 3.5 Flash (Medium)');
  });

  it('exposes configured timeouts', () => {
    expect(registryTimeoutFor(DEFAULT_REGISTRY, 'claude')).toBe(0);
    expect(registryTimeoutFor(DEFAULT_REGISTRY, 'fake')).toBeUndefined();
  });

  it('rejects an unknown provider file in the packaged config', () => {
    const tempDir = createTempDir('temp-unknown-provider-test');
    const configRoot = join(tempDir, 'config');
    const providersRoot = join(configRoot, 'providers');
    mkdirSync(providersRoot, { recursive: true });
    writeFileSync(join(configRoot, 'registry.yaml'), 'timeouts: {}\n');
    writeFileSync(join(configRoot, 'runners.yaml'), 'defaultProfile: audit\nprofiles:\n  audit: { provider: opencode }\n');
    for (const p of ['opencode', 'codex', 'claude', 'agy']) {
      writeFileSync(join(providersRoot, `${p}.yaml`), `defaultModel: m\nmodels:\n  - m\n`);
    }
    writeFileSync(join(providersRoot, 'unknown.yaml'), 'defaultModel: x\nmodels:\n  - x\n');
    expect(() => loadPackagedRegistry(tempDir)).toThrow('Unsupported provider');
    removeTempDir(tempDir);
  });

  it('rejects a missing required provider catalogue', () => {
    const tempDir = createTempDir('temp-missing-provider-test');
    const configRoot = join(tempDir, 'config');
    const providersRoot = join(configRoot, 'providers');
    mkdirSync(providersRoot, { recursive: true });
    writeFileSync(join(configRoot, 'registry.yaml'), 'timeouts: {}\n');
    writeFileSync(join(configRoot, 'runners.yaml'), 'defaultProfile: audit\nprofiles:\n  audit: { provider: opencode }\n');
    for (const p of ['opencode', 'codex', 'claude']) {
      writeFileSync(join(providersRoot, `${p}.yaml`), `defaultModel: m\nmodels:\n  - m\n`);
    }
    // agy.yaml is missing
    expect(() => loadPackagedRegistry(tempDir)).toThrow('Missing required provider');
    removeTempDir(tempDir);
  });
});
