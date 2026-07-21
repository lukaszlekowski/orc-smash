import { DEFAULT_REGISTRY, type Config, type ModelRegistry } from '../../src/config.js';
import { loadManifest } from '../../src/manifest.js';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface CreateTestConfigOptions {
  projectRoot?: string;
  fakeModels?: string[];
  profiles?: Record<string, { provider: string; model?: string }>;
  defaultProfile?: string;
  timeouts?: ModelRegistry['timeouts'];
}

export function createTestConfig(options: CreateTestConfigOptions = {}): Config {
  const registry: ModelRegistry = structuredClone(DEFAULT_REGISTRY);

  const fakeModels = options.fakeModels ?? ['fake-model'];
  registry.providers['fake'] = {
    models: fakeModels,
    defaultModel: fakeModels[0]!
  };

  if (options.profiles) {
    registry.profiles = { ...registry.profiles, ...options.profiles };
  } else {
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
  let manifestPath = resolve(projectRoot, 'config', 'orc-smash.yaml');
  if (!existsSync(manifestPath)) {
    manifestPath = resolve(projectRoot, '.orc-smash.yaml');
  }
  if (!existsSync(manifestPath)) {
    manifestPath = resolve(process.cwd(), 'config', 'orc-smash.yaml');
  }

  let manifestRoot = dirname(manifestPath);
  const TOOL_ROOT = resolve(import.meta.dirname ?? dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (manifestPath === resolve(TOOL_ROOT, 'config', 'orc-smash.yaml')) {
    manifestRoot = TOOL_ROOT;
  }
  const manifest = loadManifest(manifestPath, registry);

  return {
    projectRoot,
    manifestPath,
    manifestRoot,
    registry,
    manifest,
  };
}
