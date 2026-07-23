import type { Config } from './config.js';
import type { GlobalSnapshot, Step } from './state.js';
import type { InterruptedMarker } from './interrupted-artifact.js';
import { pipelineStageCandidates, recoverInProgressRun, type Candidate } from './pipeline-state.js';
import { buildTargetSnapshots } from './next-step.js';
import { selectDefaultLoop } from './loop-selector.js';
import type { V1Manifest, ManifestDeclarationOrder } from './manifest.js';

export interface LatestStepSummary {
  step: Step;
  effortStr: string;
  sessionStrategyStr: string;
  sessionModeIdStr: string;
  sessionStr: string;
}

export interface BindingSnapshotView {
  bindingId: string;
  bindingKind: 'loop' | 'task';
  targetPath: string;
  latestEvaluate?: LatestStepSummary;
  latestRepair?: LatestStepSummary;
  latestTask?: LatestStepSummary;
  latestSteps: Step[];
  missingInputs: string[];
  unclassifiedCount: number;
  unclassifiedSteps: Step[];
}

export interface CandidateSnapshotView {
  pipelineId: string;
  pipelineRunId: string;
  predecessorStageId: string;
  successorStageId: string;
  completionArtifactPath: string;
  completionArtifactIdentity: string;
  decisionOrOutcome: string;
  resultFingerprint?: string;
  targetFingerprintNow?: string;
  stale: boolean;
  staleReason?: string;
}

export interface ConfiguredPipelineStageView {
  stageId: string;
  loopOrTask: string;
}

export interface ConfiguredPipelineView {
  pipelineId: string;
  stages: ConfiguredPipelineStageView[];
}

export interface PromptInputContractView {
  label: string;
  source: string;
  resolutionKind: 'target' | 'runtime' | 'configured-file';
  configuredKey?: string;
  configuredValue?: string;
  status: 'available' | 'missing' | 'runtime-resolved';
  note?: string;
}

export interface PromptStepContractView {
  phase: 'evaluate' | 'repair' | 'task';
  roleId: string;
  rolePath: string;
  skillId: string;
  skillPath: string;
  inputs: PromptInputContractView[];
  outputPattern: string;
  outputContract: string;
  decision?: {
    heading: string;
    accepted: string;
    retry: string;
  };
  validator?: string;
}

export interface BindingPromptContractView {
  bindingId: string;
  bindingKind: 'loop' | 'task';
  targetPath: string;
  targetKind: 'file' | 'worktree';
  targetStatus?: 'available' | 'missing' | 'runtime-resolved';
  composition: 'Role content -> Skill content -> ordered Inputs';
  steps: PromptStepContractView[];
}

export interface ProjectSnapshotView {
  projectRoot: string;
  configPath: string;
  scanTime: string;
  pipelines: string[];
  configuredPipelines: ConfiguredPipelineView[];
  suggestedLoop: string | null;
  suggestedLoopReason: string;
  bindings: BindingSnapshotView[];
  promptContracts: BindingPromptContractView[];
  eligibleCandidates: CandidateSnapshotView[];
  allCandidates: CandidateSnapshotView[];
  unclassifiedCount: number;
  unclassifiedSteps: Step[];
  interruptedMarker?: InterruptedMarker | null;
}

function summarizeStep(step: Step): LatestStepSummary {
  const effortStr = step.effort ?? 'provider default';
  const sessionStrategyStr = step.sessionStrategy ?? 'fresh-per-invocation';
  const sessionModeIdStr = step.sessionId
    ? `${step.sessionMode ?? 'fresh'} (${step.sessionId})`
    : (step.sessionMode ?? 'fresh');
  const sessionStr = `${sessionStrategyStr} / ${sessionModeIdStr}`;
  return {
    step,
    effortStr,
    sessionStrategyStr,
    sessionModeIdStr,
    sessionStr,
  };
}

