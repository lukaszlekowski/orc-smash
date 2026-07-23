import { select, input, confirm } from '@inquirer/prompts';
import type { Config } from './config.js';
import { isValidModelForAgent, resolveRunner } from './runner.js';
import type { AgentRegistry } from './adapters/registry.js';
import type { TopMenuAction, LoopSubmenuItem, TaskMenuItem, PipelineLaunchContext, SuggestedStageAction } from './stage-menu.js';

import { availabilityAccent, emphasisAccent, type AvailabilityState } from './terminal-accent.js';

export function formatMenuChoice<T extends { label: string; disabledReason?: string; recommended?: boolean; availability?: AvailabilityState }>(
  item: T,
  value: string,
): { name: string; value: string; disabled: boolean } {
  const isRecommended = Boolean(item.recommended && !item.disabledReason);
  let baseLabel = item.label;
  if (isRecommended) {
    baseLabel += ` ${emphasisAccent('recommended')('(recommended)')}`;
  }
  if (item.disabledReason) {
    baseLabel += ` (unavailable: ${item.disabledReason})`;
  }

  const avail = item.availability ?? (item.disabledReason ? 'unavailable' : 'available');
  const name = availabilityAccent(avail)(baseLabel);

  return {
    name,
    value,
    disabled: Boolean(item.disabledReason),
  };
}

export async function promptLoopSelect(loops: string[], defaultLoop: string): Promise<string> {
  return select({
    message: 'Select a loop to run:',
    choices: loops.map(l => ({ name: l, value: l })),
    default: defaultLoop
  });
}

// ---- F7: Operator menu prompts ----

/**
 * Show the top-level interactive menu. Every action visible; disabled ones show
 * their reason. Returns the selected action id.
 */
export async function promptTopLevelMenu(actions: TopMenuAction[]): Promise<string> {
  return select({
    message: 'What would you like to do?',
    choices: actions.map(a => formatMenuChoice(a, a.id)),
  });
}

/**
 * Show the loop submenu (Continue / Fresh / Second opinion / Back).
 * Returns the submenu item id.
 */
export async function promptLoopSubmenu(items: LoopSubmenuItem[]): Promise<string> {
  const recommended = items.find(i => i.recommended && !i.disabledReason);
  return select({
    message: 'What would you like to do?',
    choices: items.map(i => formatMenuChoice(i, i.id)),
    default: recommended?.id ?? items.find(i => !i.disabledReason)?.id ?? items[0]!.id,
  });
}

/**
 * Show the generic task menu (list of configured tasks + Back).
 */
export async function promptTaskMenu(tasks: TaskMenuItem[]): Promise<string> {
  const choices = tasks.map(t => formatMenuChoice(t, t.taskId));
  choices.push({ name: 'Back to main menu', value: 'back', disabled: false });
  return select({
    message: 'Select a task to run:',
    choices,
  });
}

export interface TaskDetailView {
  taskId: string;
  skillId: string;
  role: string;
  skillPath: string;
  targetPath: string;
  outputPattern: string;
  contract: string;
  missingInputs?: string[];
}

/**
 * Show task details and prompt for confirmation (Run task / Back).
 */
export async function promptTaskDetailConfirmation(detail: TaskDetailView): Promise<'run' | 'back'> {
  console.log(`\n${emphasisAccent('identity')(`Task Details: ${detail.taskId}`)}`);
  console.log(`  ${emphasisAccent('supporting')(`Bound skill:  ${detail.skillId} (${detail.skillPath})`)}`);
  console.log(`  ${emphasisAccent('supporting')(`Role:         ${detail.role}`)}`);
  console.log(`  ${emphasisAccent('supporting')(`Target:       ${detail.targetPath}`)}`);
  console.log(`  ${emphasisAccent('supporting')(`Output:       ${detail.outputPattern} (${detail.contract})`)}`);
  if (detail.missingInputs && detail.missingInputs.length > 0) {
    console.log(`  ${availabilityAccent('missing-inputs')(`Missing:      ${detail.missingInputs.join(', ')}`)}`);
  }
  console.log('');

  const choices = [
    { name: 'Run task', value: 'run', disabled: Boolean(detail.missingInputs && detail.missingInputs.length > 0) },
    { name: 'Back to task menu', value: 'back', disabled: false },
  ];

  return select({
    message: `Confirm execution of task '${detail.taskId}':`,
    choices,
  }) as Promise<'run' | 'back'>;
}

/**
 * Prompt for acknowledgement after displaying persistent project/pipeline state.
 */
export async function promptStatusAcknowledgement(): Promise<void> {
  await select({
    message: 'Press Enter to return to main menu',
    choices: [{ name: 'Back to main menu', value: 'back' }],
  });
}

