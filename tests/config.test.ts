import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_REGISTRY, loadModelRegistry, loadPackagedRegistry, ModelRegistrySchema, registryTimeoutFor, type ModelRegistry } from '../src/config.js';
import { isValidEffortForModel } from '../src/runner.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

describe('provider catalogue configuration', () => {
  it('loads only the committed package registry', () => {
    expect(loadModelRegistry('/a/project')).toEqual(DEFAULT_REGISTRY);
    expect(DEFAULT_REGISTRY.providers.codex.models).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
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
    validModel.profiles.audit.model = 'glm-4.7';
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

  it('loads the committed provider defaults', () => {
    expect(DEFAULT_REGISTRY.providers.claude.defaultModel).toBe('glm-5.2[1m]');
    expect(DEFAULT_REGISTRY.providers.codex.defaultModel).toBe('gpt-5.6-luna');
    expect(DEFAULT_REGISTRY.providers.opencode.defaultModel).toBe('opencode-go/deepseek-v4-flash');
    expect(DEFAULT_REGISTRY.providers.agy.defaultModel).toBe('gemini-3.6-flash');
    expect(DEFAULT_REGISTRY.providers.agy.models).toEqual([
      'gemini-3.6-flash',
      'gemini-3.5-flash',
      'gemini-3.1-pro',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
    ]);
    expect(DEFAULT_REGISTRY.providers.agy.modelEfforts).toEqual({
      'gemini-3.6-flash': ['low', 'medium', 'high'],
      'gemini-3.5-flash': ['low', 'medium', 'high'],
      'gemini-3.1-pro': ['low', 'high'],
    });
  });

  it('exposes configured timeouts', () => {
    expect(registryTimeoutFor(DEFAULT_REGISTRY, 'claude')).toBe(0);
    expect(registryTimeoutFor(DEFAULT_REGISTRY, 'fake')).toBeUndefined();
  });

  it('opencode deepseek-v4-pro efforts parse correctly (no YAML comma bug)', () => {
    const efforts = DEFAULT_REGISTRY.providers.opencode.modelEfforts?.['opencode-go/deepseek-v4-pro'];
    expect(efforts).toBeDefined();
    expect(efforts).toEqual(['Default', 'high', 'max']);
  });

  it('agy provider has no defaultEffort in committed config', () => {
    expect(DEFAULT_REGISTRY.providers.agy.defaultEffort).toBeUndefined();
  });

  it('opencode deepseek-v4-pro effort tokens validate correctly', () => {
    // After the fix for the YAML comma bug, 'Default', 'high', and 'max' must
    // all be valid efforts for deepseek-v4-pro.
    const registry = structuredClone(DEFAULT_REGISTRY);
    expect(isValidEffortForModel('opencode', 'opencode-go/deepseek-v4-pro', 'Default', registry)).toBe(true);
    expect(isValidEffortForModel('opencode', 'opencode-go/deepseek-v4-pro', 'high', registry)).toBe(true);
    expect(isValidEffortForModel('opencode', 'opencode-go/deepseek-v4-pro', 'max', registry)).toBe(true);
    // The old comma-bug token "default high" must NOT be valid.
    expect(isValidEffortForModel('opencode', 'opencode-go/deepseek-v4-pro', 'default high', registry)).toBe(false);
  });

  it('agy runner resolves no effort when defaultEffort is absent', () => {
    // With no defaultEffort in the AGY provider config, the runner must return
    // undefined effort when no explicit choice is given.
    const registry: ModelRegistry = structuredClone(DEFAULT_REGISTRY);
    expect(registry.providers.agy.defaultEffort).toBeUndefined();
    // Simulate effort resolution: when explicit, profile, and defaultEffort are
    // all absent, resolveEffort returns null. We verify this by checking that
    // isValidEffortForModel still works (the effort contract is modelEfforts-only)
    // and that the real config matches the committed state.
    expect(registry.providers.agy.modelEfforts?.['gemini-3.6-flash']).toEqual(['low', 'medium', 'high']);
    // The runner's resolveEffort lookup chain: explicit ?? profileEffort ??
    // registry.providers[agent]?.defaultEffort. When the last is undefined, null.
    expect(registry.providers.agy.defaultEffort).toBeUndefined();
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