export function buildBindingPromptContracts(
  manifest: V1Manifest,
  snapshot: GlobalSnapshot,
  declarationOrder?: ManifestDeclarationOrder,
): BindingPromptContractView[] {
  const result: BindingPromptContractView[] = [];

  const loopIds = declarationOrder?.loops ?? Object.keys(manifest.loops ?? {});
  const taskIds = declarationOrder?.tasks ?? Object.keys(manifest.tasks ?? {});

  const resolveInputViews = (
    bindingId: string,
    targetSpec: { path: string; kind: 'file' | 'worktree' },
    inputsSpec: Array<{ source: string; label?: string }>,
    filesMap: Record<string, string> = {},
  ): PromptInputContractView[] => {
    const missingList = snapshot.missingInputs?.get(bindingId) ?? [];
    const avail = snapshot.inputAvailability?.get(bindingId);
    return inputsSpec.map(input => {
      const src = input.source;
      let label = input.label;
      if (!label) {
        switch (src) {
          case 'target':
            label = 'Target document';
            break;
          case 'version':
            label = 'Version';
            break;
          case 'priorArtifact':
            label = 'Prior artifact';
            break;
          case 'outputPath':
            label = 'Output path';
            break;
          default:
            label = src;
            break;
        }
      }

      if (src === 'target') {
        if (targetSpec.kind === 'worktree') {
          return {
            label,
            source: src,
            resolutionKind: 'target',
            status: 'available',
            note: '[worktree: .]',
          };
        } else {
          const isMissing = avail ? avail.target === 'missing' : missingList.some(m => m.startsWith('target:'));
          return {
            label,
            source: src,
            resolutionKind: 'target',
            status: isMissing ? 'missing' : 'available',
            note: isMissing ? '[missing target]' : `[file: ${targetSpec.path}]`,
          };
        }
      }

      if (src === 'version') {
        return {
          label,
          source: src,
          resolutionKind: 'runtime',
          status: 'runtime-resolved',
          note: '[resolved at execution]',
        };
      }

      if (src === 'priorArtifact') {
        return {
          label,
          source: src,
          resolutionKind: 'runtime',
          status: 'runtime-resolved',
          note: '[resolved from chain state]',
        };
      }

      if (src === 'outputPath') {
        return {
          label,
          source: src,
          resolutionKind: 'runtime',
          status: 'runtime-resolved',
          note: '[pattern + selected provider]',
        };
      }

      // Configured file
      const filePath = filesMap[src];
      const isMissing = avail ? avail.files[src] === 'missing' : missingList.some(m => m.startsWith(`file: ${src}=`));
      return {
        label,
        source: src,
        resolutionKind: 'configured-file',
        configuredKey: src,
        configuredValue: filePath,
        status: isMissing ? 'missing' : 'available',
        note: isMissing ? `[file: ${filePath}; missing]` : `[file: ${filePath}]`,
      };
    });
  };

  for (const loopId of loopIds) {
    const loopSpec = manifest.loops[loopId];
    if (!loopSpec) continue;

    const evalSkill = manifest.skills[loopSpec.evaluate.skill];
    const repSkill = manifest.skills[loopSpec.repair.skill];

    const evalRoleId = evalSkill?.role ?? 'unknown';
    const repRoleId = repSkill?.role ?? 'unknown';

    const inputs = resolveInputViews(loopId, loopSpec.target, loopSpec.inputs, loopSpec.files ?? {});
    const targetInputView = inputs.find((i) => i.source === 'target');
    const targetStatus = targetInputView?.status ?? 'available';

    const evalStep: PromptStepContractView = {
      phase: 'evaluate',
      roleId: evalRoleId,
      rolePath: manifest.roles[evalRoleId] ?? '',
      skillId: loopSpec.evaluate.skill,
      skillPath: evalSkill?.file ?? '',
      inputs,
      outputPattern: loopSpec.evaluate.output.pattern,
      outputContract: loopSpec.evaluate.output.contract,
      decision: loopSpec.evaluate.output.decision,
      validator: loopSpec.evaluate.output.validator,
    };

    const repStep: PromptStepContractView = {
      phase: 'repair',
      roleId: repRoleId,
      rolePath: manifest.roles[repRoleId] ?? '',
      skillId: loopSpec.repair.skill,
      skillPath: repSkill?.file ?? '',
      inputs,
      outputPattern: loopSpec.repair.output.pattern,
      outputContract: loopSpec.repair.output.contract,
      decision: loopSpec.repair.output.decision,
      validator: loopSpec.repair.output.validator,
    };

    result.push({
      bindingId: loopId,
      bindingKind: 'loop',
      targetPath: loopSpec.target.path,
      targetKind: loopSpec.target.kind,
      targetStatus,
      composition: 'Role content -> Skill content -> ordered Inputs',
      steps: [evalStep, repStep],
    });
  }

  for (const taskId of taskIds) {
    const taskSpec = manifest.tasks[taskId];
    if (!taskSpec) continue;

    const taskSkill = manifest.skills[taskSpec.skill];
    const roleId = taskSkill?.role ?? 'unknown';

    const inputs = resolveInputViews(taskId, taskSpec.target, taskSpec.inputs, taskSpec.files ?? {});
    const targetInputView = inputs.find((i) => i.source === 'target');
    const targetStatus = targetInputView?.status ?? 'available';

    const taskStep: PromptStepContractView = {
      phase: 'task',
      roleId,
      rolePath: manifest.roles[roleId] ?? '',
      skillId: taskSpec.skill,
      skillPath: taskSkill?.file ?? '',
      inputs,
      outputPattern: taskSpec.output.pattern,
      outputContract: taskSpec.output.contract,
      validator: taskSpec.output.validator,
    };

    result.push({
      bindingId: taskId,
      bindingKind: 'task',
      targetPath: taskSpec.target.path,
      targetKind: taskSpec.target.kind,
      targetStatus,
      composition: 'Role content -> Skill content -> ordered Inputs',
      steps: [taskStep],
    });
  }

  return result;
}