/**
 * Prompt the user to choose between an ad-hoc start or a specific pipeline
 * launch context when the selected binding is a first-stage reference.
 * Returns 'ad-hoc' for ad-hoc, or the selected PipelineLaunchContext.
 * If only one context exists, offers a simple choice.
 */
export async function promptPipelineLaunchContext(
  bindingId: string,
  contexts: PipelineLaunchContext[],
): Promise<{ kind: 'ad-hoc' } | { kind: 'pipeline'; pipelineId: string; stageId: string }> {
  if (contexts.length === 0) return { kind: 'ad-hoc' };

  const choices: Array<{ name: string; value: string }> = [
    { name: 'Start ad hoc (no pipeline identity)', value: 'ad-hoc' },
    ...contexts.map(ctx => ({ name: ctx.label, value: `pipeline:${ctx.pipelineId}:${ctx.stageId}` })),
  ];

  const selected = await select({
    message: `'${bindingId}' is the first stage in one or more pipelines. How would you like to launch?`,
    choices,
    default: 'ad-hoc',
  });

  if (selected === 'ad-hoc') return { kind: 'ad-hoc' };
  const [, pipelineId, stageId] = selected.split(':');
  return { kind: 'pipeline', pipelineId: pipelineId!, stageId: stageId! };
}

/**
 * Build the custom-model validation message for an agent. agy surfaces its
 * strict configured allow-list (the exact `providers.agy` names) rather than a
 * generic "not a valid model" string, so operators learn the rule that rejects
 * namespace-style ids like gpt-5.5 / opencode/... / claude-...
 */
function invalidModelMessage(agent: string, val: string, registry: Config['registry']): string {
  const catalogue = registry.providers[agent];
  if (catalogue) {
    const example = catalogue.models[0] ?? 'default';
    return `model '${val}' is not a valid model for agent '${agent}' (e.g. ${example})`;
  }
  return `model '${val}' is not a valid model for agent '${agent}'`;
}

