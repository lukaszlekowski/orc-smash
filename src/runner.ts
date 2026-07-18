import type { Config, ModelRegistry } from './config.js';
import type { Runner } from './loops/runtime.js';
import type { PerSkillOverride } from './runner-overrides.js';

/**
 * opencode's own model-id contract: `opencode run -m` requires the form
 * `provider/model` (verified via `opencode run --help`). The `provider/`
 * segment is opencode's transport/endpoint namespace (e.g. `opencode-go`),
 * owned by opencode — orc-smash treats the whole string as opaque and
 * validates only that it has exactly one `provider/model` slash.
 */
const OPENCODE_MODEL_ID = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/;

export interface ResolvedRunner extends Runner {
  agentSource: 'interactive' | 'skill' | 'global' | 'profile' | 'default' | 'session';
  modelSource: 'interactive' | 'skill' | 'agent-default' | 'global' | 'profile' | 'default' | 'session';
  inheritedSession?: { agent: string; model: string; sessionId: string };
}

export function isOpencodeModelId(model: string): boolean {
  return OPENCODE_MODEL_ID.test(model);
}

export function isValidModelForAgent(agent: string, model: string, registry: ModelRegistry): boolean {
  const catalogue = registry.providers[agent];
  if (!catalogue) {
    return false;
  }
  const allowedModels = catalogue.models;
  if (allowedModels.includes(model)) {
    return true;
  }
  // Per-provider shape rules for models outside the registry allow-list.
  if (agent === 'opencode') {
    return isOpencodeModelId(model);
  }
  if (agent === 'claude') {
    return model.startsWith('claude-');
  }
  if (agent === 'codex') {
    return !model.startsWith('opencode/') && !model.startsWith('claude-');
  }
  if (agent === 'agy') {
    // agy models are the exact human-readable names from `agy models`. This batch
    // accepts ONLY the configured `providers.agy` allow-list (with input
    // trimming), never namespace-style fallbacks like gpt-5.5 / opencode/... /
    // claude-... / any unconfigured human-readable label.
    return allowedModels.includes(model.trim());
  }
  if (agent === 'fake') {
    return true;
  }
  return false;
}

