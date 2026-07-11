import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import YAML from 'yaml';
import { z } from 'zod';
import { loadManifest, type Manifest } from './manifest.js';

export interface ModelRegistry {
  providers: Record<string, string[]>;
  defaults: { agent: string; model: string };
  /**
   * Optional per-agent execution timeouts in ms (`0` disables). Precedence:
   *   - opencode: `OPENCODE_RUN_TIMEOUT_MS` env > `timeouts.opencode` > built-in 600000.
   *   - claude / codex / agy: config-only (`timeouts.<agent>` > built-in 0); no env vars.
   */
  timeouts?: { opencode?: number; claude?: number; codex?: number; agy?: number };
}

export const ModelRegistrySchema = z.object({
  providers: z.record(z.string(), z.array(z.string())),
  defaults: z.object({
    agent: z.string(),
    model: z.string()
  }),
  timeouts: z.object({
    opencode: z.number().int().nonnegative().optional(),
    claude: z.number().int().nonnegative().optional(),
    codex: z.number().int().nonnegative().optional(),
    agy: z.number().int().nonnegative().optional()
  }).strict().optional()
});

const RegistryOverridesSchema = z.object({
  defaults: ModelRegistrySchema.shape.defaults.optional(),
  timeouts: ModelRegistrySchema.shape.timeouts
}).strict();

const ProviderCatalogSchema = z.object({
  models: z.array(z.string()).min(1)
}).strict();

/**
 * Resolve a per-agent timeout from the registry, or `undefined` if unset.
 *
 * - `opencode`, `claude`, `codex`, and `agy` each read their own
 *   `timeouts.<agent>` key. `undefined` means "not configured" (the caller's
 *   built-in tier decides the fallback).
 * - Any other agent has no timeout support and resolves to `undefined`.
 */
export function registryTimeoutFor(registry: ModelRegistry, agent: string): number | undefined {
  const timeouts = registry.timeouts;
  if (!timeouts) return undefined;
  if (agent === 'opencode') return timeouts.opencode;
  if (agent === 'claude') return timeouts.claude;
  if (agent === 'codex') return timeouts.codex;
  if (agent === 'agy') return timeouts.agy;
  return undefined;
}

function loadPackagedRegistry(toolRoot: string): ModelRegistry {
  const configRoot = resolve(toolRoot, 'config');
  const registryPath = resolve(configRoot, 'registry.yaml');
  const providersRoot = resolve(configRoot, 'providers');

  try {
    const global = RegistryOverridesSchema.parse(YAML.parse(readFileSync(registryPath, 'utf-8')));
    if (!global.defaults) throw new Error('packaged registry is missing defaults');
    const providers: Record<string, string[]> = {};
    for (const file of readdirSync(providersRoot).sort()) {
      if (!file.endsWith('.yaml')) continue;
      const agent = file.slice(0, -'.yaml'.length);
      providers[agent] = ProviderCatalogSchema.parse(
        YAML.parse(readFileSync(resolve(providersRoot, file), 'utf-8'))
      ).models;
    }
    return ModelRegistrySchema.parse({ providers, defaults: global.defaults, timeouts: global.timeouts });
  } catch (err: any) {
    throw new Error(`Failed to load packaged provider registry at ${configRoot}: ${err.message}`);
  }
}

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Kept as an export for callers/tests; data lives exclusively in config/*.yaml.
export const DEFAULT_REGISTRY: ModelRegistry = loadPackagedRegistry(TOOL_ROOT);

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
      // Existing full registries remain supported for target fixtures and user
      // configuration. New repository config only overrides global settings;
      // provider catalogues stay in their dedicated files.
      if (parsed && typeof parsed === 'object' && 'providers' in parsed) {
        return ModelRegistrySchema.parse(parsed);
      }
      const overrides = RegistryOverridesSchema.parse(parsed);
      return ModelRegistrySchema.parse({
        providers: DEFAULT_REGISTRY.providers,
        defaults: overrides.defaults ?? DEFAULT_REGISTRY.defaults,
        timeouts: { ...DEFAULT_REGISTRY.timeouts, ...overrides.timeouts }
      });
    } catch (err: any) {
      throw new Error(`Failed to parse or validate model registry config at ${loadedPath}: ${err.message}`);
    }
  }

  return structuredClone(DEFAULT_REGISTRY);
}

export function loadConfig(projectRoot: string = process.cwd()): Config {
  const toolRoot = TOOL_ROOT;
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
