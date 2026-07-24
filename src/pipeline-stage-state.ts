import type { V1Manifest, OutputContract } from './manifest.js';
import { reduceApprovalChain, type ApprovalChainStep, type ApprovalPhase, type ApprovalResult } from './approval-loop-state.js';
import { expectedPredecessor, type ChainMode } from './pipeline-state.js';

export type CandidateReason =
  | 'eligible'
  | 'target-fingerprint-drift'
  | 'exact-edge-consumed'
  | 'missing-target-fingerprint';

export interface ArtifactRecord {
  artifactIdentity: string;
  bindingKind: 'loop' | 'task';
  bindingId: string;
  phase: ApprovalPhase | string;
  contract: OutputContract;
  normalizedResult: ApprovalResult;
  contractValid: boolean;
  unclassified: boolean;
  pipelineId: string | null;
  pipelineRunId: string | null;
  stageId: string | null;
  chainId: string;
  chainMode: ChainMode | null;
  parentArtifactIdentity: string | null;
  resultFingerprint: string;
  artifactPath: string;
  version: number;
  decision?: string;
  completionOutcome?: string;
}

export interface CompletionEvidence {
  artifact: ArtifactRecord;
  bindingKind: 'loop' | 'task';
  bindingId: string;
  phase: ApprovalPhase;
  normalizedResult: 'accepted' | 'completed' | 'valid';
  chainId: string;
  chainMode: ChainMode | null;
  pipelineId: string;
  pipelineRunId: string;
  stageId: string;
  parentArtifactIdentity: string | null;
  resultFingerprint: string;
  artifactPath: string;
}

export interface Candidate {
  artifactIdentity: string;
  pipelineId: string;
  pipelineRunId: string;
  successorStageId: string;
  predecessorStageId: string;
  predecessorArtifactPath: string;
  resultFingerprint: string;
  targetFingerprintNow: string | null;
  stale: boolean;
  reason: CandidateReason;
  unavailableReason?: CandidateReason;
  evidence: {
    bindingKind: 'loop' | 'task';
    bindingId: string;
    phase: ApprovalPhase;
    chainId: string;
    chainMode: ChainMode | null;
    parentArtifactIdentity: string | null;
    normalizedResult: 'accepted' | 'completed' | 'valid';
    decision?: string;
    completionOutcome?: string;
    contractValid: boolean;
    unclassified: boolean;
    resultFingerprint: string;
    targetFingerprintNow: string | null;
    consumedByArtifactIdentity?: string;
  };
}

function bindingForStage(manifest: V1Manifest, pipelineId: string, stageId: string): { bindingId: string; kind: 'loop' | 'task' } | null {
  const pipeline = manifest.pipelines[pipelineId];
  const stage = pipeline?.stages.find(item => item.stageId === stageId);
  if (!stage) return null;
  if (stage.loop) return { bindingId: stage.loop, kind: 'loop' };
  if (stage.task) return { bindingId: stage.task, kind: 'task' };
  return null;
}

function toApprovalStep(record: ArtifactRecord): ApprovalChainStep {
  return {
    artifactIdentity: record.artifactIdentity,
    bindingKind: record.bindingKind,
    bindingId: record.bindingId,
    phase: record.phase,
    chainId: record.chainId,
    chainMode: record.chainMode,
    pipelineId: record.pipelineId,
    pipelineRunId: record.pipelineRunId,
    stageId: record.stageId,
    version: record.version,
    parentArtifactIdentity: record.parentArtifactIdentity,
    normalizedResult: record.normalizedResult,
    contractValid: record.contractValid,
    unclassified: record.unclassified,
    artifactPath: record.artifactPath,
    resultFingerprint: record.resultFingerprint,
  };
}

function evidenceFrom(record: ArtifactRecord, pipelineId: string, stageId: string): CompletionEvidence {
  const phase = record.phase as ApprovalPhase;
  const normalizedResult = phase === 'evaluate' ? 'accepted' : record.normalizedResult as 'completed' | 'valid';
  return {
    artifact: record,
    bindingKind: record.bindingKind,
    bindingId: record.bindingId,
    phase,
    normalizedResult,
    chainId: record.chainId,
    chainMode: record.chainMode,
    pipelineId,
    pipelineRunId: record.pipelineRunId!,
    stageId,
    parentArtifactIdentity: record.parentArtifactIdentity,
    resultFingerprint: record.resultFingerprint,
    artifactPath: record.artifactPath,
  };
}

function chainKey(record: ArtifactRecord): string {
  return `${record.pipelineId ?? 'null'}:${record.pipelineRunId ?? 'null'}:${record.stageId ?? 'null'}:${record.bindingKind}:${record.bindingId}:${record.chainId}`;
}

