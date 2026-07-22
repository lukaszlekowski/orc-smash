import type { V1Manifest } from './manifest.js';

// ---- F7: Operator menu types and builders ----

export interface TopMenuAction {
  id: string;
  label: string;
  group: 'start-loop' | 'change-loop' | 'run-task' | 'display-status' | 'stop';
  disabledReason?: string;
}

export interface LoopSubmenuItem {
  id: 'continue-current-loop' | 'start-fresh-loop' | 'run-second-opinion' | 'back';
  label: string;
  disabledReason?: string;
  recommended: boolean;
}

export interface PipelineLaunchContext {
  pipelineId: string;
  stageId: string;
  label: string;
}

/**
 * Build the top-level interactive menu from the manifest. Every action stays
 * visible; unavailable ones carry a concrete disabledReason.
 * @param missingInputs per-binding missing project files (keyed by binding id)
 */
export function buildTopLevelMenu(
  manifest: V1Manifest,
  missingInputs?: Map<string, string[]>,
): TopMenuAction[] {
  const hasLoops = Object.keys(manifest.loops).length > 0;
  const hasTasks = Object.keys(manifest.tasks ?? {}).length > 0;

  const actions: TopMenuAction[] = [];

  actions.push({
    id: 'start-loop',
    label: 'Start loop',
    group: 'start-loop',
    disabledReason: hasLoops ? undefined : 'No loops configured in manifest',
  });

  if (hasTasks) {
    for (const taskId of Object.keys(manifest.tasks!)) {
      const taskMissing = missingInputs?.get(taskId);
      actions.push({
        id: `task:${taskId}`,
        label: `Execute one-off task: ${taskId}`,
        group: 'run-task',
        disabledReason: taskMissing && taskMissing.length > 0
          ? `Missing project input${taskMissing.length > 1 ? 's' : ''}: ${taskMissing.join(', ')}`
          : undefined,
      });
    }
  } else {
    actions.push({
      id: 'run-task',
      label: 'Execute one-off task',
      group: 'run-task',
      disabledReason: 'No tasks configured in manifest',
    });
  }

  actions.push({
    id: 'change-loop',
    label: 'Change loop',
    group: 'change-loop',
    disabledReason: hasLoops ? undefined : 'No loops configured in manifest',
  });

  actions.push({
    id: 'display-status',
    label: 'Display pipeline and project state',
    group: 'display-status',
  });

  actions.push({
    id: 'stop',
    label: 'Stop for manual review',
    group: 'stop',
  });

  return actions;
}

/**
 * Build the loop submenu actions for a given loop binding.
 * Every action remains visible; unavailable ones carry a concrete reason.
 * @param loopMissingInputs project files that are missing for this binding
 * @param continueDetail optional next-step info to enrich the Continue label
 */
export function buildLoopSubmenu(
  loopName: string,
  hasInProgressChain: boolean,
  hasSecondOpinionTarget: boolean,
  loopMissingInputs?: string[],
  continueDetail?: { phase: string; version: number; skillId: string; agent: string; model: string; effort?: string; sessionStrategy?: string },
): LoopSubmenuItem[] {
  const freshDisabledReason = loopMissingInputs && loopMissingInputs.length > 0
    ? `Missing project input${loopMissingInputs.length > 1 ? 's' : ''}: ${loopMissingInputs.join(', ')}`
    : undefined;

  const continueLabel = continueDetail
    ? `Continue current ${loopName} loop (next: ${continueDetail.skillId} ${continueDetail.phase} v${continueDetail.version}, ${continueDetail.agent}/${continueDetail.model}${continueDetail.effort ? `/${continueDetail.effort}` : ''}${continueDetail.sessionStrategy ? `, ${continueDetail.sessionStrategy}` : ''})`
    : `Continue current ${loopName} loop`;

  return [
    {
      id: 'continue-current-loop',
      label: continueLabel,
      disabledReason: hasInProgressChain && (!loopMissingInputs || loopMissingInputs.length === 0)
        ? undefined
        : (hasInProgressChain ? freshDisabledReason : 'No in-progress loop to continue'),
      recommended: hasInProgressChain && (!loopMissingInputs || loopMissingInputs.length === 0),
    },
    {
      id: 'start-fresh-loop',
      label: `Start fresh ${loopName} loop`,
      disabledReason: freshDisabledReason,
      recommended: !hasInProgressChain && (!loopMissingInputs || loopMissingInputs.length === 0),
    },
    {
      id: 'run-second-opinion',
      label: `Run second opinion for ${loopName}`,
      disabledReason: hasSecondOpinionTarget ? undefined : 'No completed loop to review',
      recommended: false,
    },
    {
      id: 'back',
      label: 'Back to main menu',
      recommended: false,
    },
  ];
}

/**
 * Determine if a binding is a first-stage reference in any configured pipeline.
 * Returns all the pipeline launch contexts where the binding is stage 0.
 */
export function pipelineLaunchContexts(
  manifest: V1Manifest,
  bindingId: string,
  kind: 'loop' | 'task',
): PipelineLaunchContext[] {
  const contexts: PipelineLaunchContext[] = [];
  for (const [pipelineId, pipeline] of Object.entries(manifest.pipelines ?? {})) {
    const firstStage = pipeline.stages[0];
    if (!firstStage) continue;
    const isFirst = (kind === 'loop' && firstStage.loop === bindingId)
      || (kind === 'task' && firstStage.task === bindingId);
    if (isFirst) {
      contexts.push({
        pipelineId,
        stageId: firstStage.stageId,
        label: `Pipeline: ${pipelineId} (stage: ${firstStage.stageId})`,
      });
    }
  }
  return contexts;
}
