import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArtifactMeta, parseArtifactMetaClassified, type StepKind } from './provenance.js';
import { patternToRegex, renderPattern } from './patterns.js';
import type { V1Manifest } from './manifest.js';
import { classifyArtifact } from './artifact-contract.js';
import { readInterruptedMarker } from './interrupted-artifact.js';
import { validateImplementLedger } from './implement-ledger.js';

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
}

export interface GlobalSnapshot {
  steps: Step[];
  byBinding: Map<string, Step[]>;
  unclassified: Step[];
  missingInputs: Map<string, string[]>;
}

function getAllFiles(dir: string): string[] {
  let results: string[] = [];
  if (!existsSync(dir)) return results;
  const list = readdirSync(dir);
  for (const file of list) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      if (file === 'archived' || filePath.includes('archived/')) continue;
      results = results.concat(getAllFiles(filePath));
    } else {
      results.push(filePath);
    }
  }
  return results;
}

/**
 * Generic contract-driven artifact index. Scans every configured output
 * pattern from every loop and task binding, classifies each matching file
 * against its contract, and yields the global project snapshot.
 */
export function scanGlobalSnapshot(
  projectRoot: string,
  manifest: V1Manifest,
): GlobalSnapshot {
  const allFiles = getAllFiles(projectRoot);
  const steps: Step[] = [];
  const byBinding = new Map<string, Step[]>();
  const unclassified: Step[] = [];
  const missingInputs = new Map<string, string[]>();

  // Keep one record per declaration. A reusable pattern may legitimately be
  // shared by more than one binding; a map keyed only by pattern would make
  // the last declaration silently win.
  const patterns: Array<{ regex: RegExp; bindingId: string; bindingKind: 'loop' | 'task'; phase: StepKind; contract: { type: string; decision?: any; validator?: string } }> = [];

  for (const [loopId, loop] of Object.entries(manifest.loops ?? {})) {
    for (const stepKind of ['evaluate', 'repair'] as const) {
      const step = loop[stepKind];
      const regex = patternToRegex(step.output.pattern);
      patterns.push({
        regex,
        bindingId: loopId,
        bindingKind: 'loop',
        phase: stepKind,
        contract: {
          type: step.output.contract,
          decision: step.output.decision,
          validator: step.output.validator,
        },
      });
    }
  }

  for (const [taskId, task] of Object.entries(manifest.tasks ?? {})) {
    const regex = patternToRegex(task.output.pattern);
    patterns.push({
      regex,
      bindingId: taskId,
      bindingKind: 'task',
      phase: 'task',
      contract: {
        type: task.output.contract,
        decision: undefined,
        validator: task.output.validator,
      },
    });
  }

  for (const [bindingId, binding] of Object.entries(manifest.loops ?? {})) {
    const missing: string[] = [];
    if (binding.target.kind === 'file' && binding.target.path !== '.' && !existsSync(resolve(projectRoot, binding.target.path))) {
      missing.push(`target: ${binding.target.path}`);
    }
    for (const [key, file] of Object.entries(binding.files ?? {})) {
      if (!existsSync(resolve(projectRoot, file))) missing.push(`file: ${key}=${file}`);
    }
    if (missing.length > 0) missingInputs.set(bindingId, missing);
  }
  for (const [bindingId, binding] of Object.entries(manifest.tasks ?? {})) {
    const missing: string[] = [];
    if (binding.target.kind === 'file' && binding.target.path !== '.' && !existsSync(resolve(projectRoot, binding.target.path))) {
      missing.push(`target: ${binding.target.path}`);
    }
    for (const [key, file] of Object.entries(binding.files ?? {})) {
      if (!existsSync(resolve(projectRoot, file))) missing.push(`file: ${key}=${file}`);
    }
    if (missing.length > 0) missingInputs.set(bindingId, missing);
  }

  for (const file of allFiles) {
    const relPath = relative(projectRoot, file);

    const matchingPatterns = patterns.filter((patternInfo) => relPath.match(patternInfo.regex));
    if (matchingPatterns.length === 0) continue;

    const firstMatch = relPath.match(matchingPatterns[0]!.regex)!;
    const version = parseInt(firstMatch[1]!, 10);
    const provider = firstMatch[2]!;

    try {
      const content = readFileSync(file, 'utf-8');
      const parsedMeta = parseArtifactMeta(content, { agent: provider, version, kind: matchingPatterns[0]!.phase });
      const classifiedMeta = parseArtifactMetaClassified(content, { agent: provider, version, kind: matchingPatterns[0]!.phase });
      const patternInfo = classifiedMeta.status === 'classified'
        ? matchingPatterns.find((candidate) => parsedMeta.bindingId === candidate.bindingId && parsedMeta.bindingKind === candidate.bindingKind)
          ?? (matchingPatterns.length === 1 ? matchingPatterns[0] : undefined)
        : matchingPatterns[0];
      if (!patternInfo) continue;
      const meta = parsedMeta;
      const mtime = statSync(file).mtimeMs;

      const step: Step = {
        kind: meta.kind,
        bindingId: meta.bindingId ?? patternInfo.bindingId,
        bindingKind: meta.bindingKind ?? patternInfo.bindingKind,
        role: meta.role,
        agent: meta.agent,
        model: meta.model,
        version,
        status: 'done',
        artifactPath: file,
        mtime,
        durationMs: meta.durationMs,
        sessionMode: meta.sessionMode,
        sessionId: meta.sessionId,
        pipelineId: meta.pipelineId,
        pipelineRunId: meta.pipelineRunId,
        stageId: meta.stageId,
        chainId: meta.chainId,
        chainMode: meta.chainMode,
        artifactIdentity: meta.artifactIdentity,
        inputFingerprint: meta.inputFingerprint,
        resultFingerprint: meta.resultFingerprint,
        parentArtifactIdentity: meta.parentArtifactIdentity,
        effort: meta.effort,
        provider,
      };

      const classification = classifiedMeta;
      if (classification.status !== 'classified') {
        step.unclassified = true;
        step.contractValid = false;
        const bindingSteps = byBinding.get(patternInfo.bindingId) ?? [];
        bindingSteps.push(step);
        byBinding.set(patternInfo.bindingId, bindingSteps);
        steps.push(step);
        unclassified.push(step);
        continue;
      }

      // Classify against the declared output contract only after provenance
        // has established that this is a v1 workflow artifact.
      try {
        switch (patternInfo.contract.type) {
          case 'decision-artifact': {
            const decision = patternInfo.contract.decision;
            if (decision) {
              const result = classifyArtifact(file, 'decision-artifact', decision);
              step.decision = result.kind;
              step.contractValid = result.kind !== 'unknown';
            } else step.contractValid = false;
            break;
          }
          case 'completion-artifact': {
            const result = classifyArtifact(file, 'completion-artifact');
            step.completionOutcome = result.kind;
            step.contractValid = result.kind !== 'unknown';
            break;
          }
          case 'required-artifact': {
            const validator = patternInfo.contract.validator === 'implement-ledger'
              ? (path: string) => validateImplementLedger(readFileSync(path, 'utf8')).valid
              : undefined;
            step.contractValid = classifyArtifact(file, 'required-artifact', undefined, validator).kind === 'valid';
            break;
          }
        }
      } catch {
        step.contractValid = false;
      }

      const bindingId = meta.bindingId ?? patternInfo.bindingId;
      if (step.contractValid === false) {
        step.unclassified = true;
        step.decision = undefined;
        step.completionOutcome = undefined;
        step.verdict = undefined;
        step.outcome = undefined;
        unclassified.push(step);
      }
      const bindingSteps = byBinding.get(bindingId) ?? [];
      bindingSteps.push(step);
      byBinding.set(bindingId, bindingSteps);
      steps.push(step);
    } catch {
      // can't classify, skip
    }
  }

  // Sort timeline chronologically
  const stepOrder = (step: Step): number => step.kind === 'evaluate' ? 0 : step.kind === 'repair' ? 1 : 2;
  const orderSteps = (a: Step, b: Step): number => a.mtime - b.mtime || a.version - b.version || stepOrder(a) - stepOrder(b) || a.artifactPath.localeCompare(b.artifactPath);
  steps.sort(orderSteps);
  for (const bindingSteps of byBinding.values()) bindingSteps.sort(orderSteps);
  const chains = new Map<string, Step[]>();
  for (const step of steps) {
    if (step.unclassified || !step.chainId || !step.artifactIdentity) continue;
    const key = `${step.pipelineId ?? 'null'}:${step.pipelineRunId ?? 'null'}:${step.stageId ?? 'null'}:${step.chainId}`;
    const chain = chains.get(key) ?? [];
    chain.push(step);
    chains.set(key, chain);
  }
  for (const chain of chains.values()) {
    chain.sort(orderSteps);
    for (let index = 0; index < chain.length; index += 1) {
      const current = chain[index]!;
      const lineageValid = index === 0
        ? current.chainMode === 'stage-continuation'
          ? typeof current.parentArtifactIdentity === 'string'
          : current.parentArtifactIdentity === null
        : current.parentArtifactIdentity === chain[index - 1]!.artifactIdentity;
      if (!lineageValid) {
        current.unclassified = true;
        current.contractValid = false;
        current.decision = undefined;
        current.completionOutcome = undefined;
        current.verdict = undefined;
        current.outcome = undefined;
        if (!unclassified.includes(current)) unclassified.push(current);
      }
    }
  }
  unclassified.sort((a, b) => a.mtime - b.mtime);

  return { steps, byBinding, unclassified, missingInputs };
}

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
    };
  }

  let timeline = snapshot.steps;
  if (interruptedStep) {
    timeline = timeline.filter(s => s.artifactPath !== interruptedStep!.artifactPath);
    timeline.push(interruptedStep);
    timeline.sort((a, b) => a.mtime - b.mtime);
  }

  const latestVersion = timeline.reduce((max, s) => Math.max(max, s.version), 0);

  return { timeline, latestVersion, interruptedStep };
}
