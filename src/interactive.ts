import { select, input, confirm } from '@inquirer/prompts';
import type { Config } from './config.js';
import { isValidModelForAgent, resolveRunner } from './runner.js';
import type { AgentRegistry } from './adapters/registry.js';
import type { StageAction } from './stage-menu.js';

export async function promptLoopSelect(loops: string[], defaultLoop: string): Promise<string> {
  return select({
    message: 'Select a loop to run:',
    choices: loops.map(l => ({ name: l, value: l })),
    default: defaultLoop
  });
}

/**
 * Build the custom-model validation message for an agent. agy surfaces its
 * strict configured allow-list (the exact `providers.agy` names) rather than a
 * generic "not a valid model" string, so operators learn the rule that rejects
 * namespace-style ids like gpt-5.5 / opencode/... / claude-...
 */
function invalidModelMessage(agent: string, val: string, registry: Config['registry']): string {
  if (agent === 'opencode') {
    return `model '${val}' must be an opencode id in provider/model form (e.g. opencode-go/deepseek-v4-flash)`;
  }
  if (agent === 'agy') {
    const example = registry.providers.agy?.models[0] ?? 'Gemini 3.5 Flash (Medium)';
    return `model '${val}' is not a configured agy model; agy accepts only the exact names listed in providers.agy (e.g. ${example})`;
  }
  return `model '${val}' is not a valid model for agent '${agent}'`;
}

export async function promptStageAction(actions: StageAction[], recommendedId: string): Promise<string> {
  const choices = actions.map(act => {
    const isRec = act.id === recommendedId;
    return {
      name: isRec ? `${act.label} (recommended)` : act.label,
      value: act.id,
      disabled: act.disabledReason
    };
  });

  // Flat list, recommended first
  const recommendedIndex = choices.findIndex(c => c.value === recommendedId);
  if (recommendedIndex > 0) {
    const [recChoice] = choices.splice(recommendedIndex, 1);
    if (recChoice) {
      choices.unshift(recChoice);
    }
  }

  return select({
    message: 'What would you like to do next?',
    choices,
    default: recommendedId
  });
}

export async function promptMaxIterations(defaultVal: number): Promise<number> {
  const result = await input({
    message: 'Enter maximum audit iterations:',
    default: String(defaultVal),
    validate: (val) => {
      const parsed = parseInt(val, 10);
      if (isNaN(parsed) || parsed <= 0) {
        return 'Please enter a positive integer.';
      }
      return true;
    }
  });
  return parseInt(result, 10);
}

export async function promptRunners(
  skills: string[],
  config: Config,
  agentRegistry: AgentRegistry,
  globalOverrides: { agent?: string; model?: string } = {},
  opts?: { forceSelect?: boolean }
): Promise<Record<string, { agent: string; model: string }>> {
  const runners: Record<string, { agent: string; model: string }> = {};

  const selectableAgents = [...agentRegistry.adapters.keys()]
    .filter((agent) => agent in config.registry.providers);

  // forceSelect skips the yes/no gate so callers that always want a model list
  // (e.g. the implement dispatch) bypass the default-and-silently-use path.
  const customize = opts?.forceSelect || await confirm({
    message: 'Would you like to customize skill runners?',
    default: false
  });

  for (const skillId of skills) {
    const skill = config.manifest.skills[skillId];
    if (!skill) continue;

    const resolved = resolveRunner(skillId, config, globalOverrides);
    let defaultAgent = resolved.agent;
    let defaultModel = resolved.model;

    if (!customize) {
      runners[skillId] = { agent: defaultAgent, model: defaultModel };
      continue;
    }

    let promptDefaultAgent = defaultAgent;
    if (!selectableAgents.includes(promptDefaultAgent)) {
      const defaultProvider = config.registry.profiles[config.registry.defaultProfile]?.provider;
      if (defaultProvider && selectableAgents.includes(defaultProvider)) {
        promptDefaultAgent = defaultProvider;
      } else if (selectableAgents.length > 0) {
        promptDefaultAgent = selectableAgents[0]!;
      } else {
        throw new Error(`No selectable agents available for prompt setup`);
      }
    }

    const agent = await select({
      message: `Select agent for skill '${skillId}':`,
      choices: selectableAgents.map(a => ({ name: a, value: a })),
      default: promptDefaultAgent
    });

    const models = config.registry.providers[agent]?.models || [];
    const modelChoices = models.map(m => ({ name: m, value: m }));
    modelChoices.push({ name: 'Custom model…', value: 'custom' });

    let defaultModelSelection = defaultModel;
    if (!models.includes(defaultModelSelection)) {
      defaultModelSelection = config.registry.providers[agent]?.defaultModel ?? 'custom';
    }
    if (!models.includes(defaultModelSelection)) {
      defaultModelSelection = models[0] || 'custom';
    }

    let selectedModel = await select({
      message: `Select model for agent '${agent}' (skill '${skillId}'):`,
      choices: modelChoices,
      default: defaultModelSelection
    });

    if (selectedModel === 'custom') {
      selectedModel = (await input({
        message: `Enter custom model for agent '${agent}' (skill '${skillId}'):`,
        validate: (val) => {
          if (!isValidModelForAgent(agent, val, config.registry)) {
            return invalidModelMessage(agent, val, config.registry);
          }
          return true;
        }
      })).trim();
    }

    runners[skillId] = { agent, model: selectedModel };
  }

  return runners;
}
