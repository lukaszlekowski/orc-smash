import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArtifactMeta, parseArtifactMetaClassified, type StepKind } from './provenance.js';
import { patternToRegex } from './patterns.js';
import type { V1Manifest } from './manifest.js';
import { classifyArtifact } from './artifact-contract.js';
import { validateImplementLedger } from './implement-ledger.js';
import type { Step, GlobalSnapshot } from './state.js';

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

  function walk(currentDir: string): void {
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
      const mtime = lstatSync(file).mtimeMs;

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
      // ignore parse errors
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
