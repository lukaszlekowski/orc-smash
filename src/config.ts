import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';
import { loadManifest, type Manifest } from './manifest.js';

export interface ModelRegistry {
  providers: Record<string, { models: string[]; defaultModel: string }>;
  defaultProfile: string;
  profiles: Record<string, { provider: string; model?: string }>;
  /**
   * Optional per-agent execution timeouts in ms (`0` disables). Precedence:
   *   - opencode: `OPENCODE_RUN_TIMEOUT_MS` env > `timeouts.opencode` > built-in 600000.
   *   - claude / codex / agy: config-only (`timeouts.<agent>` > built-in 0); no env vars.
   */
  timeouts?: { opencode?: number; claude?: number; codex?: number; agy?: number };
}

export const ModelRegistrySchema = z.object({
  providers: z.record(z.string(), z.object({
    models: z.array(z.string()).min(1),
    defaultModel: z.string()
  }).strict()),
  defaultProfile: z.string(),
  profiles: z.record(z.string(), z.object({ provider: z.string(), model: z.string().optional() }).strict()),
  timeouts: z.object({
    opencode: z.number().int().nonnegative().optional(),
    claude: z.number().int().nonnegative().optional(),
    codex: z.number().int().nonnegative().optional(),
    agy: z.number().int().nonnegative().optional()
  }).strict().optional()
}).superRefine((registry, ctx) => {
  for (const [provider, catalogue] of Object.entries(registry.providers)) {
    if (!catalogue.models.includes(catalogue.defaultModel)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providers', provider, 'defaultModel'], message: `defaultModel '${catalogue.defaultModel}' must be listed in models for provider '${provider}'` });
    }
  }
  for (const [profile, value] of Object.entries(registry.profiles)) {
    const catalogue = registry.providers[value.provider];
    if (!catalogue) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles', profile, 'provider'], message: `Profile '${profile}' names unknown provider '${value.provider}'` });
    } else if (value.model && !catalogue.models.includes(value.model)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles', profile, 'model'], message: `Profile '${profile}' specifies model '${value.model}' which is not in provider '${value.provider}' catalogue` });
    }
  }
  if (!registry.profiles[registry.defaultProfile]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultProfile'], message: `defaultProfile '${registry.defaultProfile}' does not exist` });
  }
});

const ProviderCatalogSchema = z.object({
  defaultModel: z.string(),
  models: z.array(z.string()).min(1)
}).strict();

const RunnersSchema = z.object({
  defaultProfile: z.string(),
  profiles: z.record(z.string(), z.object({ provider: z.string(), model: z.string().optional() }).strict())
}).strict();

const TimeoutsSchema = z.object({
  opencode: z.number().int().nonnegative().optional(),
  claude: z.number().int().nonnegative().optional(),
  codex: z.number().int().nonnegative().optional(),
  agy: z.number().int().nonnegative().optional()
}).strict();

const RegistryTimeoutsSchema = z.object({
  timeouts: TimeoutsSchema.optional()
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

const SUPPORTED_PRODUCTION_PROVIDERS = new Set(['opencode', 'codex', 'claude', 'agy']);

export function loadPackagedRegistry(toolRoot: string): ModelRegistry {
  const configRoot = resolve(toolRoot, 'config');
  const registryPath = resolve(configRoot, 'registry.yaml');
  const runnersPath = resolve(configRoot, 'runners.yaml');
  const providersRoot = resolve(configRoot, 'providers');

  try {
    const global = RegistryTimeoutsSchema.parse(YAML.parse(readFileSync(registryPath, 'utf-8')));
    const runners = RunnersSchema.parse(YAML.parse(readFileSync(runnersPath, 'utf-8')));
    const providers: Record<string, { models: string[]; defaultModel: string }> = {};
    const seen = new Set<string>();
    for (const file of readdirSync(providersRoot).sort()) {
      if (!file.endsWith('.yaml')) continue;
      const agent = file.slice(0, -'.yaml'.length);
      if (!SUPPORTED_PRODUCTION_PROVIDERS.has(agent)) {
        throw new Error(`Unsupported provider file '${file}' in ${providersRoot}; expected one of: ${[...SUPPORTED_PRODUCTION_PROVIDERS].join(', ')}`);
      }
      seen.add(agent);
      providers[agent] = ProviderCatalogSchema.parse(YAML.parse(readFileSync(resolve(providersRoot, file), 'utf-8')));
    }
    for (const expected of SUPPORTED_PRODUCTION_PROVIDERS) {
      if (!seen.has(expected)) {
        throw new Error(`Missing required provider catalogue '${expected}.yaml' in ${providersRoot}`);
      }
    }
    return ModelRegistrySchema.parse({ providers, ...runners, timeouts: global.timeouts });
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

export function loadModelRegistry(_projectRoot: string = process.cwd()): ModelRegistry {
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
