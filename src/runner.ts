import type { Config, ModelRegistry } from './config.js';

/**
 * opencode's own model-id contract: `opencode run -m` requires the form
 * `provider/model` (verified via `opencode run --help`). The `provider/`
 * segment is opencode's transport/endpoint namespace (e.g. `opencode-go`),
 * owned by opencode — orc-smash treats the whole string as opaque and
 * validates only that it has exactly one `provider/model` slash.
 */
const OPENCODE_MODEL_ID = /^[A-Za-z0-9.-]+\/[A-Za-z0-9._-]+$/;

export function isOpencodeModelId(model: string): boolean {
  return OPENCODE_MODEL_ID.test(model);
}

export function isValidModelForAgent(agent: string, model: string, registry: ModelRegistry): boolean {
  const allowedModels = registry.providers[agent];
  if (!allowedModels) {
    return false;
  }
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
  interactiveOverride?: { agent: string; model: string }
): { agent: string; model: string } {
  // 1. Interactive override
  if (interactiveOverride) {
    validateAgentAndModel(interactiveOverride.agent, interactiveOverride.model, config.registry);
    return {
      agent: interactiveOverride.agent,
      model: normalizeModelForAgent(interactiveOverride.agent, interactiveOverride.model)
    };
  }

  // 2. Global CLI overrides
  if (globalOverrides.agent || globalOverrides.model) {
    const resolvedAgent = globalOverrides.agent || config.registry.defaults.agent;
    let resolvedModel = globalOverrides.model;
    if (!resolvedModel) {
      resolvedModel = config.registry.providers[resolvedAgent]?.[0] || config.registry.defaults.model;
    }
    validateAgentAndModel(resolvedAgent, resolvedModel, config.registry);
    return { agent: resolvedAgent, model: normalizeModelForAgent(resolvedAgent, resolvedModel) };
  }

  // 3. Manifest default
  const skill = config.manifest.skills[skillId];
  if (skill) {
    const agent = skill.agent;
    const model = skill.model;
    validateAgentAndModel(agent, model, config.registry);
    return { agent, model: normalizeModelForAgent(agent, model) };
  }

  throw new Error(`Skill '${skillId}' not found in manifest, and no overrides provided.`);
}
