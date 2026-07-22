import type { Config } from './config.js';
import type { GlobalSnapshot, Step } from './state.js';
import type { InterruptedMarker } from './interrupted-artifact.js';
import { pipelineStageCandidates, recoverInProgressRun, type Candidate } from './pipeline-state.js';
import { buildTargetSnapshots } from './next-step.js';
import { selectDefaultLoop } from './loop-selector.js';

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

export interface ProjectSnapshotView {
  projectRoot: string;
  configPath: string;
  scanTime: string;
  pipelines: string[];
  configuredPipelines: ConfiguredPipelineView[];
  suggestedLoop: string | null;
  suggestedLoopReason: string;
  bindings: BindingSnapshotView[];
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

export function buildProjectSnapshotView(
  config: Config,
  snapshot: GlobalSnapshot,
  scanTime?: string,
): ProjectSnapshotView {
  const projectRoot = config.projectRoot;
  const configPath = config.manifestPath;
  const manifest = config.manifest;
  const pipelines = Object.keys(manifest.pipelines ?? {});

  const marker = snapshot.interruptedMarker ?? null;

  // Compute loopMaxMtimes across ALL steps (matching resolveDefaultLoop)
  const loopMaxMtimes: Record<string, number | null> = {};
  for (const loopId of Object.keys(manifest.loops ?? {})) {
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

  for (const [loopId, loopSpec] of Object.entries(manifest.loops ?? {})) {
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

  for (const [taskId, taskSpec] of Object.entries(manifest.tasks ?? {})) {
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
  for (const [pipelineId, pipelineSpec] of Object.entries(manifest.pipelines ?? {})) {
    configuredPipelines.push({
      pipelineId,
      stages: (pipelineSpec.stages ?? []).map(s => ({
        stageId: s.stageId,
        loopOrTask: s.loop ?? s.task ?? 'unknown',
      })),
    });
  }

  return {
    projectRoot,
    configPath,
    scanTime: scanTime ?? new Date().toISOString(),
    pipelines,
    configuredPipelines,
    suggestedLoop,
    suggestedLoopReason,
    bindings,
    eligibleCandidates: eligibleCandidatesView,
    allCandidates: allCandidatesView,
    unclassifiedCount: totalUnclassifiedSteps.length,
    unclassifiedSteps: totalUnclassifiedSteps,
    interruptedMarker: marker,
  };
}
