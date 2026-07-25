import { select, input } from '@inquirer/prompts';
import type { Config } from './config.js';
import { isValidEffortForModel, isValidModelForAgent, resolveRunner, type ResolvedRunner } from './runner.js';
import type { AgentRegistry } from './adapters/registry.js';
import type { TopMenuAction, LoopSubmenuItem, TaskMenuItem, PipelineLaunchContext, SuggestedStageAction } from './stage-menu.js';
import type { Step } from './state.js';
import { resolveContinuity, type ResumeRecord, type RunnerPreselection } from './continuation-runners.js';

import { availabilityAccent, emphasisAccent, type AvailabilityState } from './terminal-accent.js';

export function formatMenuChoice<T extends { label: string; disabledReason?: string; recommended?: boolean; availability?: AvailabilityState }>(
  item: T,
  value: string,
): { name: string; value: string; disabled: boolean } {
  const isRecommended = Boolean(item.recommended && !item.disabledReason);
  let baseLabel = item.label;
  if (isRecommended) {
    baseLabel += ` ${emphasisAccent('recommended')('(recommended next action)')}`;
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

export interface PromptRunnersOptions {
  forceSelect?: boolean;
  preselections?: Map<string, RunnerPreselection>;
  continuitySteps?: Step[];
  continuationChainId?: string;
}

function sessionDisplay(sessionId: string): string {
  return `*${sessionId.slice(-6)}`;
}

function preselectionSourceLabel(source: RunnerPreselection['source']): string {
  return source === 'chain' ? 'chain metadata' : 'configured profile';
}

function historyForContinuity(steps: Step[] | undefined): ResumeRecord[] {
  return (steps ?? []).map(step => ({
    meta: {
      chainId: step.chainId,
      skill: step.skillId ?? step.role,
      sessionId: step.sessionId ?? 'none',
      agent: step.agent,
      model: step.model,
      effort: step.effort,
    },
    decision: step.decision,
    completion: step.completionOutcome,
  }));
}

function applyPredictedContinuity(
  runner: ResolvedRunner,
  skillId: string,
  config: Config,
  agentRegistry: AgentRegistry,
  globalOverrides: { sessionStrategy?: string },
  options: PromptRunnersOptions,
): { runner: ResolvedRunner; continuity: ReturnType<typeof resolveContinuity> } {
  const continuity = resolveContinuity(
    undefined,
    runner,
    agentRegistry,
    runner.sessionStrategy ?? globalOverrides.sessionStrategy ?? 'fresh-per-invocation',
    skillId,
    historyForContinuity(options.continuitySteps),
    options.continuationChainId ?? '',
  );
  const withSession = { ...runner };
  delete withSession.inheritedSession;
  if (continuity.mode === 'resumed' && continuity.sessionId) {
    withSession.inheritedSession = {
      agent: runner.agent,
      model: runner.model,
      sessionId: continuity.sessionId,
    };
  }
  return { runner: withSession, continuity };
}

function sourceLabel(runner: ResolvedRunner): string {
  if (runner.agentSource === 'interactive' || runner.modelSource === 'interactive' || runner.effortSource === 'interactive') {
    return 'operator selection';
  }
  if (runner.agentSource === 'session' || runner.modelSource === 'session' || runner.effortSource === 'session') {
    return 'chain metadata';
  }
  return 'configured profile';
}

function effortChoices(
  agent: string,
  model: string,
  config: Config,
  agentRegistry: AgentRegistry,
): Array<{ name: string; value: string; disabled?: boolean }> {
  const adapter = agentRegistry.adapters.get(agent);
  const catalogue = config.registry.providers[agent];
  const levels = catalogue?.modelEfforts?.[model] ?? catalogue?.efforts ?? [];
  const choices = [formatMenuChoice({ label: 'Provider default' }, 'default')];
  if (adapter && !adapter.capabilities.effort) {
    choices.push(formatMenuChoice({
      label: 'Configure effort',
      disabledReason: `${agent} does not support effort`,
      availability: 'unavailable',
    }, 'unsupported-effort'));
  } else if (levels.length > 0) {
    for (const level of levels) choices.push(formatMenuChoice({ label: level }, level));
  } else {
    choices.push(formatMenuChoice({
      label: 'Configure effort',
      disabledReason: `no effort levels configured for model '${model}'`,
      availability: 'unavailable',
    }, 'unsupported-effort'));
  }
  return choices;
}

function withEffort(
  runner: ResolvedRunner,
  effort: string | undefined,
): ResolvedRunner {
  const result = { ...runner };
  delete result.inheritedSession;
  delete result.effort;
  delete result.effortSource;
  if (effort) {
    result.effort = effort;
    result.effortSource = 'interactive';
  }
  return result;
}

export async function promptRunners(
  skills: string[],
  config: Config,
  agentRegistry: AgentRegistry,
  globalOverrides: { agent?: string; model?: string; effort?: string; sessionStrategy?: string } = {},
  opts: PromptRunnersOptions = {},
): Promise<Record<string, ResolvedRunner>> {
  const runners: Record<string, ResolvedRunner> = {};
  const defaultRunners = new Map<string, ResolvedRunner>();
  const defaultPreselections = new Map<string, RunnerPreselection>();

  for (const skillId of skills) {
    if (config.manifest.skills[skillId]) {
      const resolved = resolveRunner(skillId, config, globalOverrides);
      const derived = opts.preselections?.get(skillId) ?? {
        source: 'profile' as const,
        agent: resolved.agent,
        model: resolved.model,
        ...(resolved.effort ? { effort: resolved.effort } : {}),
        ...(resolved.sessionStrategy ? { sessionStrategy: resolved.sessionStrategy } : {}),
      };
      defaultPreselections.set(skillId, derived);

      let preselected = resolved;
      if (derived.source === 'chain') {
        preselected = {
          agent: derived.agent,
          model: derived.model,
          agentSource: 'session',
          modelSource: 'session',
          ...(derived.effort ? { effort: derived.effort, effortSource: 'session' as const } : {}),
          ...(derived.sessionStrategy ? { sessionStrategy: derived.sessionStrategy, sessionStrategySource: 'session' as const } : {}),
          ...(derived.sessionId ? {
            inheritedSession: { agent: derived.agent, model: derived.model, sessionId: derived.sessionId },
          } : {}),
        };
      }
      defaultRunners.set(skillId, preselected);
    }
  }

  const selectableAgents = [...agentRegistry.adapters.keys()]
    .filter((agent) => agent in config.registry.providers);

  // This is an editable preview. The post-selection summary below is the
  // committed source/continuity readout.
  if (defaultRunners.size > 0) {
    console.log(emphasisAccent('identity')('Runner defaults (editable before execution):'));
    console.log(emphasisAccent('supporting')('Runner selection happens before execution.'));
    for (const [skillId, runner] of defaultRunners) {
      const parts = [`${skillId}: ${runner.agent} (${runner.model})`];
      parts.push(`effort: ${runner.effort ?? 'provider default'}`);
      parts.push(`session: ${runner.sessionStrategy ?? 'fresh-per-invocation'}`);
      parts.push(`source: ${preselectionSourceLabel(defaultPreselections.get(skillId)!.source)}`);
      const preselection = defaultPreselections.get(skillId)!;
      if (preselection.sessionId) parts.push(`session ${sessionDisplay(preselection.sessionId)}`);
      if (preselection.fallbackReason) parts.push(`fallback: ${preselection.fallbackReason}`);
      if (preselection.note) parts.push(`note: ${preselection.note}`);
      console.log(`  ${emphasisAccent('supporting')(parts.join(', '))}`);
    }
  }

  for (const skillId of skills) {
    const skill = config.manifest.skills[skillId];
    if (!skill) continue;

    const resolved = defaultRunners.get(skillId)!;
    const preselection = defaultPreselections.get(skillId)!;
    let defaultAgent = resolved.agent;
    let defaultModel = resolved.model;

    let selection: string = 'customize';
    if (!opts.forceSelect) {
      const sessionText = preselection.sessionId
        ? ` (resumes session ${sessionDisplay(preselection.sessionId)})`
        : '';
      const firstLabel = preselection.source === 'chain'
        ? `Use chain runner${sessionText}`
        : `Use configured runner (configured profile${preselection.fallbackReason ? ` — no compatible chain runner: ${preselection.fallbackReason}` : ''})`;
      selection = await select({
        message: `Choose runner configuration for skill '${skillId}':`,
        choices: [
          formatMenuChoice({ label: firstLabel, recommended: true }, 'use-default'),
          formatMenuChoice({ label: 'Change effort only' }, 'effort-only'),
          formatMenuChoice({ label: 'Customize provider, model, effort, and session' }, 'customize'),
        ],
        default: 'use-default',
      });
    }

    if (selection === 'use-default') {
      const predicted = applyPredictedContinuity(resolved, skillId, config, agentRegistry, globalOverrides, opts);
      runners[skillId] = predicted.runner;
      continue;
    }

    if (selection === 'effort-only') {
      const levels = effortChoices(resolved.agent, resolved.model, config, agentRegistry);
      const currentEffort = resolved.effort ?? 'default';
      const pickedEffort = await select({
        message: `Select effort for agent '${resolved.agent}' (skill '${skillId}') — provider/model unchanged:`,
        choices: levels,
        default: currentEffort,
      });
      if (pickedEffort === 'unsupported-effort') {
        runners[skillId] = applyPredictedContinuity(resolved, skillId, config, agentRegistry, globalOverrides, opts).runner;
      } else {
        const selectedEffort = pickedEffort === 'default' ? undefined : pickedEffort;
        const modelIsListed = config.registry.providers[resolved.agent]?.models.includes(resolved.model) ?? false;
        if (selectedEffort && modelIsListed && !isValidEffortForModel(resolved.agent, resolved.model, selectedEffort, config.registry)) {
          throw new Error(`Invalid effort '${selectedEffort}' for model '${resolved.model}' (skill '${skillId}')`);
        }
        const selected = withEffort(resolved, selectedEffort);
        const predicted = applyPredictedContinuity(selected, skillId, config, agentRegistry, globalOverrides, opts);
        runners[skillId] = predicted.runner;
      }
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
    let selectedEffort: string | undefined;
    const selectedEffortChoices = effortChoices(agent, selectedModel, config, agentRegistry);
    const pickedEffort = await select({
      message: `Select effort for agent '${agent}' (skill '${skillId}'):`,
      choices: selectedEffortChoices,
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

    const interactiveResolved = resolveRunner(skillId, config, globalOverrides, {
      agent,
      model: selectedModel,
      ...(selectedEffort ? { effort: selectedEffort } : {}),
      ...(selectedSessionStrategy ? { sessionStrategy: selectedSessionStrategy } : {}),
    });
    // resolveRunner includes a provider default effort when configured. The
    // explicit Provider default menu choice must remove it structurally.
    if (!selectedEffort) {
      delete interactiveResolved.effort;
      delete interactiveResolved.effortSource;
    }
    const predicted = applyPredictedContinuity(interactiveResolved, skillId, config, agentRegistry, globalOverrides, opts);
    runners[skillId] = predicted.runner;
  }

  console.log(emphasisAccent('identity')('Resolved runner selections (before execution):'));
  for (const skillId of skills) {
    const runner = runners[skillId];
    if (!runner) continue;
    const preselection = defaultPreselections.get(skillId);
    const continuity = resolveContinuity(
      undefined,
      runner,
      agentRegistry,
      runner.sessionStrategy ?? globalOverrides.sessionStrategy ?? 'fresh-per-invocation',
      skillId,
      historyForContinuity(opts.continuitySteps),
      opts.continuationChainId ?? '',
    );
    const parts = [
      `${skillId} (${config.manifest.skills[skillId]?.role ?? 'unknown'}): ${runner.agent} · ${runner.model}`,
      runner.effort ? `effort: ${runner.effort}` : 'effort: provider default',
      `source: ${sourceLabel(runner)}`,
    ];
    if (runner.agentSource === 'session' && preselection?.fromStep) {
      parts.push(`from chain ${preselection.fromStep.phase} v${preselection.fromStep.version}`);
    }
    if (preselection?.fallbackReason) parts.push(`fallback: ${preselection.fallbackReason}`);
    if (preselection?.note) parts.push(`note: ${preselection.note}`);
    parts.push(`continuity: ${runner.sessionStrategy ?? 'fresh-per-invocation'}`);
    parts.push(continuity.mode === 'resumed'
      ? `resumes session ${sessionDisplay(continuity.sessionId!)}`
      : `fresh session (${continuity.freshReason ?? 'no-compatible-session'})`);
    console.log(`  ${emphasisAccent('supporting')(parts.join(', '))}`);
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
    message: 'Select a pipeline stage to advance (runner selection happens before execution):',
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