export async function promptMaxIterations(defaultVal: number): Promise<number> {
  const result = await input({
    message: 'Enter maximum evaluation rounds:',
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
  globalOverrides: { agent?: string; model?: string; effort?: string; sessionStrategy?: string } = {},
  opts?: { forceSelect?: boolean }
): Promise<Record<string, { agent: string; model: string; effort?: string; sessionStrategy?: string }>> {
  const runners: Record<string, { agent: string; model: string; effort?: string; sessionStrategy?: string }> = {};
  const defaultRunners = new Map<string, { agent: string; model: string; effort?: string; sessionStrategy?: string }>();

  for (const skillId of skills) {
    if (config.manifest.skills[skillId]) {
      defaultRunners.set(skillId, resolveRunner(skillId, config, globalOverrides));
    }
  }

  const selectableAgents = [...agentRegistry.adapters.keys()]
    .filter((agent) => agent in config.registry.providers);

  // Show the exact resolved provider/model pairs before offering to customize
  // them. These include any CLI override, so accepting the default is never a
  // blind choice.
  if (!opts?.forceSelect && defaultRunners.size > 0) {
    console.log(emphasisAccent('identity')('Default skill runners:'));
    for (const [skillId, runner] of defaultRunners) {
      const parts = [`${skillId}: ${runner.agent} (${runner.model})`];
      parts.push(`effort: ${runner.effort ?? 'provider default'}`);
      parts.push(`session: ${runner.sessionStrategy ?? 'fresh-per-invocation'}`);
      console.log(`  ${emphasisAccent('supporting')(parts.join(', '))}`);
    }
  }

  // forceSelect skips the yes/no gate so callers that always want a model list
  // (e.g. the implement dispatch) bypass the default-and-silently-use path.
  const customize = opts?.forceSelect || await confirm({
    message: 'Would you like to customize skill runners?',
    default: false
  });

  for (const skillId of skills) {
    const skill = config.manifest.skills[skillId];
    if (!skill) continue;

    const resolved = defaultRunners.get(skillId)!;
    let defaultAgent = resolved.agent;
    let defaultModel = resolved.model;

    if (!customize) {
      runners[skillId] = {
        agent: defaultAgent,
        model: defaultModel,
        ...(resolved.effort ? { effort: resolved.effort } : {}),
        ...(resolved.sessionStrategy ? { sessionStrategy: resolved.sessionStrategy } : {}),
      };
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

    const adapter = agentRegistry.adapters.get(agent);
    const catalogue = config.registry.providers[agent];
    const isCustomModel = catalogue ? !catalogue.models.includes(selectedModel) : true;
    const effortLevels = isCustomModel
      ? []
      : (catalogue?.modelEfforts?.[selectedModel] ?? catalogue?.efforts ?? []);
    let selectedEffort: string | undefined;
    const effortChoices = [
      formatMenuChoice({ label: 'Provider default' }, 'default'),
    ];
    if (adapter && !adapter.capabilities.effort) {
      effortChoices.push(
        formatMenuChoice({ label: 'Configure effort', disabledReason: `${agent} does not support effort`, availability: 'unavailable' }, 'unsupported-effort')
      );
    } else if (effortLevels.length > 0) {
      for (const level of effortLevels) {
        effortChoices.push(formatMenuChoice({ label: level }, level));
      }
    } else {
      effortChoices.push(
        formatMenuChoice({ label: 'Configure effort', disabledReason: `no effort levels for model '${selectedModel}'`, availability: 'unavailable' }, 'unsupported-effort')
      );
    }
    const pickedEffort = await select({
      message: `Select effort for agent '${agent}' (skill '${skillId}'):`,
      choices: effortChoices,
      default: 'default',
    });
    if (pickedEffort !== 'default' && pickedEffort !== 'unsupported-effort') {
      selectedEffort = pickedEffort;
    }

    let selectedSessionStrategy: string | undefined;
    const sessionChoices = [
      formatMenuChoice({ label: 'Fresh per invocation (no session reuse)' }, 'fresh-per-invocation'),
    ];
    if (adapter && !adapter.capabilities.resumeSession) {
      sessionChoices.push(
        formatMenuChoice({ label: 'Resume per skill (reuse last session)', disabledReason: `${agent} does not support session resumption`, availability: 'unavailable' }, 'unsupported-resume')
      );
    } else if (adapter?.capabilities.resumeSession) {
      sessionChoices.push(
        formatMenuChoice({ label: 'Resume per skill (reuse last session)' }, 'resume-per-skill')
      );
    }
    const pickedSession = await select({
      message: `Select session strategy for agent '${agent}' (skill '${skillId}'):`,
      choices: sessionChoices,
      default: 'fresh-per-invocation',
    });
    if (pickedSession !== 'fresh-per-invocation' && pickedSession !== 'unsupported-resume') {
      selectedSessionStrategy = pickedSession;
    }

    runners[skillId] = {
      agent,
      model: selectedModel,
      ...(selectedEffort ? { effort: selectedEffort } : {}),
      ...(selectedSessionStrategy ? { sessionStrategy: selectedSessionStrategy } : {}),
    };
  }

  return runners;
}

// ---- F9: Suggested-stage prompts ----

export async function promptCandidateSelection(
  candidates: SuggestedStageAction[],
): Promise<SuggestedStageAction | null> {
  if (candidates.length === 0) return null;
  const choices = candidates.map(c => {
    const key = `${c.pipelineId}:${c.pipelineRunId}:${c.successorStageId}:${c.predecessorArtifactIdentity}`;
    return { name: c.label, value: key };
  });
  choices.push({ name: 'Cancel (Go back)', value: 'cancel' });

  const picked = await select({
    message: 'Select a pipeline stage to advance:',
    choices,
  });
  if (picked === 'cancel') return null;
  return candidates.find(c => {
    const key = `${c.pipelineId}:${c.pipelineRunId}:${c.successorStageId}:${c.predecessorArtifactIdentity}`;
    return key === picked;
  }) ?? null;
}

// ---- F10: Extension menu prompts ----

export type ExtensionChoice = 'extend-3' | 'extend-5' | 'custom' | 'return';

export async function promptIterationExtension(
  currentBudget: number,
  roundsUsed: number,
  providerCalls: number,
): Promise<ExtensionChoice> {
  const result = await select({
    message: `Iteration budget exhausted: Round ${roundsUsed}/${currentBudget} - provider calls ${providerCalls}. What would you like to do?`,
    choices: [
      { name: `Extend budget by 3 (new total: ${currentBudget + 3})`, value: 'extend-3' },
      { name: `Extend budget by 5 (new total: ${currentBudget + 5})`, value: 'extend-5' },
      { name: 'Set custom budget…', value: 'custom' },
      { name: 'Return to menu (keep retry artifact for later)', value: 'return' },
    ],
  });
  if (result === 'custom') {
    const customVal = await input({
      message: 'Enter new maximum iteration count:',
      validate: (val: string) => {
        const n = parseInt(val, 10);
        if (isNaN(n) || n <= currentBudget) return `Must be greater than ${currentBudget}`;
        return true;
      },
    });
    const n = parseInt(customVal, 10);
    return `extend-${n - currentBudget}` as ExtensionChoice;
  }
  return result as ExtensionChoice;
}

export async function promptPostRunRecovery(): Promise<'menu' | 'exit'> {
  return select({
    message: 'Run finished. What would you like to do next?',
    choices: [
      { name: 'Return to selection menu', value: 'menu' },
      { name: 'Exit', value: 'exit' },
    ],
    default: 'menu'
  });
}
