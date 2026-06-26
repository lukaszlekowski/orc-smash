import type { Config } from './config.js';

export function isValidModelForAgent(agent: string, model: string): boolean {
  if (agent === 'opencode') {
    return model.startsWith('opencode/');
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

export function validateAgentAndModel(agent: string, model: string): void {
  const allowedAgents = ['opencode', 'codex', 'claude', 'fake'];
  if (!allowedAgents.includes(agent)) {
    throw new Error(`unknown agent '${agent}'; expected opencode | codex | claude | fake`);
  }
  if (!isValidModelForAgent(agent, model)) {
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
    validateAgentAndModel(interactiveOverride.agent, interactiveOverride.model);
    return interactiveOverride;
  }

  // 2. Global CLI overrides
  if (globalOverrides.agent || globalOverrides.model) {
    const resolvedAgent = globalOverrides.agent || config.defaultAgent;
    let resolvedModel = globalOverrides.model;
    if (!resolvedModel) {
      resolvedModel = config.agentDefaultModels[resolvedAgent] || config.defaultModel;
    }
    validateAgentAndModel(resolvedAgent, resolvedModel);
    return { agent: resolvedAgent, model: resolvedModel };
  }

  // 3. Manifest default
  const skill = config.manifest.skills[skillId];
  if (skill) {
    const agent = skill.agent;
    const model = skill.model;
    validateAgentAndModel(agent, model);
    return { agent, model };
  }

  // 4. .env fallback
  const agent = config.defaultAgent;
  const model = config.agentDefaultModels[agent] || config.defaultModel;
  validateAgentAndModel(agent, model);
  return { agent, model };
}