export function buildProjectSnapshotView(
  config: Config,
  snapshot: GlobalSnapshot,
  scanTime?: string,
): ProjectSnapshotView {
  const projectRoot = config.projectRoot;
  const configPath = config.manifestPath;
  const manifest = config.manifest;
  const pipelines = config.manifestDeclarationOrder?.pipelines ?? Object.keys(manifest.pipelines ?? {});

  const marker = snapshot.interruptedMarker ?? null;

  // Compute loopMaxMtimes across ALL steps (matching resolveDefaultLoop)
  const loopMaxMtimes: Record<string, number | null> = {};
  const loopOrder = config.manifestDeclarationOrder?.loops ?? Object.keys(manifest.loops ?? {});
  for (const loopId of loopOrder) {
    const steps = snapshot.byBinding.get(loopId) ?? [];
    loopMaxMtimes[loopId] = steps.reduce<number | null>((max, step) => (
      max === null || step.mtime > max ? step.mtime : max
    ), null);
  }

  const defaultLoop = selectDefaultLoop(marker?.loop ?? null, manifest.loops ?? {}, loopMaxMtimes);
  const suggestedLoop = defaultLoop || null;
  let suggestedLoopReason = '';

  if (suggestedLoop) {
    const steps = snapshot.byBinding.get(suggestedLoop) ?? [];
    const validSteps = steps.filter(s => !s.unclassified);
    const latestStep = validSteps[validSteps.length - 1];
    const isCompletedOrAccepted = Boolean(
      latestStep && (latestStep.decision === 'accepted' || latestStep.completionOutcome === 'completed')
    );
    const recovered = recoverInProgressRun(steps as any);

    if (recovered && !isCompletedOrAccepted) {
      suggestedLoopReason = `in-progress chain active for loop '${suggestedLoop}'`;
    } else if (marker?.loop === suggestedLoop) {
      suggestedLoopReason = `interrupted run pending for binding '${suggestedLoop}'`;
    } else if (loopMaxMtimes[suggestedLoop] !== null && loopMaxMtimes[suggestedLoop] !== undefined) {
      if (validSteps.length === 0) {
        suggestedLoopReason = `most recently active loop is '${suggestedLoop}' (unclassified evidence only)`;
      } else {
        suggestedLoopReason = `most recently active loop is '${suggestedLoop}'`;
      }
    } else if (Object.keys(manifest.loops ?? {})[0] === suggestedLoop) {
      suggestedLoopReason = `no valid in-progress loop; ${suggestedLoop} is the configured first loop stage`;
    } else {
      suggestedLoopReason = `suggested loop '${suggestedLoop}'`;
    }
  } else {
    suggestedLoopReason = 'no loops configured in manifest';
  }

  const bindings: BindingSnapshotView[] = [];

  for (const loopId of loopOrder) {
    const loopSpec = manifest.loops[loopId];
    if (!loopSpec) continue;
    const steps = snapshot.byBinding.get(loopId) ?? [];
    const validSteps = steps.filter(s => !s.unclassified);
    const unclassSteps = steps.filter(s => s.unclassified);
    const missing = snapshot.missingInputs.get(loopId) ?? [];

    const evalSteps = validSteps.filter(s => s.kind === 'evaluate');
    const repSteps = validSteps.filter(s => s.kind === 'repair');
    const latestEval = evalSteps[evalSteps.length - 1];
    const latestRep = repSteps[repSteps.length - 1];

    bindings.push({
      bindingId: loopId,
      bindingKind: 'loop',
      targetPath: loopSpec.target.path,
      latestEvaluate: latestEval ? summarizeStep(latestEval) : undefined,
      latestRepair: latestRep ? summarizeStep(latestRep) : undefined,
      latestSteps: validSteps,
      missingInputs: missing,
      unclassifiedCount: unclassSteps.length,
      unclassifiedSteps: unclassSteps,
    });
  }

  const taskOrder = config.manifestDeclarationOrder?.tasks ?? Object.keys(manifest.tasks ?? {});
  for (const taskId of taskOrder) {
    const taskSpec = manifest.tasks[taskId];
    if (!taskSpec) continue;
    const steps = snapshot.byBinding.get(taskId) ?? [];
    const validSteps = steps.filter(s => !s.unclassified);
    const unclassSteps = steps.filter(s => s.unclassified);
    const missing = snapshot.missingInputs.get(taskId) ?? [];

    const latestT = validSteps[validSteps.length - 1];

    bindings.push({
      bindingId: taskId,
      bindingKind: 'task',
      targetPath: taskSpec.target.path,
      latestTask: latestT ? summarizeStep(latestT) : undefined,
      latestSteps: validSteps,
      missingInputs: missing,
      unclassifiedCount: unclassSteps.length,
      unclassifiedSteps: unclassSteps,
    });
  }

  const artifactsForCandidates = snapshot.steps.map(s => ({
    artifactIdentity: s.artifactIdentity ?? '',
    pipelineId: s.pipelineId ?? null,
    pipelineRunId: s.pipelineRunId ?? null,
    stageId: s.stageId ?? null,
    chainId: s.chainId ?? '',
    chainMode: (s.chainMode ?? null) as any,
    parentArtifactIdentity: s.parentArtifactIdentity ?? null,
    resultFingerprint: s.resultFingerprint ?? '',
    artifactPath: s.artifactPath,
    decision: s.decision,
    completionOutcome: s.completionOutcome,
    contractValid: !s.unclassified,
    version: s.version,
  }));
  const targetSnapshots = buildTargetSnapshots(projectRoot, manifest);
  const rawCandidates = pipelineStageCandidates(artifactsForCandidates, manifest, targetSnapshots);

  const candidateToView = (c: Candidate): CandidateSnapshotView => ({
    pipelineId: c.pipelineId,
    pipelineRunId: c.pipelineRunId,
    predecessorStageId: c.predecessorStageId,
    successorStageId: c.successorStageId,
    completionArtifactPath: c.predecessorArtifactPath,
    completionArtifactIdentity: c.artifactIdentity,
    decisionOrOutcome: c.evidence.decision ?? c.evidence.completionOutcome ?? 'accepted',
    resultFingerprint: c.resultFingerprint,
    targetFingerprintNow: c.targetFingerprintNow,
    stale: c.stale,
    staleReason: c.stale ? 'target fingerprint modified since predecessor completion' : undefined,
  });

  const allCandidatesView = rawCandidates.map(candidateToView);
  const eligibleCandidatesView = rawCandidates.filter(c => !c.stale).map(candidateToView);

  const totalUnclassifiedSteps = snapshot.unclassified;

  const configuredPipelines: ConfiguredPipelineView[] = [];
  for (const pipelineId of pipelines) {
    const pipelineSpec = manifest.pipelines[pipelineId];
    if (!pipelineSpec) continue;
    configuredPipelines.push({
      pipelineId,
      stages: (pipelineSpec.stages ?? []).map(s => ({
        stageId: s.stageId,
        loopOrTask: s.loop ?? s.task ?? 'unknown',
      })),
    });
  }

  const promptContracts = buildBindingPromptContracts(manifest, snapshot, config.manifestDeclarationOrder);

  return {
    projectRoot,
    configPath,
    scanTime: scanTime ?? new Date().toISOString(),
    pipelines,
    configuredPipelines,
    suggestedLoop,
    suggestedLoopReason,
    bindings,
    promptContracts,
    eligibleCandidates: eligibleCandidatesView,
    allCandidates: allCandidatesView,
    unclassifiedCount: totalUnclassifiedSteps.length,
    unclassifiedSteps: totalUnclassifiedSteps,
    interruptedMarker: marker,
  };
}
