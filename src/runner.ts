import type { Config, ModelRegistry } from './config.js';

export function isValidModelForAgent(agent: string, model: string, registry: ModelRegistry): boolean {
  const allowedModels = registry.providers[agent];
  if (!allowedModels) {
    return false;
  }
  if (allowedModels.includes(model)) {
    return true;
  }
  // fallback migration aid for agents present in registry but with model outside allow-list
  if (agent === 'opencode') {
    return /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/.test(model);
  }
  if (agent === 'claude') {
    return model.startsWith('claude-');
  }
  if (agent === 'codex') {
    return !model.startsWith('opencode/') && !model.startsWith('claude-');
  }
  if (agent === 'fake') {
    return true;
  }
  return false;
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
  interactiveOverride?: { agent: string; model: string }
): { agent: string; model: string } {
  // 1. Interactive override
  if (interactiveOverride) {
    validateAgentAndModel(interactiveOverride.agent, interactiveOverride.model, config.registry);
    return interactiveOverride;
  }

  // 2. Global CLI overrides
  if (globalOverrides.agent || globalOverrides.model) {
    const resolvedAgent = globalOverrides.agent || config.registry.defaults.agent;
    let resolvedModel = globalOverrides.model;
    if (!resolvedModel) {
      resolvedModel = config.registry.providers[resolvedAgent]?.[0] || config.registry.defaults.model;
    }
    validateAgentAndModel(resolvedAgent, resolvedModel, config.registry);
    return { agent: resolvedAgent, model: resolvedModel };
  }

  // 3. Manifest default
  const skill = config.manifest.skills[skillId];
  if (skill) {
    const agent = skill.agent;
    const model = skill.model;
    validateAgentAndModel(agent, model, config.registry);
    return { agent, model };
  }

  throw new Error(`Skill '${skillId}' not found in manifest, and no overrides provided.`);
}
