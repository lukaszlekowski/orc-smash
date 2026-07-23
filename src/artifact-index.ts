import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArtifactMeta, parseArtifactMetaClassified, type StepKind } from './provenance.js';
import { patternToRegex } from './patterns.js';
import type { V1Manifest } from './manifest.js';
import { classifyArtifact } from './artifact-contract.js';
import { validateImplementLedger } from './implement-ledger.js';
import { roleForKind, type Step, type GlobalSnapshot, type BindingInputAvailability } from './state.js';
import { computeArtifactIdentity, expectedPredecessor } from './pipeline-state.js';
import { readInterruptedMarker } from './interrupted-artifact.js';

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'archived',
  '.orc-smash',
  '.cache',
  '.gemini',
]);

/**
 * Symlink-safe, containment-checked, directory-traversing file walker.
 */
export function walkProjectDirectory(projectRoot: string): string[] {
  const realRoot = existsSync(projectRoot) ? realpathSync(projectRoot) : resolve(projectRoot);
  const results: string[] = [];
  const visited = new Set<string>();

  function walk(currentDir: string): void {
    let realCurrentDir: string;
    try {
      realCurrentDir = realpathSync(currentDir);
    } catch {
      return;
    }
    if (visited.has(realCurrentDir)) return;
    visited.add(realCurrentDir);

    if (!existsSync(currentDir)) return;
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }

    for (const file of entries) {
      if (EXCLUDED_DIRS.has(file)) continue;
      const filePath = join(currentDir, file);

      try {
        const lstat = lstatSync(filePath);
        if (lstat.isSymbolicLink()) {
          // Verify realpath containment to prevent symlink loops and external escapes
          let realTarget: string;
          try {
            realTarget = realpathSync(filePath);
          } catch {
            continue; // broken link
          }
          const relToRoot = relative(realRoot, realTarget);
          if (relToRoot.startsWith('..') || resolve(realTarget) === resolve(realRoot)) {
            continue; // escapes projectRoot
          }
          const targetLstat = lstatSync(realTarget);
          if (targetLstat.isDirectory()) {
            walk(filePath);
          } else if (targetLstat.isFile()) {
            results.push(filePath);
          }
        } else if (lstat.isDirectory()) {
          walk(filePath);
        } else if (lstat.isFile()) {
          results.push(filePath);
        }
      } catch {
        // Skip unreadable files/dirs
      }
    }
  }

  walk(realRoot);
  return results;
}

/**
 * Single authoritative contract-driven artifact index.
 * Scans every configured output pattern from every loop and task binding,
 * classifies each matching file against its contract, validates chain lineage,
 * and yields the global project snapshot.
 */
