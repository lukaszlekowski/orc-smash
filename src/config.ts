import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import YAML from 'yaml';
import { z } from 'zod';
import { loadManifest, type Manifest } from './manifest.js';

export interface ModelRegistry {
  providers: Record<string, string[]>;
  defaults: { agent: string; model: string };
}

export const ModelRegistrySchema = z.object({
  providers: z.record(z.string(), z.array(z.string())),
  defaults: z.object({
    agent: z.string(),
    model: z.string()
  })
});

export const DEFAULT_REGISTRY: ModelRegistry = {
  providers: {
    opencode: [
      'opencode-go/deepseek-v4-flash',
      'opencode-go/deepseek-v4-pro',
      'opencode-go/glm-5.2',
      'opencode-go/minimax-m3',
      'opencode-go/qwen3.7-max'
    ],
    claude: [
      'claude-sonnet-4-6'
    ],
    codex: [
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini'
    ]
  },
  defaults: {
    agent: 'opencode',
    model: 'opencode-go/deepseek-v4-flash'
  }
};

export interface Config {
  registry: ModelRegistry;
  manifest: Manifest;
}

export function loadModelRegistry(projectRoot: string = process.cwd()): ModelRegistry {
  const localPath = resolve(projectRoot, 'orc.config.yaml');
  const homePath = resolve(os.homedir(), '.config/orc/config.yaml');

  let configContent: string | null = null;
  let loadedPath = '';

  if (existsSync(localPath)) {
    configContent = readFileSync(localPath, 'utf-8');
    loadedPath = localPath;
  } else if (existsSync(homePath)) {
    configContent = readFileSync(homePath, 'utf-8');
    loadedPath = homePath;
  }

  if (configContent !== null) {
    try {
      const parsed = YAML.parse(configContent);
      return ModelRegistrySchema.parse(parsed);
    } catch (err: any) {
      throw new Error(`Failed to parse or validate model registry config at ${loadedPath}: ${err.message}`);
    }
  }

  return { ...DEFAULT_REGISTRY };
}

export function loadConfig(projectRoot: string = process.cwd()): Config {
  const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let manifestPath = resolve(toolRoot, 'skills.yaml');
  if (!existsSync(manifestPath)) {
    manifestPath = resolve(projectRoot, 'skills.yaml');
  }

  const registry = loadModelRegistry(projectRoot);
  const manifest = loadManifest(manifestPath, registry);

  return {
    registry,
    manifest
  };
}
