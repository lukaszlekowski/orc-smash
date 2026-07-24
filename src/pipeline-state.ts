import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import type { V1Manifest, TargetKind } from './manifest.js';

/** Canonical digest primitive shared by identity and input snapshots. */
export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

// ---- identity types ----

export type ChainMode = 'pipeline-start' | 'stage-continuation' | 'ad-hoc' | 'second-opinion';

/**
 * The identity context that flows through the executor for a single binding
 * invocation. Built once at entry (smashAction) and reused across within-loop
 * steps; advanced to a child context on stage continuation.
 */
export interface RunContext {
  pipelineId: string | null;
  pipelineRunId: string | null;
  stageId: string | null;
  chainId: string;
  chainMode: ChainMode;
  parentArtifactIdentity: string | null;
  /** Set when the context was created by `continueRunContext` – signals the
   *  executor to route through chain-history continuation logic rather than
   *  treating this as a fresh start of the given mode. */
  continue?: true;
}

/**
 * Build a RunContext for the given invocation mode. Only `pipeline-start`
 * mints a fresh `pipelineRunId` and sets non-null `pipelineId`/`stageId`.
 */
export function mintRunContext(params: {
  mode: 'pipeline-start' | 'ad-hoc' | 'stage-continuation' | 'second-opinion';
  pipelineId?: string;
  pipelineRunId?: string;
  stageId?: string;
  parentArtifactIdentity?: string | null;
}): RunContext {
  const chainId = mintChainId();
  switch (params.mode) {
    case 'pipeline-start':
      return {
        pipelineId: params.pipelineId ?? null,
        pipelineRunId: mintRunId(),
        stageId: params.stageId ?? null,
        chainId,
        chainMode: 'pipeline-start',
        parentArtifactIdentity: null,
      };
    case 'stage-continuation':
      return {
        pipelineId: params.pipelineId ?? null,
        pipelineRunId: params.pipelineRunId ?? null,
        stageId: params.stageId ?? null,
        chainId,
        chainMode: 'stage-continuation',
        parentArtifactIdentity: params.parentArtifactIdentity ?? null,
      };
    case 'second-opinion':
      return {
        pipelineId: params.pipelineId ?? null,
        pipelineRunId: params.pipelineRunId ?? null,
        stageId: params.stageId ?? null,
        chainId,
        chainMode: 'second-opinion',
        parentArtifactIdentity: null,
      };
    case 'ad-hoc':
    default:
      return {
        pipelineId: null,
        pipelineRunId: null,
        stageId: null,
        chainId,
        chainMode: 'ad-hoc',
        parentArtifactIdentity: null,
      };
  }
}

export function continueRunContext(params: {
  chainId: string;
  chainMode: ChainMode;
  pipelineId: string | null;
  pipelineRunId: string | null;
  stageId: string | null;
  parentArtifactIdentity: string | null;
}): RunContext {
  return {
    pipelineId: params.pipelineId,
    pipelineRunId: params.pipelineRunId,
    stageId: params.stageId,
    chainId: params.chainId,
    chainMode: params.chainMode,
    parentArtifactIdentity: params.parentArtifactIdentity,
    continue: true,
  };
}

export interface ArtifactIdentity {
  artifactIdentity: string;
  inputFingerprint: string;
  resultFingerprint: string;
  parentArtifactIdentity: string | null;
  pipelineId: string | null;
  pipelineRunId: string | null;
  stageId: string | null;
  chainId: string;
  chainMode: ChainMode;
}

// ---- ID minting ----

export function mintRunId(): string {
  return randomUUID();
}

export function mintChainId(): string {
  return randomUUID();
}

// ---- artifact identity digest ----

