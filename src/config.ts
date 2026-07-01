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
      'glm-4.7',
      'glm-5.1',
      'glm-5.2',
      'glm-5.2[1m]'
    ],
    codex: [
      'gpt-5.5',
      'gpt-5.4',
      'gpt-5.4-mini'
    ],
    // Antigravity (`agy`): model ids are the human-readable names printed by
    // `agy models`, passed verbatim. The fallback model when an operator selects
    // `agy` is `providers.agy[0]` (no per-agent default config field this batch).
    agy: [
      'Gemini 3.5 Flash (Medium)',
      'Gemini 3.5 Pro (Medium)',
      'Gemini 3.5 Flash (High)'
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
