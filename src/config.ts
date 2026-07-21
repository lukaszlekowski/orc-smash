import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { z } from 'zod';
import { loadManifest, type V1Manifest } from './manifest.js';

export interface ModelRegistry {
  providers: Record<string, { models: string[]; defaultModel: string; efforts?: string[]; defaultEffort?: string }>;
  defaultProfile: string;
  profiles: Record<string, { provider: string; model?: string; effort?: string }>;
  timeouts?: { opencode?: number; claude?: number; codex?: number; agy?: number };
}

export const ModelRegistrySchema = z.object({
  providers: z.record(z.string(), z.object({
    models: z.array(z.string()).min(1),
    defaultModel: z.string(),
    efforts: z.array(z.string()).min(1).optional(),
    defaultEffort: z.string().optional(),
  }).strict()),
  defaultProfile: z.string(),
  profiles: z.record(z.string(), z.object({ provider: z.string(), model: z.string().optional(), effort: z.string().optional() }).strict()),
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
    if (catalogue) {
      if (catalogue.efforts && value.effort && !catalogue.efforts.includes(value.effort)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profiles', profile, 'effort'], message: `Profile '${profile}' specifies effort '${value.effort}' which is not supported by provider '${value.provider}'` });
      }
      if (catalogue.efforts && catalogue.defaultEffort && !catalogue.efforts.includes(catalogue.defaultEffort)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['providers', value.provider, 'defaultEffort'], message: `defaultEffort '${catalogue.defaultEffort}' must be listed in provider '${value.provider}' efforts` });
      }
    }
  }
  if (!registry.profiles[registry.defaultProfile]) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['defaultProfile'], message: `defaultProfile '${registry.defaultProfile}' does not exist` });
  }
});

const ProviderCatalogSchema = z.object({
  defaultModel: z.string(),
  models: z.array(z.string()).min(1),
  efforts: z.array(z.string()).min(1).optional(),
  defaultEffort: z.string().optional(),
}).strict();

const RunnersSchema = z.object({
  defaultProfile: z.string(),
  profiles: z.record(z.string(), z.object({ provider: z.string(), model: z.string().optional(), effort: z.string().optional() }).strict())
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
    const providers: Record<string, { models: string[]; defaultModel: string; efforts?: string[]; defaultEffort?: string }> = {};
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

export const DEFAULT_REGISTRY: ModelRegistry = loadPackagedRegistry(TOOL_ROOT);

export interface Config {
  /** The project root directory (resolved --project). */
  projectRoot: string;
  /** The resolved manifest file path. */
  manifestPath: string;
  /**
   * Root for resolving role/skill definition `file` values.
   * This is the tool root for the packaged manifest and the directory of an
   * external/project manifest.
   */
  manifestRoot: string;
  registry: ModelRegistry;
  manifest: V1Manifest;
}

/**
 * Load configuration with the v1 precedence:
 *   1. `--config <path>` (explicit)
 *   2. `<projectRoot>/.orc-smash.yaml` (project-local override)
 *   3. `config/orc-smash.yaml` (packaged default)
 *
 * `manifestRoot` is the packaged tool root for the packaged manifest, or the
 * directory containing an external/project manifest. `projectRoot` is always
 * the resolved --project directory.
 */
export function loadConfig(
  projectRoot: string = process.cwd(),
  configPath?: string,
): Config {
  const resolvedProjectRoot = resolve(projectRoot);
  const registry = loadModelRegistry(resolvedProjectRoot);

  let manifestPath: string;

  if (configPath) {
    manifestPath = resolve(configPath);
    if (!existsSync(manifestPath)) {
      throw new Error(`Specified config file not found: ${manifestPath}`);
    }
  } else {
    const projectOverride = resolve(resolvedProjectRoot, '.orc-smash.yaml');
    if (existsSync(projectOverride)) {
      manifestPath = projectOverride;
    } else {
      manifestPath = resolve(TOOL_ROOT, 'config', 'orc-smash.yaml');
      if (!existsSync(manifestPath)) {
        throw new Error(`Packaged default manifest not found: ${manifestPath}`);
      }
    }
  }

  /**
   * manifestRoot is the directory from which role/skill file paths are resolved.
   * For the packaged default at <toolRoot>/config/orc-smash.yaml, manifestRoot is
   * the tool root (so roles/ and skills/ resolve correctly). For project overrides
   * and external configs, manifestRoot is the directory containing the config.
   */
  let manifestRoot = dirname(manifestPath);
  if (manifestPath === resolve(TOOL_ROOT, 'config', 'orc-smash.yaml')) {
    manifestRoot = TOOL_ROOT;
  }
  const manifest = loadManifest(manifestPath, registry, {
    manifestRoot,
    projectRoot: resolvedProjectRoot,
  });

  return {
    projectRoot: resolvedProjectRoot,
    manifestPath,
    manifestRoot,
    registry,
    manifest,
  };
}

export function loadModelRegistry(_projectRoot: string = process.cwd()): ModelRegistry {
  return structuredClone(DEFAULT_REGISTRY);
}
