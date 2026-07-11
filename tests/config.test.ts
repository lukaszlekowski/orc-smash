import { describe, it, expect } from 'vitest';
import { DEFAULT_REGISTRY, loadModelRegistry, ModelRegistrySchema, registryTimeoutFor } from '../src/config.js';

describe('provider catalogue configuration', () => {
  it('loads only the committed package registry', () => {
    expect(loadModelRegistry('/a/project')).toEqual(DEFAULT_REGISTRY);
    expect(DEFAULT_REGISTRY.providers.codex.models).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
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

  it('exposes configured timeouts', () => {
    expect(registryTimeoutFor(DEFAULT_REGISTRY, 'claude')).toBe(0);
    expect(registryTimeoutFor(DEFAULT_REGISTRY, 'fake')).toBeUndefined();
  });
});