/** Resolve completion evidence according to the declared binding contract. */
export function completionEvidenceForStage(
  allArtifacts: readonly ArtifactRecord[],
  pipelineId: string,
  stageId: string,
  manifest: V1Manifest,
): CompletionEvidence[] {
  const binding = bindingForStage(manifest, pipelineId, stageId);
  if (!binding) return [];
  const stageArtifacts = allArtifacts.filter(record =>
    record.pipelineId === pipelineId
    && record.pipelineRunId !== null
    && record.stageId === stageId
    && record.bindingId === binding.bindingId
    && record.bindingKind === binding.kind
    && !record.unclassified
    && record.contractValid,
  );

  if (binding.kind === 'task') {
    return stageArtifacts
      .filter(record => record.phase === 'task'
        && ((record.contract === 'completion-artifact' && record.normalizedResult === 'completed')
          || (record.contract === 'required-artifact' && record.normalizedResult === 'valid')))
      .map(record => evidenceFrom(record, pipelineId, stageId));
  }

  const chains = new Map<string, ArtifactRecord[]>();
  for (const record of stageArtifacts) {
    const chain = chains.get(chainKey(record)) ?? [];
    chain.push(record);
    chains.set(chainKey(record), chain);
  }

  const evidence: CompletionEvidence[] = [];
  for (const chain of chains.values()) {
    const state = reduceApprovalChain(chain.map(toApprovalStep));
    if (state.kind === 'accepted') {
      const accepted = chain.find(record => record.artifactIdentity === state.evaluate.artifactIdentity);
      if (accepted) evidence.push(evidenceFrom(accepted, pipelineId, stageId));
    }
  }
  return evidence;
}

/**
 * Validate only the historical parent edge recorded by a stage-continuation
 * root. Current target fingerprints and later activity are deliberately not
 * consulted, so valid historical successors remain classified.
 */
export function validateContinuationParent(
  child: ArtifactRecord,
  allArtifacts: readonly ArtifactRecord[],
  manifest: V1Manifest,
): { valid: true } | { valid: false; reason: string } {
  if (child.chainMode !== 'stage-continuation') return { valid: true };
  if (!child.pipelineId || !child.pipelineRunId || !child.stageId || !child.parentArtifactIdentity) {
    return { valid: false, reason: 'stage-continuation requires pipeline identity and parentArtifactIdentity.' };
  }
  const predecessorStageId = expectedPredecessor(child.pipelineId, child.stageId, manifest);
  if (!predecessorStageId) {
    return { valid: false, reason: 'stage-continuation must target a non-first configured pipeline stage.' };
  }
  const parent = allArtifacts.find(record => record.artifactIdentity === child.parentArtifactIdentity);
  if (!parent || parent.unclassified) {
    return { valid: false, reason: `stage-continuation parent artifact '${child.parentArtifactIdentity}' not found or is unclassified.` };
  }
  if (
    parent.pipelineId === child.pipelineId
    && parent.pipelineRunId === child.pipelineRunId
    && parent.stageId === child.stageId
    && parent.chainId === child.chainId
  ) {
    // Same-stage parents are valid only for descendants within the same
    // approval chain. A continuation root must still anchor to the
    // immediately preceding pipeline stage, even if a forged parent happens
    // to share its stage and run.
    return { valid: true };
  }
  if (parent.pipelineId !== child.pipelineId || parent.pipelineRunId !== child.pipelineRunId || parent.stageId !== predecessorStageId) {
    return { valid: false, reason: `stage-continuation parent artifact '${child.parentArtifactIdentity}' is in a different pipeline/run/stage.` };
  }
  const evidence = completionEvidenceForStage(allArtifacts, child.pipelineId, predecessorStageId, manifest)
    .some(item => item.artifact.artifactIdentity === child.parentArtifactIdentity);
  if (!evidence) {
    return { valid: false, reason: `stage-continuation parent artifact '${child.parentArtifactIdentity}' is not completion-capable for its binding.` };
  }
  return { valid: true };
}

function consumedBySuccessor(
  evidence: CompletionEvidence,
  allArtifacts: readonly ArtifactRecord[],
  manifest: V1Manifest,
  pipelineId: string,
  successorStageId: string,
): ArtifactRecord | undefined {
  const successorBinding = bindingForStage(manifest, pipelineId, successorStageId);
  if (!successorBinding) return undefined;
  return allArtifacts.find(record =>
    record.artifactIdentity !== evidence.artifact.artifactIdentity
    && record.pipelineId === pipelineId
    && record.pipelineRunId === evidence.pipelineRunId
    && record.stageId === successorStageId
    && record.bindingId === successorBinding.bindingId
    && record.bindingKind === successorBinding.kind
    && record.chainMode === 'stage-continuation'
    && record.parentArtifactIdentity === evidence.artifact.artifactIdentity
    && !record.unclassified
    && record.contractValid,
  );
}

