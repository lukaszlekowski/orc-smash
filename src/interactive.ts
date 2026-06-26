import { select, input, confirm } from '@inquirer/prompts';
import type { Config } from './config.js';

export async function promptLoopSelect(loops: string[], defaultLoop: string): Promise<string> {
  return select({
    message: 'Select a loop to run:',
    choices: loops.map(l => ({ name: l, value: l })),
    default: defaultLoop
  });
}

export async function promptStartPoint(allowedStartPoints: string[], defaultStartPoint: string): Promise<string> {
  return select({
    message: 'Select a start point:',
    choices: allowedStartPoints.map(sp => ({ name: sp, value: sp })),
    default: defaultStartPoint
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
  globalOverrides: { agent?: string; model?: string } = {}
): Promise<Record<string, { agent: string; model: string }>> {
  const runners: Record<string, { agent: string; model: string }> = {};

  const customize = await confirm({
    message: 'Would you like to customize skill runners?',
    default: false
  });

  for (const skillId of skills) {
    const skill = config.manifest.skills[skillId];
    if (!skill) continue;

    // Use precedence logic to determine default agent/model
    let defaultAgent = skill.agent;
    let defaultModel = skill.model;

    if (globalOverrides.agent) {
      defaultAgent = globalOverrides.agent;
      defaultModel = globalOverrides.model || config.agentDefaultModels[defaultAgent] || config.defaultModel;
    }

    if (!customize) {
      runners[skillId] = { agent: defaultAgent, model: defaultModel };
      continue;
    }

    const agent = await select({
      message: `Select agent for skill '${skillId}':`,
      choices: [
        { name: 'opencode', value: 'opencode' },
        { name: 'codex', value: 'codex' },
        { name: 'claude', value: 'claude' }
      ],
      default: defaultAgent
    });

    const defaultModelForSelectedAgent = config.agentDefaultModels[agent] || config.defaultModel;

    const model = await input({
      message: `Enter model for agent '${agent}' (skill '${skillId}'):`,
      default: defaultModelForSelectedAgent
    });

    runners[skillId] = { agent, model };
  }

  return runners;
}

export async function promptSecondOpinionDecision(): Promise<'stop' | 'run-second-opinion'> {
  return select({
    message: 'Audit is APPROVED! What would you like to do?',
    choices: [
      { name: 'Stop and await manual review', value: 'stop' },
      { name: 'Run second opinion (with a different agent)', value: 'run-second-opinion' }
    ],
    default: 'stop'
  });
}

export async function promptSecondOpinionRunner(
  currentAgent: string,
  config: Config
): Promise<{ agent: string; model: string }> {
  // Recommend a different agent
  const recommendedAgent = currentAgent === 'opencode' ? 'codex' : 'opencode';
  const recommendedModel = config.agentDefaultModels[recommendedAgent] || config.defaultModel;

  const customize = await confirm({
    message: `Configure second opinion runner? (Recommended: ${recommendedAgent} using ${recommendedModel})`,
    default: false
  });

  if (!customize) {
    return { agent: recommendedAgent, model: recommendedModel };
  }

  const agent = await select({
    message: 'Select agent for second opinion:',
    choices: [
      { name: 'opencode', value: 'opencode' },
      { name: 'codex', value: 'codex' },
      { name: 'claude', value: 'claude' }
    ],
    default: recommendedAgent
  });

  const defaultModelForSelectedAgent = config.agentDefaultModels[agent] || config.defaultModel;

  const model = await input({
    message: `Enter model for agent '${agent}':`,
    default: defaultModelForSelectedAgent
  });

  return { agent, model };
}