export function computeArtifactIdentity(fields: {
  schemaVersion: number;
  pipelineId: string | null;
  pipelineRunId: string | null;
  stageId: string | null;
  bindingKind: string;
  bindingId: string;
  chainId: string;
  chainMode: ChainMode;
  step: string;
  version: number;
  provider: string;
  model: string;
  effort?: string;
  sessionMode?: string;
  sessionId?: string;
  parentArtifactIdentity: string | null;
  inputFingerprint: string;
  resultFingerprint: string;
}): string {
  const canonical = [
    `sv:${fields.schemaVersion}`,
    `pid:${fields.pipelineId ?? 'null'}`,
    `prid:${fields.pipelineRunId ?? 'null'}`,
    `sid:${fields.stageId ?? 'null'}`,
    `bk:${fields.bindingKind}`,
    `bid:${fields.bindingId}`,
    `cid:${fields.chainId}`,
    `cm:${fields.chainMode}`,
    `step:${fields.step}`,
    `v:${fields.version}`,
    `p:${fields.provider}`,
    `m:${fields.model}`,
    `e:${fields.effort ?? 'none'}`,
    `sm:${fields.sessionMode ?? 'none'}`,
    `sess:${fields.sessionId ?? 'none'}`,
    `pa:${fields.parentArtifactIdentity ?? 'null'}`,
    `inf:${fields.inputFingerprint}`,
    `rf:${fields.resultFingerprint}`,
  ].join('|');
  return sha256(canonical);
}

// ---- target fingerprint (pure, accepts byte snapshot from caller) ----

export function targetFingerprint(targetKind: TargetKind, snapshot: string): string {
  return sha256(snapshot);
}

// ---- input fingerprint ----

export function computeInputFingerprint(inputs: {
  targetDigest: string;
  priorArtifact:
    | { kind: 'none' }
    | { path: string; artifactIdentity: string; contentDigest: string };
  fileDigests: Record<string, string>;
}): string {
  const parts: string[] = [];
  parts.push(`target:${inputs.targetDigest}`);
  if ('kind' in inputs.priorArtifact) {
    parts.push('pa:none');
  } else {
    parts.push(`pa:${inputs.priorArtifact.artifactIdentity}:${inputs.priorArtifact.contentDigest}`);
  }
  const sortedKeys = Object.keys(inputs.fileDigests).sort();
  for (const key of sortedKeys) {
    parts.push(`f:${key}:${inputs.fileDigests[key]}`);
  }
  return sha256(parts.join('|'));
}

// ---- chain mode resolution ----

export function resolveChainMode(
  startContext: 'pipeline-start' | 'ad-hoc' | 'stage-continuation' | 'second-opinion',
): ChainMode {
  return startContext;
}

// ---- pipeline stage helpers ----

export function isFirstStage(pipelineId: string, stageId: string, manifest: V1Manifest): boolean {
  const pipeline = manifest.pipelines[pipelineId];
  if (!pipeline) return false;
  return pipeline.stages.length > 0 && pipeline.stages[0]!.stageId === stageId;
}

export function expectedPredecessor(pipelineId: string, stageId: string, manifest: V1Manifest): string | null {
  const pipeline = manifest.pipelines[pipelineId];
  if (!pipeline) return null;
  for (let i = 0; i < pipeline.stages.length; i++) {
    if (pipeline.stages[i]!.stageId === stageId) {
      if (i === 0) return null;
      return pipeline.stages[i - 1]!.stageId;
    }
  }
  return null;
}

// ---- recovery ----

export function isAdHoc(meta: { pipelineId: string | null }): boolean {
  return meta.pipelineId === null;
}

export function recoverInProgressRun(
  artifacts: Array<{ chainId?: string; chainMode?: string | null; pipelineId?: string | null; pipelineRunId?: string | null; stageId?: string | null }>,
): { chainId: string; chainMode: ChainMode; pipelineId: string | null; pipelineRunId: string | null; stageId: string | null } | null {
  if (artifacts.length === 0) return null;
  const latest = artifacts[artifacts.length - 1]!;
  if (!latest.chainMode || !latest.chainId || !['pipeline-start', 'stage-continuation', 'ad-hoc', 'second-opinion'].includes(latest.chainMode)) return null;
  return {
    chainId: latest.chainId,
    chainMode: latest.chainMode as ChainMode,
    pipelineId: latest.pipelineId ?? null,
    pipelineRunId: latest.pipelineRunId ?? null,
    stageId: latest.stageId ?? null,
  };
}