/** Return every completion-derived candidate, including unavailable reasons. */
export function pipelineStageCandidates(
  allArtifacts: readonly ArtifactRecord[],
  manifest: V1Manifest,
  targetSnapshots: Map<string, string>,
  evidenceResolver: typeof completionEvidenceForStage = completionEvidenceForStage,
): Candidate[] {
  const candidates: Candidate[] = [];
  for (const [pipelineId, pipeline] of Object.entries(manifest.pipelines)) {
    for (let index = 0; index < pipeline.stages.length - 1; index += 1) {
      const predecessorStageId = pipeline.stages[index]!.stageId;
      const successorStageId = pipeline.stages[index + 1]!.stageId;
      const evidence = evidenceResolver(allArtifacts, pipelineId, predecessorStageId, manifest);
      for (const item of evidence) {
        const targetFingerprintNow = targetSnapshots.get(`${pipelineId}:${predecessorStageId}`) ?? null;
        const consumed = consumedBySuccessor(item, allArtifacts, manifest, pipelineId, successorStageId);
        const stale = targetFingerprintNow !== null && targetFingerprintNow !== item.resultFingerprint;
        const reason: CandidateReason = consumed
          ? 'exact-edge-consumed'
          : targetFingerprintNow === null
            ? 'missing-target-fingerprint'
            : stale
              ? 'target-fingerprint-drift'
              : 'eligible';
        candidates.push({
          artifactIdentity: item.artifact.artifactIdentity,
          pipelineId,
          pipelineRunId: item.pipelineRunId,
          successorStageId,
          predecessorStageId,
          predecessorArtifactPath: item.artifactPath,
          resultFingerprint: item.resultFingerprint,
          targetFingerprintNow,
          stale,
          reason,
          unavailableReason: reason === 'eligible' ? undefined : reason,
          evidence: {
            bindingKind: item.bindingKind,
            bindingId: item.bindingId,
            phase: item.phase,
            chainId: item.chainId,
            chainMode: item.chainMode,
            parentArtifactIdentity: item.parentArtifactIdentity,
            normalizedResult: item.normalizedResult,
            decision: item.artifact.decision,
            completionOutcome: item.artifact.completionOutcome,
            contractValid: item.artifact.contractValid,
            unclassified: item.artifact.unclassified,
            resultFingerprint: item.resultFingerprint,
            targetFingerprintNow,
            ...(consumed ? { consumedByArtifactIdentity: consumed.artifactIdentity } : {}),
          },
        });
      }
    }
  }

  candidates.sort((a, b) => a.pipelineRunId.localeCompare(b.pipelineRunId)
    || a.predecessorStageId.localeCompare(b.predecessorStageId)
    || a.artifactIdentity.localeCompare(b.artifactIdentity));
  return candidates;
}

export function eligibleNextStages(
  allArtifacts: readonly ArtifactRecord[],
  manifest: V1Manifest,
  targetSnapshots: Map<string, string>,
): Candidate[] {
  return pipelineStageCandidates(allArtifacts, manifest, targetSnapshots)
    .filter(candidate => candidate.reason === 'eligible');
}

export function artifactRecordFromStep(step: {
  artifactIdentity?: string;
  bindingKind?: string;
  bindingId?: string;
  kind: string;
  contract?: OutputContract;
  decision?: string;
  completionOutcome?: string;
  contractValid?: boolean;
  unclassified?: boolean;
  pipelineId?: string | null;
  pipelineRunId?: string | null;
  stageId?: string | null;
  chainId?: string;
  chainMode?: string;
  parentArtifactIdentity?: string | null;
  resultFingerprint?: string;
  artifactPath: string;
  version: number;
}): ArtifactRecord {
  const contract = step.contract ?? (step.kind === 'evaluate' ? 'decision-artifact' : 'completion-artifact');
  const normalizedResult: ApprovalResult = step.decision === 'accepted' || step.decision === 'retry'
    ? step.decision
    : step.completionOutcome === 'completed' || step.completionOutcome === 'blocked'
      ? step.completionOutcome
      : contract === 'required-artifact' && step.contractValid === true
        ? 'valid'
        : 'unknown';
  return {
    artifactIdentity: step.artifactIdentity ?? '',
    bindingKind: step.bindingKind === 'task' ? 'task' : 'loop',
    bindingId: step.bindingId ?? '',
    phase: step.kind,
    contract,
    normalizedResult,
    contractValid: step.contractValid === true && !step.unclassified,
    unclassified: step.unclassified === true,
    pipelineId: step.pipelineId ?? null,
    pipelineRunId: step.pipelineRunId ?? null,
    stageId: step.stageId ?? null,
    chainId: step.chainId ?? '',
    chainMode: (step.chainMode as ChainMode | undefined) ?? null,
    parentArtifactIdentity: step.parentArtifactIdentity ?? null,
    resultFingerprint: step.resultFingerprint ?? '',
    artifactPath: step.artifactPath,
    version: step.version,
    decision: step.decision,
    completionOutcome: step.completionOutcome,
  };
}
