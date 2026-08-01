import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { captureBindingResultFingerprint, captureFileDigests, captureTargetFingerprint } from '../src/target-snapshot.js';
import { buildBindingSnapshots } from '../src/next-step.js';
import { writeArtifactWithMeta } from '../src/provenance.js';
import { makeV1ArtifactMeta } from './helpers/v1-artifact.js';
import { pipelineSuggestions, allPipelineCandidates } from '../src/next-step.js';
import type { V1Manifest } from '../src/manifest.js';

const testDir = join(process.cwd(), 'temp-binding-snapshot-test');

const manifest: V1Manifest = {
  schemaVersion: 1,
  roles: { implementer: 'roles/implementer.md', auditor: 'roles/auditor.md' },
  skills: {
    implement: { file: 'skills/implementer.md', role: 'implementer', runnerProfile: 'implement' },
    audit: { file: 'skills/auditor.md', role: 'auditor', runnerProfile: 'audit' },
  },
  loops: {
    plan: {
      type: 'approval-loop',
      target: { path: 'docs/dev/plan.md', kind: 'file' },
      files: { specPath: 'docs/dev/spec.md' },
      inputs: [{ source: 'target' }, { source: 'specPath' }],
      evaluate: {
        skill: 'audit',
        output: { pattern: 'docs/dev/plan-audit-v{version}-{provider}.md', contract: 'decision-artifact', decision: { heading: 'Verdict', accepted: 'APPROVED', retry: 'REJECTED' } },
      },
      repair: {
        skill: 'implement',
        output: { pattern: 'docs/dev/plan-followup-v{version}-{provider}.md', contract: 'completion-artifact' },
      },
    },
  },
  tasks: {},
  pipelines: {
    default: {
      stages: [
        { stageId: 'plan', loop: 'plan' },
        { stageId: 'review', loop: 'plan' },
      ],
    },
  },
};

describe('composite binding result snapshot (Batch 8)', () => {
  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, 'docs/dev'), { recursive: true });
    writeFileSync(join(testDir, 'docs/dev/plan.md'), '# Plan\n');
    writeFileSync(join(testDir, 'docs/dev/spec.md'), '# Spec\n');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('is stable for unchanged values and sensitive to target or file edits', () => {
    const first = captureBindingResultFingerprint(testDir, manifest.loops.plan.target, manifest.loops.plan.files, manifest);
    const second = captureBindingResultFingerprint(testDir, manifest.loops.plan.target, manifest.loops.plan.files, manifest);
    expect(first).toBe(second);

    writeFileSync(join(testDir, 'docs/dev/spec.md'), '# Spec\n\nedited\n');
    const afterSpecEdit = captureBindingResultFingerprint(testDir, manifest.loops.plan.target, manifest.loops.plan.files, manifest);
    expect(afterSpecEdit).not.toBe(first);

    writeFileSync(join(testDir, 'docs/dev/spec.md'), '# Spec\n');
    const restored = captureBindingResultFingerprint(testDir, manifest.loops.plan.target, manifest.loops.plan.files, manifest);
    expect(restored).toBe(first);

    writeFileSync(join(testDir, 'docs/dev/plan.md'), '# Plan\n\nedited\n');
    expect(captureBindingResultFingerprint(testDir, manifest.loops.plan.target, manifest.loops.plan.files, manifest)).not.toBe(first);
  });

  it('serializes declared files in sorted canonical key order', () => {
    const filesA = { zeta: 'docs/dev/spec.md', alpha: 'docs/dev/plan.md' };
    const filesB = { alpha: 'docs/dev/plan.md', zeta: 'docs/dev/spec.md' };
    expect(captureBindingResultFingerprint(testDir, manifest.loops.plan.target, filesA, manifest))
      .toBe(captureBindingResultFingerprint(testDir, manifest.loops.plan.target, filesB, manifest));
    const keyOrder = Object.keys(captureFileDigests(testDir, filesA));
    expect(keyOrder).toEqual(['alpha', 'zeta']);
  });

  it('domain-separates the target from file dependencies', () => {
    writeFileSync(join(testDir, 'docs/dev/plan.md'), '# Plan\n');
    writeFileSync(join(testDir, 'docs/dev/spec.md'), '# Spec\n');

    // Same digest values in different roles (target vs declared file) must
    // produce different composites: the target segment and file segments are
    // domain-separated.
    const targetIsPlan = captureBindingResultFingerprint(
      testDir,
      manifest.loops.plan.target,
      { a: 'docs/dev/spec.md' },
      manifest,
    );
    const targetIsSpec = captureBindingResultFingerprint(
      testDir,
      { path: 'docs/dev/spec.md', kind: 'file' },
      { a: 'docs/dev/plan.md' },
      manifest,
    );
    expect(targetIsPlan).not.toBe(targetIsSpec);

    // File keys are position-sensitive: swapping which file backs which key
    // changes the composite despite the same sorted-key digest multiset.
    const swapA = captureBindingResultFingerprint(
      testDir,
      manifest.loops.plan.target,
      { a: 'docs/dev/spec.md', b: 'docs/dev/plan.md' },
      manifest,
    );
    const swapB = captureBindingResultFingerprint(
      testDir,
      manifest.loops.plan.target,
      { a: 'docs/dev/plan.md', b: 'docs/dev/spec.md' },
      manifest,
    );
    expect(swapA).not.toBe(swapB);
  });

  it('throws when a declared dependency is missing (result-time capture semantics)', () => {
    unlinkSync(join(testDir, 'docs/dev/spec.md'));
    expect(() => captureBindingResultFingerprint(testDir, manifest.loops.plan.target, manifest.loops.plan.files, manifest))
      .toThrow(/specPath/);
  });

  it('omits (does not crash) pipeline stages whose declared files are missing', () => {
    unlinkSync(join(testDir, 'docs/dev/spec.md'));
    const snapshots = buildBindingSnapshots(testDir, manifest);
    expect(snapshots.has('default:plan')).toBe(false);
    expect(allPipelineCandidates(testDir, manifest)).toEqual([]);
  });
});

