import type { V1Manifest } from './manifest.js';
import type { AvailabilityState } from './terminal-accent.js';

// ---- F9: Candidate types ----

export interface SuggestedStageAction {
  pipelineId: string;
  pipelineRunId: string;
  successorStageId: string;
  predecessorStageId: string;
  predecessorArtifactIdentity: string;
  label: string;
}

// ---- F7: Operator menu types and builders ----

export interface TopMenuAction {
  id: string;
  label: string;
  group: 'start-loop' | 'change-loop' | 'run-task' | 'start-suggested-stage' | 'display-status' | 'stop';
  disabledReason?: string;
  availability: AvailabilityState;
}

export interface LoopSubmenuItem {
  id: 'continue-current-loop' | 'start-fresh-loop' | 'run-second-opinion' | 'back';
  label: string;
  disabledReason?: string;
  availability: AvailabilityState;
  recommended: boolean;
}

export interface TaskMenuItem {
  taskId: string;
  skillId: string;
  role: string;
  label: string;
  disabledReason?: string;
  availability: AvailabilityState;
}

export interface PipelineLaunchContext {
  pipelineId: string;
  stageId: string;
  label: string;
}

/**
 * Build the top-level interactive menu from the manifest. Every action stays
 * visible; unavailable ones carry a concrete disabledReason.
 */
export function buildTopLevelMenu(
  manifest: V1Manifest,
  hasEligibleCandidates?: boolean,
): TopMenuAction[] {
  const hasLoops = Object.keys(manifest.loops ?? {}).length > 0;
  const hasTasks = Object.keys(manifest.tasks ?? {}).length > 0;

  const actions: TopMenuAction[] = [];

  actions.push({
    id: 'start-loop',
    label: 'Start loop',
    group: 'start-loop',
    disabledReason: hasLoops ? undefined : 'no loops configured in manifest',
    availability: hasLoops ? 'available' : 'unavailable',
  });

  actions.push({
    id: 'run-task',
    label: 'Execute one-off task',
    group: 'run-task',
    disabledReason: hasTasks ? undefined : 'no tasks configured in manifest',
    availability: hasTasks ? 'available' : 'unavailable',
  });

  actions.push({
    id: 'change-loop',
    label: 'Change loop',
    group: 'change-loop',
    disabledReason: hasLoops ? undefined : 'no loops configured in manifest',
    availability: hasLoops ? 'available' : 'unavailable',
  });

  actions.push({
    id: 'start-suggested-stage',
    label: 'Start suggested stage',
    group: 'start-suggested-stage',
    disabledReason: hasEligibleCandidates ? undefined : 'no eligible pipeline stage candidates',
    availability: hasEligibleCandidates ? 'available' : 'unavailable',
  });

  actions.push({
    id: 'display-status',
    label: 'Display pipeline and project state',
    group: 'display-status',
    availability: 'available',
  });

  actions.push({
    id: 'stop',
    label: 'Stop for manual review',
    group: 'stop',
    availability: 'available',
  });

  return actions;
}

/**
 * Build the task menu items for configured tasks.
 */
export function buildTaskMenu(
  manifest: V1Manifest,
  missingInputs?: Map<string, string[]>,
): TaskMenuItem[] {
  const items: TaskMenuItem[] = [];
  for (const [taskId, taskSpec] of Object.entries(manifest.tasks ?? {})) {
    const missing = missingInputs?.get(taskId);
    const skillDef = manifest.skills[taskSpec.skill];
    const role = skillDef?.role ?? 'unknown';
    const isMissing = Boolean(missing && missing.length > 0);
    items.push({
      taskId,
      skillId: taskSpec.skill,
      role,
      label: `${taskId} — ${taskSpec.skill} · ${role}`,
      disabledReason: isMissing
        ? `Missing project input${missing!.length > 1 ? 's' : ''}: ${missing!.join(', ')}`
        : undefined,
      availability: isMissing ? 'missing-inputs' : 'available',
    });
  }
  return items;
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
  const isMissing = Boolean(loopMissingInputs && loopMissingInputs.length > 0);
  const freshDisabledReason = isMissing
    ? `Missing project input${loopMissingInputs!.length > 1 ? 's' : ''}: ${loopMissingInputs!.join(', ')}`
    : undefined;

  const continueLabel = continueDetail
    ? `Continue current ${loopName} loop (next: ${continueDetail.skillId} ${continueDetail.phase} v${continueDetail.version}, ${continueDetail.agent}/${continueDetail.model}${continueDetail.effort ? `/${continueDetail.effort}` : ''}${continueDetail.sessionStrategy ? `, ${continueDetail.sessionStrategy}` : ''})`
    : `Continue current ${loopName} loop`;

  const continueDisabled = hasInProgressChain
    ? freshDisabledReason
    : 'no in-progress loop to continue';
  const continueAvailability: AvailabilityState = hasInProgressChain
    ? (isMissing ? 'missing-inputs' : 'available')
    : 'unavailable';

  return [
    {
      id: 'continue-current-loop',
      label: continueLabel,
      disabledReason: continueDisabled,
      availability: continueAvailability,
      recommended: hasInProgressChain && !isMissing,
    },
    {
      id: 'start-fresh-loop',
      label: `Start fresh ${loopName} loop`,
      disabledReason: freshDisabledReason,
      availability: isMissing ? 'missing-inputs' : 'available',
      recommended: !hasInProgressChain && !isMissing,
    },
    {
      id: 'run-second-opinion',
      label: `Run second opinion for ${loopName}`,
      disabledReason: hasSecondOpinionTarget ? undefined : 'no completed loop to review',
      availability: hasSecondOpinionTarget ? 'available' : 'unavailable',
      recommended: false,
    },
    {
      id: 'back',
      label: 'Back to main menu',
      availability: 'available',
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
