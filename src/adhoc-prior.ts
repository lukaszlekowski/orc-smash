import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { V1Manifest } from './manifest.js';
import type { ChainMode } from './pipeline-state.js';
import {
  bindingForStage,
  toApprovalStep,
  artifactRecordFromStep,
  type ArtifactRecord,
} from './pipeline-stage-state.js';
import { reduceApprovalChain } from './approval-loop-state.js';
import { scanGlobalSnapshot } from './state.js';
import { captureBindingResultFingerprint } from './target-snapshot.js';

export interface AdHocPriorCandidate {
  artifactIdentity: string;
  artifactPath: string;
  bindingId: string;
  chainId: string;
  chainMode: ChainMode | null;
  pipelineId: string | null;
  pipelineRunId: string | null;
  version: number;
  verdict?: string;
  mtime: number;
  resultFingerprint: string;
  targetFingerprintNow: string | null;
  freshness: 'fresh' | 'drifted' | 'missing-fingerprint' | 'missing-input';
  predecessorPipelineId?: string;
  predecessorStageId?: string;
}

/**
 * Check whether an artifact is completion-capable for its binding.
 */
export function isArtifactCompletionCapable(
  artifact: ArtifactRecord,
  allArtifacts: readonly ArtifactRecord[],
): boolean {
  if (artifact.unclassified || !artifact.contractValid) return false;
  if (artifact.bindingKind === 'task') {
    return artifact.phase === 'task'
      && ((artifact.contract === 'completion-artifact' && artifact.normalizedResult === 'completed')
        || (artifact.contract === 'required-artifact' && artifact.normalizedResult === 'valid'));
  }
  if (artifact.bindingKind === 'loop') {
    if (artifact.phase !== 'evaluate') return false;
    const chainArtifacts = allArtifacts.filter(r =>
      r.bindingId === artifact.bindingId
      && r.chainId === artifact.chainId
      && !r.unclassified
      && r.contractValid,
    );
    const reduced = reduceApprovalChain(chainArtifacts.map(toApprovalStep));
    return reduced.kind === 'accepted' && reduced.evaluate.artifactIdentity === artifact.artifactIdentity;
  }
  return false;
}

/**
 * Walk manifest topology to find all pipeline predecessor bindings for a given task.
 */
export function predecessorBindingsForTask(
  manifest: V1Manifest,
  taskId: string,
): Array<{ pipelineId: string; stageId: string; bindingId: string; kind: 'loop' | 'task' }> {
  const predecessors: Array<{ pipelineId: string; stageId: string; bindingId: string; kind: 'loop' | 'task' }> = [];
  for (const [pipelineId, pipeline] of Object.entries(manifest.pipelines ?? {})) {
    for (let i = 1; i < pipeline.stages.length; i++) {
      const stage = pipeline.stages[i]!;
      if (stage.task === taskId) {
        const predStage = pipeline.stages[i - 1]!;
        const predBinding = bindingForStage(manifest, pipelineId, predStage.stageId);
        if (predBinding) {
          predecessors.push({
            pipelineId,
            stageId: predStage.stageId,
            bindingId: predBinding.bindingId,
            kind: predBinding.kind,
          });
        }
      }
    }
  }
  return predecessors;
}

/**
 * Resolve candidate predecessor artifacts for an ad-hoc task run across all pipelines.
 */