describe('plan-stage eligibility regressions (Batch 8)', () => {
  const project = join(testDir, 'proj');

  beforeEach(() => {
    rmSync(project, { recursive: true, force: true });
    mkdirSync(join(project, 'docs/dev'), { recursive: true });
    writeFileSync(join(project, 'docs/dev/plan.md'), '# Plan\n');
    writeFileSync(join(project, 'docs/dev/spec.md'), '# Spec\n');
    writeFileSync(join(project, 'docs/dev/unrelated.md'), '# Unrelated\n');
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  function fingerprint(): string {
    return captureBindingResultFingerprint(project, manifest.loops.plan.target, manifest.loops.plan.files, manifest);
  }

  function acceptPlan(): string | undefined {
    const meta = makeV1ArtifactMeta({
      bindingId: 'plan',
      bindingKind: 'loop',
      kind: 'evaluate',
      pipelineId: 'default',
      pipelineRunId: 'snapshot-run',
      stageId: 'plan',
      chainId: 'snapshot-chain',
      chainMode: 'pipeline-start',
      resultFingerprint: fingerprint(),
    });
    writeArtifactWithMeta(
      join(project, 'docs/dev/plan-audit-v1-fake.md'),
      '# Plan Audit\n\n## Verdict\n\nAPPROVED\n',
      meta,
    );
    return meta.artifactIdentity;
  }

  it('keeps an accepted plan+spec eligible while both documents are unchanged', () => {
    acceptPlan();
    expect(pipelineSuggestions(project, manifest)).toHaveLength(1);
    expect(pipelineSuggestions(project, manifest)[0]).toMatchObject({ reason: 'eligible', successorStageId: 'review' });
  });

  it('stales accepted plan evidence when only spec.md changes; restoring the exact bytes restores eligibility', () => {
    acceptPlan();
    writeFileSync(join(project, 'docs/dev/spec.md'), '# Spec\n\nEdited acceptance contract.\n');
    expect(allPipelineCandidates(project, manifest)[0]).toMatchObject({ reason: 'target-fingerprint-drift' });
    expect(pipelineSuggestions(project, manifest)).toEqual([]);

    writeFileSync(join(project, 'docs/dev/spec.md'), '# Spec\n');
    expect(pipelineSuggestions(project, manifest)[0]).toMatchObject({ reason: 'eligible' });
  });

  it('does not stale a file-target plan stage when an unrelated file changes', () => {
    acceptPlan();
    writeFileSync(join(project, 'docs/dev/unrelated.md'), '# Unrelated\n\nchanged\n');
    expect(pipelineSuggestions(project, manifest)[0]).toMatchObject({ reason: 'eligible' });
  });

  it('fails closed with a missing current spec through the missing-fingerprint path', () => {
    acceptPlan();
    unlinkSync(join(project, 'docs/dev/spec.md'));
    expect(allPipelineCandidates(project, manifest)[0]).toMatchObject({ reason: 'missing-target-fingerprint' });
    expect(pipelineSuggestions(project, manifest)).toEqual([]);
  });

  it('does not accept a pre-Batch-8 target-only result fingerprint for the paired successor', () => {
    const legacyOnly = captureTargetFingerprint(project, manifest.loops.plan.target, manifest);
    const meta = makeV1ArtifactMeta({
      bindingId: 'plan',
      bindingKind: 'loop',
      kind: 'evaluate',
      pipelineId: 'default',
      pipelineRunId: 'legacy-run',
      stageId: 'plan',
      chainId: 'legacy-chain',
      chainMode: 'pipeline-start',
      resultFingerprint: legacyOnly,
    });
    writeArtifactWithMeta(
      join(project, 'docs/dev/plan-audit-v1-fake.md'),
      '# Plan Audit\n\n## Verdict\n\nAPPROVED\n',
      meta,
    );
    expect(legacyOnly).not.toBe(fingerprint());
    expect(allPipelineCandidates(project, manifest)[0]).toMatchObject({ reason: 'target-fingerprint-drift' });
    expect(pipelineSuggestions(project, manifest)).toEqual([]);
  });

  it('changes the pre-run input fingerprint when spec.md changes (separate from successor invalidation)', () => {
    const before = captureBindingResultFingerprint(project, manifest.loops.plan.target, manifest.loops.plan.files, manifest);
    writeFileSync(join(project, 'docs/dev/spec.md'), '# Spec\n\nedited input\n');
    const after = captureBindingResultFingerprint(project, manifest.loops.plan.target, manifest.loops.plan.files, manifest);
    expect(after).not.toBe(before);
    expect(existsSync(join(project, 'docs/dev/spec.md'))).toBe(true);
  });
});