export function scanGlobalSnapshot(
  projectRoot: string,
  manifest: V1Manifest,
): GlobalSnapshot {
  const allFiles = walkProjectDirectory(projectRoot);
  const steps: Step[] = [];
  const byBinding = new Map<string, Step[]>();
  const unclassified: Step[] = [];
  const missingInputs = new Map<string, string[]>();

  const patterns: Array<{
    regex: RegExp;
    bindingId: string;
    bindingKind: 'loop' | 'task';
    phase: StepKind;
    contract: { type: string; decision?: any; validator?: string };
  }> = [];

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

  const inputAvailability = new Map<string, BindingInputAvailability>();

  const scanBindingAvailability = (bindingId: string, targetSpec: { kind: string; path: string }, filesMap?: Record<string, string>) => {
    const targetMissing = targetSpec.kind === 'file' && targetSpec.path !== '.' && !existsSync(resolve(projectRoot, targetSpec.path));
    const targetStatus: 'available' | 'missing' = targetMissing ? 'missing' : 'available';

    const filesStatus: Record<string, 'available' | 'missing'> = {};
    const missing: string[] = [];

    if (targetMissing) {
      missing.push(`target: ${targetSpec.path}`);
    }

    for (const [key, file] of Object.entries(filesMap ?? {})) {
      const exists = existsSync(resolve(projectRoot, file));
      filesStatus[key] = exists ? 'available' : 'missing';
      if (!exists) {
        missing.push(`file: ${key}=${file}`);
      }
    }

    inputAvailability.set(bindingId, {
      target: targetStatus,
      files: filesStatus,
    });

    if (missing.length > 0) {
      missingInputs.set(bindingId, missing);
    }
  };

  for (const [bindingId, binding] of Object.entries(manifest.loops ?? {})) {
    scanBindingAvailability(bindingId, binding.target, binding.files);
  }
  for (const [bindingId, binding] of Object.entries(manifest.tasks ?? {})) {
    scanBindingAvailability(bindingId, binding.target, binding.files);
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

      if (classifiedMeta.status === 'classified') {
        const meta = parsedMeta;
        
        // 1. Recompute artifactIdentity from parsed canonical tuple and reject mismatch
        if (!meta.artifactIdentity || !meta.inputFingerprint || !meta.resultFingerprint) {
          throw new Error('Missing identity digests.');
        }
        const computed = computeArtifactIdentity({
          schemaVersion: meta.schemaVersion ?? 1,
          pipelineId: meta.pipelineId ?? null,
          pipelineRunId: meta.pipelineRunId ?? null,
          stageId: meta.stageId ?? null,
          bindingKind: meta.bindingKind!,
          bindingId: meta.bindingId!,
          chainId: meta.chainId!,
          chainMode: meta.chainMode!,
          step: meta.step ?? meta.kind!,
          version: meta.version!,
          provider: meta.provider ?? meta.agent!,
          model: meta.model!,
          effort: meta.effort,
          sessionMode: meta.sessionMode,
          sessionId: meta.sessionId,
          parentArtifactIdentity: meta.parentArtifactIdentity ?? null,
          inputFingerprint: meta.inputFingerprint!,
          resultFingerprint: meta.resultFingerprint!,
        });
        if (computed !== meta.artifactIdentity) {
          throw new Error(`Artifact identity digest verification failed. Expected: '${computed}', Got: '${meta.artifactIdentity}'.`);
        }
        
        // 2. Require filename pattern, phase, bindingId, and bindingKind to agree
        const patternMatch = matchingPatterns.find((candidate) =>
          meta.bindingId === candidate.bindingId &&
          meta.bindingKind === candidate.bindingKind &&
          meta.kind === candidate.phase
        );
        if (!patternMatch) {
          throw new Error(`Filename pattern, phase, bindingId, and bindingKind mismatch.`);
        }
        
        // 3. Validate (pipelineId, stageId) exists and resolves to that same binding
        if (meta.pipelineId) {
          const pipeline = manifest.pipelines?.[meta.pipelineId];
          if (!pipeline) {
            throw new Error(`Pipeline '${meta.pipelineId}' not found in manifest.`);
          }
          const stage = pipeline.stages.find(s => s.stageId === meta.stageId);
          if (!stage) {
            throw new Error(`Stage '${meta.stageId}' not found in pipeline '${meta.pipelineId}'.`);
          }
          const boundBindingId = stage.loop ?? stage.task;
          const boundBindingKind = stage.loop ? 'loop' : 'task';
          if (boundBindingId !== meta.bindingId || boundBindingKind !== meta.bindingKind) {
            throw new Error(`Stage '${meta.stageId}' maps to ${boundBindingKind} '${boundBindingId}', but front matter has '${meta.bindingId}'.`);
          }
          
          // 4. Require pipeline-start to be the configured first stage
          if (meta.chainMode === 'pipeline-start') {
            const firstStage = pipeline.stages[0];
            if (!firstStage || firstStage.stageId !== meta.stageId) {
              throw new Error(`Stage '${meta.stageId}' is not the first stage in pipeline '${meta.pipelineId}'.`);
            }
          }
        }
      }

      const patternInfo = classifiedMeta.status === 'classified'
        ? matchingPatterns.find((candidate) => parsedMeta.bindingId === candidate.bindingId && parsedMeta.bindingKind === candidate.bindingKind)
          ?? (matchingPatterns.length === 1 ? matchingPatterns[0] : undefined)
        : matchingPatterns[0];
      if (!patternInfo) continue;
      const meta = parsedMeta;
      const mtime = lstatSync(file).mtimeMs;

      const step: Step = {
        kind: meta.kind,
        skillId: meta.skill,
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
        sessionStrategy: meta.sessionStrategy,
        provider,
      };

      const classification = classifiedMeta;
      if (classification.status !== 'classified') {
        step.unclassified = true;
        step.contractValid = false;
        step.unclassifiedReason = classification.reason || 'Unclassified: does not satisfy current provenance contract.';
        const bindingSteps = byBinding.get(patternInfo.bindingId) ?? [];
        bindingSteps.push(step);
        byBinding.set(patternInfo.bindingId, bindingSteps);
        steps.push(step);
        unclassified.push(step);
        continue;
      }

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
        step.unclassifiedReason = 'Output contract validation failed.';
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
    } catch (err: any) {
      const patternInfo = matchingPatterns[0]!;
      const mtime = existsSync(file) ? lstatSync(file).mtimeMs : Date.now();
      const step: Step = {
        kind: patternInfo.phase,
        bindingId: patternInfo.bindingId,
        bindingKind: patternInfo.bindingKind,
        role: roleForKind(patternInfo.phase),
        agent: provider,
        model: 'unknown',
        version,
        status: 'done',
        artifactPath: file,
        mtime,
        unclassified: true,
        unclassifiedReason: err.message ?? 'Artifact identity verification failed.',
        contractValid: false,
        provider,
      };
      const bindingId = patternInfo.bindingId;
      const bindingSteps = byBinding.get(bindingId) ?? [];
      bindingSteps.push(step);
      byBinding.set(bindingId, bindingSteps);
      steps.push(step);
      unclassified.push(step);
    }
  }

  // 5 & 6. Fixpoint structural validation pass for pipeline lineage
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (step.unclassified) continue;
      
      let invalidReason = '';
      
      // 5. Require a stage-continuation root to point to a classified, completed artifact from expectedPredecessor(...) in the same pipeline run
      if (step.pipelineId && step.chainMode === 'stage-continuation') {
        const parentId = step.parentArtifactIdentity;
        const parent = steps.find(s => s.artifactIdentity === parentId && !s.unclassified);
        const predStage = expectedPredecessor(step.pipelineId, step.stageId!, manifest);
        
        if (!parentId) {
          invalidReason = `stage-continuation is missing parentArtifactIdentity.`;
        } else if (!parent) {
          invalidReason = `stage-continuation parent artifact '${parentId}' not found or is unclassified.`;
        } else {
          const isParentCompleted = parent.decision === 'accepted' ||
            parent.completionOutcome === 'completed' ||
            (parent.contractValid === true && parent.decision === undefined && parent.completionOutcome === undefined);
            
          if (
            parent.pipelineId !== step.pipelineId ||
            parent.pipelineRunId !== step.pipelineRunId ||
            parent.stageId !== predStage ||
            !isParentCompleted
          ) {
            invalidReason = `stage-continuation parent artifact '${parentId}' is in a different pipeline/run/stage, or is not completed.`;
          }
        }
      }
      
      // 6. Keep exact immediate-parent validation for subsequent same-chain artifacts
      if (step.parentArtifactIdentity !== null && step.chainMode !== 'stage-continuation') {
        const parentId = step.parentArtifactIdentity;
        const parent = steps.find(s => s.artifactIdentity === parentId && !s.unclassified);
        
        if (!parent || parent.chainId !== step.chainId) {
          invalidReason = `Same-chain parent artifact '${parentId}' not found or has mismatched chainId.`;
        }
      }
      
      if (invalidReason) {
        step.unclassified = true;
        step.contractValid = false;
        step.unclassifiedReason = invalidReason;
        step.decision = undefined;
        step.completionOutcome = undefined;
        step.verdict = undefined;
        step.outcome = undefined;
        if (!unclassified.includes(step)) {
          unclassified.push(step);
        }
        changed = true;
      }
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
        current.unclassifiedReason = 'Chain lineage invalid: parent artifact identity mismatch.';
        current.decision = undefined;
        current.completionOutcome = undefined;
        current.verdict = undefined;
        current.outcome = undefined;
        if (!unclassified.includes(current)) unclassified.push(current);
      }
    }
  }
  unclassified.sort((a, b) => a.mtime - b.mtime);

  const interruptedMarker = readInterruptedMarker(projectRoot);
  return { steps, byBinding, unclassified, missingInputs, inputAvailability, interruptedMarker };
}