export function adHocPriorCandidates(
  projectRoot: string,
  manifest: V1Manifest,
  taskId: string,
): AdHocPriorCandidate[] {
  const predecessors = predecessorBindingsForTask(manifest, taskId);
  if (predecessors.length === 0) return [];

  const snapshot = scanGlobalSnapshot(projectRoot, manifest);
  const allArtifacts = snapshot.steps.map(artifactRecordFromStep);

  const candidateArtifacts: Array<{
    artifact: ArtifactRecord;
    pipelineId: string;
    stageId: string;
  }> = [];

  const seenIdentities = new Set<string>();

  for (const pred of predecessors) {
    const matchingArtifacts = allArtifacts.filter(r =>
      r.bindingId === pred.bindingId
      && r.bindingKind === pred.kind
      && !r.unclassified
      && r.contractValid,
    );

    if (pred.kind === 'task') {
      for (const r of matchingArtifacts) {
        if (
          r.phase === 'task'
          && ((r.contract === 'completion-artifact' && r.normalizedResult === 'completed')
            || (r.contract === 'required-artifact' && r.normalizedResult === 'valid'))
        ) {
          if (!seenIdentities.has(r.artifactIdentity)) {
            seenIdentities.add(r.artifactIdentity);
            candidateArtifacts.push({ artifact: r, pipelineId: pred.pipelineId, stageId: pred.stageId });
          }
        }
      }
    } else if (pred.kind === 'loop') {
      const chains = new Map<string, ArtifactRecord[]>();
      for (const r of matchingArtifacts) {
        const chain = chains.get(r.chainId) ?? [];
        chain.push(r);
        chains.set(r.chainId, chain);
      }
      for (const chain of chains.values()) {
        const reduced = reduceApprovalChain(chain.map(toApprovalStep));
        if (reduced.kind === 'accepted') {
          const accepted = chain.find(r => r.artifactIdentity === reduced.evaluate.artifactIdentity);
          if (accepted && !seenIdentities.has(accepted.artifactIdentity)) {
            seenIdentities.add(accepted.artifactIdentity);
            candidateArtifacts.push({ artifact: accepted, pipelineId: pred.pipelineId, stageId: pred.stageId });
          }
        }
      }
    }
  }

  const results: AdHocPriorCandidate[] = [];

  for (const { artifact, pipelineId, stageId } of candidateArtifacts) {
    const absPath = resolve(projectRoot, artifact.artifactPath);
    let mtime = 0;
    try {
      mtime = statSync(absPath).mtimeMs;
    } catch {
      mtime = 0;
    }

    const predBindingDef = artifact.bindingKind === 'loop'
      ? manifest.loops[artifact.bindingId]
      : manifest.tasks?.[artifact.bindingId];

    let targetFingerprintNow: string | null = null;
    let freshness: AdHocPriorCandidate['freshness'] = 'missing-fingerprint';

    if (predBindingDef) {
      try {
        targetFingerprintNow = captureBindingResultFingerprint(projectRoot, predBindingDef.target, predBindingDef.files, manifest);
        if (!artifact.resultFingerprint) {
          freshness = 'missing-fingerprint';
        } else if (targetFingerprintNow === artifact.resultFingerprint) {
          freshness = 'fresh';
        } else {
          freshness = 'drifted';
        }
      } catch {
        // A declared predecessor input is missing: the composite fingerprint
        // cannot be recomputed at all. Distinct from drift (recomputable but
        // different) and from a missing stamped resultFingerprint.
        targetFingerprintNow = null;
        freshness = 'missing-input';
      }
    }

    const verdict = artifact.decision ?? artifact.completionOutcome ?? (artifact.phase === 'evaluate' ? 'APPROVED' : 'COMPLETED');

    results.push({
      artifactIdentity: artifact.artifactIdentity,
      artifactPath: artifact.artifactPath,
      bindingId: artifact.bindingId,
      chainId: artifact.chainId,
      chainMode: artifact.chainMode,
      pipelineId: artifact.pipelineId,
      pipelineRunId: artifact.pipelineRunId,
      version: artifact.version,
      verdict,
      mtime,
      resultFingerprint: artifact.resultFingerprint,
      targetFingerprintNow,
      freshness,
      predecessorPipelineId: pipelineId,
      predecessorStageId: stageId,
    });
  }

  results.sort((a, b) => {
    const aFresh = a.freshness === 'fresh';
    const bFresh = b.freshness === 'fresh';
    if (aFresh && !bFresh) return -1;
    if (!aFresh && bFresh) return 1;
    if (b.mtime !== a.mtime) return b.mtime - a.mtime;
    return a.artifactIdentity.localeCompare(b.artifactIdentity);
  });

  return results;
}

/**
 * Return the newest fresh candidate, or null if no fresh candidates exist.
 */
export function resolveDefaultPrior(candidates: AdHocPriorCandidate[]): AdHocPriorCandidate | null {
  return candidates.find(c => c.freshness === 'fresh') ?? null;
}

/**
 * Validate that an explicitly specified --prior path resolves to a fresh, classified,
 * completion-capable candidate for the task.
 */
export function validateExplicitPrior(
  projectRoot: string,
  manifest: V1Manifest,
  taskId: string,
  priorPath: string,
): { valid: true; candidate: AdHocPriorCandidate } | { valid: false; error: string } {
  const predecessors = predecessorBindingsForTask(manifest, taskId);
  if (predecessors.length === 0) {
    return {
      valid: false,
      error: `Task '${taskId}' has no pipeline predecessors; --prior is not applicable.`,
    };
  }

  const normalizedPrior = existsSync(resolve(projectRoot, priorPath))
    ? resolve(projectRoot, priorPath)
    : resolve(priorPath);
  if (!existsSync(normalizedPrior)) {
    return {
      valid: false,
      error: `Specified --prior artifact '${priorPath}' does not exist.`,
    };
  }

  const candidates = adHocPriorCandidates(projectRoot, manifest, taskId);
  const matched = candidates.find(c => {
    const cAbs = resolve(projectRoot, c.artifactPath);
    return cAbs === normalizedPrior || cAbs === resolve(priorPath) || c.artifactPath === priorPath;
  });

  if (!matched) {
    return {
      valid: false,
      error: `Specified --prior artifact '${priorPath}' is not a classified, valid completion artifact for an expected predecessor of task '${taskId}'.`,
    };
  }

  if (matched.freshness !== 'fresh') {
    return {
      valid: false,
      error: `Specified --prior artifact '${priorPath}' is not fresh (${matched.freshness}).`,
    };
  }

  return { valid: true, candidate: matched };
}
