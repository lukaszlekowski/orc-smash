import { resolve } from 'node:path';
import { type StepKind } from './provenance.js';
import { renderPattern } from './patterns.js';
import type { V1Manifest } from './manifest.js';
import { readInterruptedMarker } from './interrupted-artifact.js';
import { scanGlobalSnapshot } from './artifact-index.js';

/** Derive the canonical role label for a step kind (used for synthesized steps). */
export function roleForKind(kind: StepKind): string {
  if (kind === 'audit' || kind === 'evaluate') return 'auditor';
  if (kind === 'follow-up' || kind === 'repair') return 'planner';
  return 'implementer';
}

export type { StepKind };
export type StepStatus = 'running' | 'done' | 'failed' | 'interrupted';

export interface Step {
  kind: StepKind;
  skillId?: string;
  bindingId?: string;
  bindingKind?: string;
  role: string;
  agent: string;
  model: string;
  version: number;
  status: StepStatus;
  artifactPath: string;
  mtime: number;
  durationMs?: number;
  sessionMode?: 'fresh' | 'resumed' | 'none';
  sessionId?: string | 'none';

  // contract-classification results
  decision?: string;
  /** @deprecated legacy alias for decision */
  verdict?: string;
  completionOutcome?: string;
  /** @deprecated legacy alias for completionOutcome */
  outcome?: string;
  contractValid?: boolean;
  unclassified?: boolean;

  // v1 identity
  pipelineId?: string | null;
  pipelineRunId?: string | null;
  stageId?: string | null;
  chainId?: string;
  chainMode?: string;
  artifactIdentity?: string;
  inputFingerprint?: string;
  resultFingerprint?: string;
  parentArtifactIdentity?: string | null;
  effort?: string;
  provider?: string;
  sessionStrategy?: string;
}

export interface GlobalSnapshot {
  steps: Step[];
  byBinding: Map<string, Step[]>;
  unclassified: Step[];
  missingInputs: Map<string, string[]>;
}

export { scanGlobalSnapshot, walkProjectDirectory } from './artifact-index.js';

// ---- Display-only helpers ----

export interface StatusScanResult {
  timeline: Step[];
  latestVersion: number;
  interruptedStep: Step | null;
}

export function scanAllForStatus(
  projectRoot: string,
  manifest: V1Manifest,
): StatusScanResult {
  const snapshot = scanGlobalSnapshot(projectRoot, manifest);

  const marker = readInterruptedMarker(projectRoot);
  let interruptedStep: Step | null = null;

  if (marker) {
    const loop = manifest.loops?.[marker.loop];
    const task = manifest.tasks?.[marker.loop];
    const phase = marker.kind === 'repair' ? 'repair' : marker.kind === 'task' ? 'task' : 'evaluate';
    const pattern = task
      ? task.output.pattern
      : phase === 'repair'
        ? loop?.repair.output.pattern
        : loop?.evaluate.output.pattern;
    const artifactPath = pattern
      ? resolve(projectRoot, renderPattern(pattern, { version: marker.version, provider: marker.agent }))
      : resolve(projectRoot, `interrupted-${marker.loop}-${marker.kind}-v${marker.version}.md`);
    const skillId = task
      ? task.skill
      : phase === 'repair'
        ? loop?.repair.skill
        : loop?.evaluate.skill;
    interruptedStep = {
      kind: marker.kind as StepKind,
      bindingId: marker.loop,
      bindingKind: task ? 'task' : 'loop',
      role: skillId && manifest.skills?.[skillId] ? manifest.skills[skillId]!.role : roleForKind(marker.kind),
      agent: marker.agent,
      model: marker.model,
      version: marker.version,
      status: 'interrupted',
      artifactPath,
      mtime: marker.interruptedAtMs,
      effort: marker.effort,
      pipelineId: marker.pipelineId,
      pipelineRunId: marker.pipelineRunId,
      stageId: marker.stageId,
      chainId: marker.chainId,
      artifactIdentity: marker.artifactIdentity,
      parentArtifactIdentity: marker.parentArtifactIdentity,
      chainMode: marker.chainMode,
      sessionMode: marker.sessionMode as any,
      sessionId: marker.sessionId,
    };
  }

  let timeline = snapshot.steps;
  if (interruptedStep) {
    timeline = timeline.filter((s: Step) => s.artifactPath !== interruptedStep!.artifactPath);
    timeline.push(interruptedStep);
    timeline.sort((a: Step, b: Step) => a.mtime - b.mtime);
  }

  const latestVersion = timeline.reduce((max: number, s: Step) => Math.max(max, s.version), 0);

  return { timeline, latestVersion, interruptedStep };
}
