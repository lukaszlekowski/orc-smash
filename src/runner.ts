import type { Config, ModelRegistry } from './config.js';
import type { Runner } from './loops/runtime.js';
import type { PerSkillOverride } from './runner-overrides.js';
import type { AgentRegistry } from './adapters/registry.js';

/** opencode model ids are provider/model names in opencode's own namespace. */
const OPENCODE_MODEL_ID = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/;

export interface ResolvedRunner extends Runner {
  agentSource: 'interactive' | 'skill' | 'global' | 'profile' | 'default' | 'session';
  modelSource: 'interactive' | 'skill' | 'agent-default' | 'global' | 'profile' | 'default' | 'session';
  effort?: string;
  effortSource?: 'interactive' | 'skill' | 'global' | 'profile' | 'default';
  inheritedSession?: { agent: string; model: string; sessionId: string };
}

export function isOpencodeModelId(model: string): boolean {
  return OPENCODE_MODEL_ID.test(model);
}

export function isValidModelForAgent(agent: string, model: string, registry: ModelRegistry): boolean {
  const catalogue = registry.providers[agent];
  if (!catalogue) return false;
  if (catalogue.models.includes(model)) return true;
  if (agent === 'opencode') return isOpencodeModelId(model);
  if (agent === 'claude') return model.startsWith('claude-');
  if (agent === 'codex') return !model.startsWith('opencode/') && !model.startsWith('claude-');
  if (agent === 'agy') return catalogue.models.includes(model.trim());
  if (agent === 'fake') return true;
  return false;
}

export function isValidEffortForModel(agent: string, model: string, effort: string, registry: ModelRegistry): boolean {
  const catalogue = registry.providers[agent];
  if (!catalogue) return false;
  if (!catalogue.models.includes(model)) return false;
  const levels = catalogue.modelEfforts?.[model] ?? catalogue.efforts;
  return !!levels && levels.includes(effort);
}

export function isValidEffortForAgent(agent: string, effort: string, registry: ModelRegistry): boolean {
  const levels = registry.providers[agent]?.efforts;
  return !levels || levels.includes(effort);
}

export function validateAgentAndModel(agent: string, model: string, registry: ModelRegistry): void {
  const allowedAgents = Object.keys(registry.providers);
  if (!allowedAgents.includes(agent)) {
    throw new Error(`unknown agent '${agent}'; expected ${allowedAgents.join(' | ')}`);
  }
  if (!isValidModelForAgent(agent, model, registry)) {
    throw new Error(`model '${model}' is not a ${agent} model`);
  }
}

export function validateRunnerCapabilities(runner: Runner, registry: AgentRegistry): void {
  const adapter = registry.adapters.get(runner.agent);
  if (!adapter) {
    throw new Error(`unknown agent '${runner.agent}' in adapter registry`);
  }
  if (runner.effort && !adapter.capabilities.effort) {
    throw new Error(`agent '${runner.agent}' does not support effort selection`);
  }
}

export function resolveRunner(
  skillId: string,
  config: Config,
  globalOverrides: { agent?: string; model?: string; effort?: string } = {},
  interactiveOverride?: { agent: string; model: string; effort?: string },
  perSkillOverride?: PerSkillOverride,
  globalEffortOverride?: string,
): ResolvedRunner {
  const globalEffort = globalOverrides.effort ?? globalEffortOverride;

  if (interactiveOverride) {
    validateAgentAndModel(interactiveOverride.agent, interactiveOverride.model, config.registry);
    return makeRunner(
      interactiveOverride.agent,
      interactiveOverride.model,
      'interactive',
      'interactive',
      resolveEffort(interactiveOverride.agent, interactiveOverride.model, interactiveOverride.effort ?? perSkillOverride?.effort ?? globalEffort, undefined, 'interactive', config.registry),
      config.registry,
    );
  }

  if (perSkillOverride) {
    return resolveWithPerSkillOverride(skillId, config, globalOverrides, perSkillOverride, globalEffort);
  }

  if (globalOverrides.agent || globalOverrides.model) {
    return resolveWithGlobalOverrides(config, globalOverrides, globalEffort);
  }

  const skill = config.manifest.skills[skillId];
  if (!skill) throw new Error(`Skill '${skillId}' not found in manifest, and no overrides provided.`);
  const profile = config.registry.profiles[skill.runnerProfile];
  if (!profile) throw new Error(`unknown runner profile '${skill.runnerProfile}'`);
  const catalogue = config.registry.providers[profile.provider];
  if (!catalogue) throw new Error(`unknown agent '${profile.provider}'; expected ${Object.keys(config.registry.providers).join(' | ')}`);
  const model = profile.model ?? catalogue.defaultModel;
  validateAgentAndModel(profile.provider, model, config.registry);
  const effort = resolveEffort(profile.provider, model, globalEffort, profile.effort, globalEffort ? 'global' : 'profile', config.registry);
  return makeRunner(
    profile.provider,
    model,
    'profile',
    profile.model ? 'profile' : 'default',
    effort,
    config.registry,
  );
}

