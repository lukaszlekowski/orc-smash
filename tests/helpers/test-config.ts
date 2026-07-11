import { DEFAULT_REGISTRY, type Config, type ModelRegistry } from '../../src/config.js';
import { loadManifest } from '../../src/manifest.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export interface CreateTestConfigOptions {
  projectRoot?: string;
  fakeModels?: string[];
  profiles?: Record<string, { provider: string; model?: string }>;
  defaultProfile?: string;
  timeouts?: ModelRegistry['timeouts'];
}

export function createTestConfig(options: CreateTestConfigOptions = {}): Config {
  const registry: ModelRegistry = structuredClone(DEFAULT_REGISTRY);
  
  // Inject fake provider
  const fakeModels = options.fakeModels ?? ['fake-model'];
  registry.providers['fake'] = {
    models: fakeModels,
    defaultModel: fakeModels[0]!
  };

  if (options.profiles) {
    registry.profiles = { ...registry.profiles, ...options.profiles };
  } else {
    // If not specified, map all profiles to fake provider for testing
    for (const profileName of Object.keys(registry.profiles)) {
      registry.profiles[profileName] = { provider: 'fake' };
    }
  }

  if (options.defaultProfile) {
    registry.defaultProfile = options.defaultProfile;
  }

  if (options.timeouts) {
    registry.timeouts = options.timeouts;
  }

  const projectRoot = options.projectRoot ?? process.cwd();
  let manifestPath = resolve(projectRoot, 'skills.yaml');
  if (!existsSync(manifestPath)) {
    // Check if in project root or tool root
    manifestPath = resolve(process.cwd(), 'skills.yaml');
  }

  const manifest = loadManifest(manifestPath, registry);

  return {
    registry,
    manifest
  };
}