export function normalizeModelForAgent(agent: string, model: string): string {
  return agent === 'agy' ? model.trim() : model;
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

export function resolveRunner(
  skillId: string,
  config: Config,
  globalOverrides: { agent?: string; model?: string } = {},
  interactiveOverride?: { agent: string; model: string },
  perSkillOverride?: PerSkillOverride
): ResolvedRunner {
  // 1. Interactive override
  if (interactiveOverride) {
    validateAgentAndModel(interactiveOverride.agent, interactiveOverride.model, config.registry);
    return {
      agent: interactiveOverride.agent,
      model: normalizeModelForAgent(interactiveOverride.agent, interactiveOverride.model),
      agentSource: 'interactive',
      modelSource: 'interactive'
    };
  }

  // 2. Per-skill CLI override
  if (perSkillOverride) {
    return resolveWithPerSkillOverride(skillId, config, globalOverrides, perSkillOverride);
  }

  // 3. Global CLI overrides
  if (globalOverrides.agent || globalOverrides.model) {
    return resolveWithGlobalOverrides(config, globalOverrides);
  }

  // 4. Skill runner profile, then its provider catalogue default.
  const skill = config.manifest.skills[skillId];
  if (skill) {
    const profile = config.registry.profiles[skill.runnerProfile];
    if (!profile) throw new Error(`unknown runner profile '${skill.runnerProfile}'`);
    const agent = profile.provider;
    const catalogue = config.registry.providers[agent];
    if (!catalogue) throw new Error(`unknown agent '${agent}'; expected ${Object.keys(config.registry.providers).join(' | ')}`);
    const model = profile.model ?? catalogue.defaultModel;
    validateAgentAndModel(agent, model, config.registry);
    return {
      agent,
      model: normalizeModelForAgent(agent, model),
      agentSource: profile.model ? 'profile' : 'profile',
      modelSource: profile.model ? 'profile' : 'default'
    };
  }

  throw new Error(`Skill '${skillId}' not found in manifest, and no overrides provided.`);
}

function resolveWithPerSkillOverride(
  skillId: string,
  config: Config,
  globalOverrides: { agent?: string; model?: string },
  perSkillOverride: PerSkillOverride
): ResolvedRunner {
  const defaultProfile = config.registry.profiles[config.registry.defaultProfile];
  if (!defaultProfile) throw new Error(`unknown default runner profile '${config.registry.defaultProfile}'`);

  if (perSkillOverride.agent && perSkillOverride.model) {
    validateAgentAndModel(perSkillOverride.agent, perSkillOverride.model, config.registry);
    return {
      agent: perSkillOverride.agent,
      model: normalizeModelForAgent(perSkillOverride.agent, perSkillOverride.model),
      agentSource: 'skill',
      modelSource: 'skill'
    };
  }

  if (perSkillOverride.agent) {
    validateAgentAndModel(perSkillOverride.agent, perSkillOverride.agent, config.registry);
    const defaultModel = config.registry.providers[perSkillOverride.agent]?.defaultModel;
    if (!defaultModel) throw new Error(`no default model for agent '${perSkillOverride.agent}'`);
    return {
      agent: perSkillOverride.agent,
      model: normalizeModelForAgent(perSkillOverride.agent, defaultModel),
      agentSource: 'skill',
      modelSource: 'agent-default'
    };
  }

  if (perSkillOverride.model) {
    const baseRunner = resolveRunner(skillId, config, globalOverrides);
    validateAgentAndModel(baseRunner.agent, perSkillOverride.model, config.registry);
    return {
      agent: baseRunner.agent,
      model: normalizeModelForAgent(baseRunner.agent, perSkillOverride.model),
      agentSource: baseRunner.agentSource,
      modelSource: 'skill'
    };
  }

  return resolveRunner(skillId, config, globalOverrides);
}

function resolveWithGlobalOverrides(
  config: Config,
  globalOverrides: { agent?: string; model?: string }
): ResolvedRunner {
  const defaultProfile = config.registry.profiles[config.registry.defaultProfile];
  if (!defaultProfile) throw new Error(`unknown default runner profile '${config.registry.defaultProfile}'`);

  if (globalOverrides.agent && globalOverrides.model) {
    validateAgentAndModel(globalOverrides.agent, globalOverrides.model, config.registry);
    return {
      agent: globalOverrides.agent,
      model: normalizeModelForAgent(globalOverrides.agent, globalOverrides.model),
      agentSource: 'global',
      modelSource: 'global'
    };
  }

  if (globalOverrides.agent) {
    const defaultModel = config.registry.providers[globalOverrides.agent]?.defaultModel;
    if (!defaultModel) throw new Error(`no default model for agent '${globalOverrides.agent}'`);
    return {
      agent: globalOverrides.agent,
      model: normalizeModelForAgent(globalOverrides.agent, defaultModel),
      agentSource: 'global',
      modelSource: 'agent-default'
    };
  }

  if (globalOverrides.model) {
    const resolvedAgent = defaultProfile.provider;
    validateAgentAndModel(resolvedAgent, globalOverrides.model, config.registry);
    return {
      agent: resolvedAgent,
      model: normalizeModelForAgent(resolvedAgent, globalOverrides.model),
      agentSource: 'profile',
      modelSource: 'global'
    };
  }

  const resolvedAgent = defaultProfile.provider;
  const resolvedModel = defaultProfile.model ?? config.registry.providers[resolvedAgent]?.defaultModel;
  if (!resolvedModel) throw new Error(`no model resolved for agent '${resolvedAgent}'`);
  return {
    agent: resolvedAgent,
    model: normalizeModelForAgent(resolvedAgent, resolvedModel),
    agentSource: 'profile',
    modelSource: defaultProfile.model ? 'profile' : 'default'
  };
}