function resolveWithPerSkillOverride(
  skillId: string,
  config: Config,
  globalOverrides: { agent?: string; model?: string; effort?: string },
  override: PerSkillOverride,
  globalEffort?: string,
): ResolvedRunner {
  if (override.agent && override.model) {
    validateAgentAndModel(override.agent, override.model, config.registry);
    return makeRunner(
      override.agent,
      override.model,
      'skill',
      'skill',
      resolveEffort(override.agent, override.model, override.effort ?? globalEffort, undefined, 'skill', config.registry),
      config.registry,
    );
  }

  if (override.agent) {
    const model = config.registry.providers[override.agent]?.defaultModel;
    if (!model) throw new Error(`no default model for agent '${override.agent}'`);
    validateAgentAndModel(override.agent, model, config.registry);
    return makeRunner(
      override.agent,
      model,
      'skill',
      'agent-default',
      resolveEffort(override.agent, model, override.effort ?? globalEffort, undefined, 'skill', config.registry),
      config.registry,
    );
  }

  if (override.model) {
    const base = resolveRunner(skillId, config, globalOverrides, undefined, undefined, globalEffort);
    validateAgentAndModel(base.agent, override.model, config.registry);
    return makeRunner(
      base.agent,
      override.model,
      base.agentSource,
      'skill',
      resolveEffort(base.agent, override.model, override.effort ?? globalEffort, base.effort, override.effort || globalEffort ? 'skill' : base.effortSource ?? 'profile', config.registry),
      config.registry,
    );
  }

  return resolveRunner(skillId, config, globalOverrides, undefined, undefined, globalEffort);
}

function resolveWithGlobalOverrides(
  config: Config,
  overrides: { agent?: string; model?: string; effort?: string },
  globalEffort?: string,
): ResolvedRunner {
  const defaultProfile = config.registry.profiles[config.registry.defaultProfile];
  if (!defaultProfile) throw new Error(`unknown default runner profile '${config.registry.defaultProfile}'`);

  if (overrides.agent && overrides.model) {
    validateAgentAndModel(overrides.agent, overrides.model, config.registry);
    return makeRunner(overrides.agent, overrides.model, 'global', 'global', resolveEffort(overrides.agent, overrides.model, overrides.effort ?? globalEffort, undefined, 'global', config.registry), config.registry);
  }

  if (overrides.agent) {
    const model = config.registry.providers[overrides.agent]?.defaultModel;
    if (!model) throw new Error(`no default model for agent '${overrides.agent}'`);
    validateAgentAndModel(overrides.agent, model, config.registry);
    return makeRunner(overrides.agent, model, 'global', 'agent-default', resolveEffort(overrides.agent, model, overrides.effort ?? globalEffort, undefined, 'global', config.registry), config.registry);
  }

  const agent = defaultProfile.provider;
  if (overrides.model) {
    validateAgentAndModel(agent, overrides.model, config.registry);
    return makeRunner(agent, overrides.model, 'profile', 'global', resolveEffort(agent, overrides.model, overrides.effort ?? globalEffort, undefined, 'global', config.registry), config.registry);
  }

  const model = defaultProfile.model ?? config.registry.providers[agent]?.defaultModel;
  if (!model) throw new Error(`no model resolved for agent '${agent}'`);
  return makeRunner(agent, model, 'profile', defaultProfile.model ? 'profile' : 'default', resolveEffort(agent, model, overrides.effort ?? globalEffort, defaultProfile.effort, overrides.effort || globalEffort ? 'global' : 'profile', config.registry), config.registry);
}

function resolveEffort(
  agent: string,
  model: string,
  explicit: string | undefined,
  profileEffort: string | undefined,
  source: ResolvedRunner['effortSource'],
  registry: ModelRegistry,
): { value: string; source: ResolvedRunner['effortSource'] } | null {
  const value = explicit ?? profileEffort ?? registry.providers[agent]?.defaultEffort;
  if (!value) return null;
  if (!isValidEffortForModel(agent, model, value, registry)) {
    if (explicit) {
      throw new Error(`effort '${value}' is not supported by agent '${agent}' model '${model}'`);
    }
    return null;
  }
  const resolvedSource = explicit
    ? source
    : profileEffort
      ? 'profile'
      : 'default';
  return { value, source: resolvedSource };
}

function makeRunner(
  agent: string,
  model: string,
  agentSource: ResolvedRunner['agentSource'],
  modelSource: ResolvedRunner['modelSource'],
  effort: { value: string; source: ResolvedRunner['effortSource'] } | null,
  registry: ModelRegistry,
): ResolvedRunner {
  validateAgentAndModel(agent, model, registry);
  return {
    agent,
    model: agent === 'agy' ? model.trim() : model,
    agentSource,
    modelSource,
    ...(effort ? { effort: effort.value, effortSource: effort.source } : {}),
  };
}
