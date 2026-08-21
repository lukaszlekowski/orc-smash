import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  adHocPriorCandidates,
  resolveDefaultPrior,
  validateExplicitPrior,
  predecessorBindingsForTask,
} from '../src/adhoc-prior.js';
import { buildFrontMatter } from '../src/provenance.js';
import { makeV1ArtifactMeta } from './helpers/v1-artifact.js';
import type { V1Manifest } from '../src/manifest.js';
import { captureBindingResultFingerprint } from '../src/target-snapshot.js';

describe('ad-hoc prior resolution (src/adhoc-prior.ts)', () => {
  const testDir = join(process.cwd(), '.test-adhoc-prior-temp');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'docs/dev'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const manifest: V1Manifest = {
    schemaVersion: 1,
    roles: { researcher: 'roles/researcher.md', planner: 'roles/planner.md' },
    skills: {
      research: { file: 'skills/research.md', role: 'researcher', runnerProfile: 'default' },
      plan: { file: 'skills/plan.md', role: 'planner', runnerProfile: 'default' },
    },
    loops: {
      research: {
        type: 'approval-loop',
        target: { path: 'docs/dev/research.md', kind: 'file' },
        inputs: [],
        evaluate: {
          skill: 'research',
          output: {
            pattern: 'docs/dev/research-audit-v{version}-{provider}.md',
            contract: 'decision-artifact',
            decision: { heading: 'Decision', accepted: 'APPROVED', retry: 'REJECTED' },
          },
        },
        repair: {
          skill: 'research',
          output: {
            pattern: 'docs/dev/research-followup-v{version}-{provider}.md',
            contract: 'completion-artifact',
          },
        },
      },
      secondaryResearch: {
        type: 'approval-loop',
        target: { path: 'docs/dev/secondary.md', kind: 'file' },
        files: { extraPath: 'docs/dev/extra.md' },
        inputs: [],
        evaluate: {
          skill: 'research',
          output: {
            pattern: 'docs/dev/secondary-audit-v{version}-{provider}.md',
            contract: 'decision-artifact',
            decision: { heading: 'Decision', accepted: 'APPROVED', retry: 'REJECTED' },
          },
        },
        repair: {
          skill: 'research',
          output: {
            pattern: 'docs/dev/secondary-followup-v{version}-{provider}.md',
            contract: 'completion-artifact',
          },
        },
      },
    },
    tasks: {
      'create-plan': {
        skill: 'plan',
        target: { path: '.', kind: 'worktree' },
        inputs: [{ source: 'target' }, { source: 'priorArtifact' }],
        output: {
          pattern: 'docs/dev/create-plan-v{version}-{provider}.md',
          contract: 'completion-artifact',
        },
      },
      'standalone-task': {
        skill: 'plan',
        target: { path: '.', kind: 'worktree' },
        inputs: [{ source: 'target' }],
        output: {
          pattern: 'docs/dev/standalone-v{version}-{provider}.md',
          contract: 'completion-artifact',
        },
      },
    },
    pipelines: {
      'research-first': {
        stages: [
          { stageId: 'research-stage', loop: 'research' },
          { stageId: 'plan-stage', task: 'create-plan' },
        ],
      },
      'secondary-pipeline': {
        stages: [
          { stageId: 'secondary-stage', loop: 'secondaryResearch' },
          { stageId: 'plan-stage-2', task: 'create-plan' },
        ],
      },
    },
  };

  it('resolves predecessor topology across multiple pipelines for a task', () => {
    const predecessors = predecessorBindingsForTask(manifest, 'create-plan');
    expect(predecessors).toEqual([
      { pipelineId: 'research-first', stageId: 'research-stage', bindingId: 'research', kind: 'loop' },
      { pipelineId: 'secondary-pipeline', stageId: 'secondary-stage', bindingId: 'secondaryResearch', kind: 'loop' },
    ]);

    expect(predecessorBindingsForTask(manifest, 'standalone-task')).toEqual([]);
  });

  it('selects chain-reduced accepted evaluate artifact across chains and handles REJECTED v1 -> APPROVED v2 chain', () => {
    writeFileSync(join(testDir, 'docs/dev/research.md'), '# Research Content\n');
    const fp = captureBindingResultFingerprint(testDir, manifest.loops.research.target, manifest.loops.research.files, manifest);

    // Chain 1: v1 rejected, v1 followup, v2 approved
    const chain1Id = 'chain-one';
    const v1Eval = makeV1ArtifactMeta({
      bindingId: 'research',
      kind: 'evaluate',
      step: 'evaluate',
      version: 1,
      chainId: chain1Id,
      chainMode: 'ad-hoc',
      resultFingerprint: fp,
    });
    writeFileSync(join(testDir, 'docs/dev/research-audit-v1-fake.md'), buildFrontMatter(v1Eval) + '# Audit\n\n## Decision\n\nREJECTED\n');

    const v1Rep = makeV1ArtifactMeta({
      bindingId: 'research',
      kind: 'repair',
      step: 'repair',
      version: 1,
      chainId: chain1Id,
      chainMode: 'ad-hoc',
      parentArtifactIdentity: v1Eval.artifactIdentity,
      resultFingerprint: fp,
    });
    writeFileSync(join(testDir, 'docs/dev/research-followup-v1-fake.md'), buildFrontMatter(v1Rep) + '# Followup\n\n## Outcome\n\nCOMPLETED\n');

    const v2Eval = makeV1ArtifactMeta({
      bindingId: 'research',
      kind: 'evaluate',
      step: 'evaluate',
      version: 2,
      chainId: chain1Id,
      chainMode: 'ad-hoc',
      parentArtifactIdentity: v1Rep.artifactIdentity,
      resultFingerprint: fp,
    });
    writeFileSync(join(testDir, 'docs/dev/research-audit-v2-fake.md'), buildFrontMatter(v2Eval) + '# Audit\n\n## Decision\n\nAPPROVED\n');

    const candidates = adHocPriorCandidates(testDir, manifest, 'create-plan');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.artifactIdentity).toBe(v2Eval.artifactIdentity);
    expect(candidates[0]!.version).toBe(2);
    expect(candidates[0]!.freshness).toBe('fresh');
    expect(candidates[0]!.verdict).toBe('accepted');
  });

  it('correctly classifies freshness: fresh, drifted, or missing-fingerprint', () => {
    writeFileSync(join(testDir, 'docs/dev/research.md'), '# Initial Research\n');
    const initialFp = captureBindingResultFingerprint(testDir, manifest.loops.research.target, manifest.loops.research.files, manifest);

    const freshMeta = makeV1ArtifactMeta({
      bindingId: 'research',
      kind: 'evaluate',
      step: 'evaluate',
      version: 1,
      chainId: 'chain-fresh',
      chainMode: 'ad-hoc',
      resultFingerprint: initialFp,
    });
    writeFileSync(join(testDir, 'docs/dev/research-audit-v1-fake.md'), buildFrontMatter(freshMeta) + '# Audit\n\n## Decision\n\nAPPROVED\n');

    let candidates = adHocPriorCandidates(testDir, manifest, 'create-plan');
    expect(candidates[0]!.freshness).toBe('fresh');

    // Modify research.md -> drifted
    writeFileSync(join(testDir, 'docs/dev/research.md'), '# Drifted Research\n');
    candidates = adHocPriorCandidates(testDir, manifest, 'create-plan');
    expect(candidates[0]!.freshness).toBe('drifted');

    // Delete research.md -> drifted / missing target
    rmSync(join(testDir, 'docs/dev/research.md'));
    candidates = adHocPriorCandidates(testDir, manifest, 'create-plan');
    expect(candidates[0]!.freshness).toBe('drifted');
  });

  it('classifies a predecessor with missing declared file inputs as missing-input, not drifted', () => {
    writeFileSync(join(testDir, 'docs/dev/secondary.md'), '# Secondary Research\n');
    writeFileSync(join(testDir, 'docs/dev/extra.md'), '# Extra Dependency\n');
    const fp = captureBindingResultFingerprint(testDir, manifest.loops.secondaryResearch.target, manifest.loops.secondaryResearch.files, manifest);

    const meta = makeV1ArtifactMeta({
      bindingId: 'secondaryResearch',
      kind: 'evaluate',
      step: 'evaluate',
      version: 1,
      chainId: 'chain-secondary',
      chainMode: 'ad-hoc',
      resultFingerprint: fp,
    });
    writeFileSync(join(testDir, 'docs/dev/secondary-audit-v1-fake.md'), buildFrontMatter(meta) + '# Audit\n\n## Decision\n\nAPPROVED\n');

    // Remove a declared file input: the composite fingerprint can no longer be
    // recomputed at all, which is a missing input, not target drift.
    rmSync(join(testDir, 'docs/dev/extra.md'));

    const candidates = adHocPriorCandidates(testDir, manifest, 'create-plan');
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.freshness).toBe('missing-input');
    expect(candidates[0]!.targetFingerprintNow).toBeNull();
    expect(resolveDefaultPrior(candidates)).toBeNull();
  });

  it('resolveDefaultPrior returns the newest fresh candidate or null when all are drifted', () => {
    writeFileSync(join(testDir, 'docs/dev/research.md'), '# Research\n');
    const fp = captureBindingResultFingerprint(testDir, manifest.loops.research.target, manifest.loops.research.files, manifest);

    const candidate1 = makeV1ArtifactMeta({
      bindingId: 'research',
      kind: 'evaluate',
      step: 'evaluate',
      version: 1,
      chainId: 'c1',
      chainMode: 'ad-hoc',
      resultFingerprint: fp,
    });
    writeFileSync(join(testDir, 'docs/dev/research-audit-v1-fake.md'), buildFrontMatter(candidate1) + '# Audit\n\n## Decision\n\nAPPROVED\n');

    let candidates = adHocPriorCandidates(testDir, manifest, 'create-plan');
    expect(resolveDefaultPrior(candidates)?.artifactIdentity).toBe(candidate1.artifactIdentity);

    // Edit research.md to drift it
    writeFileSync(join(testDir, 'docs/dev/research.md'), '# Modified Research\n');
    candidates = adHocPriorCandidates(testDir, manifest, 'create-plan');
    expect(resolveDefaultPrior(candidates)).toBeNull();
  });

  it('validateExplicitPrior validates path and fails closed on invalid path, non-existent, non-fresh, or invalid task', () => {
    expect(validateExplicitPrior(testDir, manifest, 'standalone-task', 'any/path')).toEqual({
      valid: false,
      error: "Task 'standalone-task' has no pipeline predecessors; --prior is not applicable.",
    });

    expect(validateExplicitPrior(testDir, manifest, 'create-plan', 'non/existent/path.md')).toEqual({
      valid: false,
      error: "Specified --prior artifact 'non/existent/path.md' does not exist.",
    });

    writeFileSync(join(testDir, 'docs/dev/research.md'), '# Research\n');
    const fp = captureBindingResultFingerprint(testDir, manifest.loops.research.target, manifest.loops.research.files, manifest);

    const validMeta = makeV1ArtifactMeta({
      bindingId: 'research',
      kind: 'evaluate',
      step: 'evaluate',
      version: 1,
      chainId: 'c-valid',
      chainMode: 'ad-hoc',
      resultFingerprint: fp,
    });
    const artifactRel = 'docs/dev/research-audit-v1-fake.md';
    writeFileSync(join(testDir, artifactRel), buildFrontMatter(validMeta) + '# Audit\n\n## Decision\n\nAPPROVED\n');

    const validResult = validateExplicitPrior(testDir, manifest, 'create-plan', artifactRel);
    expect(validResult.valid).toBe(true);
    if (validResult.valid) {
      expect(validResult.candidate.artifactIdentity).toBe(validMeta.artifactIdentity);
    }

    // When drifted
    writeFileSync(join(testDir, 'docs/dev/research.md'), '# Modified Research After Acceptance\n');
    const driftedResult = validateExplicitPrior(testDir, manifest, 'create-plan', artifactRel);
    expect(driftedResult.valid).toBe(false);
    if (!driftedResult.valid) {
      expect(driftedResult.error).toContain('is not fresh');
    }
  });
});
