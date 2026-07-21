import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanGlobalSnapshot } from '../src/artifact-index.js';
import { computeArtifactIdentity } from '../src/pipeline-state.js';
import { buildFrontMatter, type ArtifactMeta } from '../src/provenance.js';
import type { V1Manifest } from '../src/manifest.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('Artifact Index and Pipeline Lineage Structural Validation (C1)', () => {
  const testDir = join(process.cwd(), '.test-artifact-validation-temp');

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
    roles: { reviewer: 'roles/reviewer.md', implementer: 'roles/implementer.md' },
    skills: {
      evaluate: { file: 'skills/eval.md', role: 'reviewer', runnerProfile: 'default' },
      repair: { file: 'skills/rep.md', role: 'implementer', runnerProfile: 'default' },
    },
    loops: {
      loopA: {
        type: 'approval-loop',
        target: { path: '.', kind: 'worktree' },
        inputs: [],
        evaluate: {
          skill: 'evaluate',
          output: {
            pattern: 'docs/dev/loopA-eval-v{version}-{provider}.md',
            contract: 'decision-artifact',
            decision: { heading: 'Decision', accepted: 'APPROVED', retry: 'REJECTED' },
          },
        },
        repair: {
          skill: 'repair',
          output: {
            pattern: 'docs/dev/loopA-rep-v{version}-{provider}.md',
            contract: 'completion-artifact',
          },
        },
      },
      loopB: {
        type: 'approval-loop',
        target: { path: '.', kind: 'worktree' },
        inputs: [],
        evaluate: {
          skill: 'evaluate',
          output: {
            pattern: 'docs/dev/loopB-eval-v{version}-{provider}.md',
            contract: 'decision-artifact',
            decision: { heading: 'Decision', accepted: 'APPROVED', retry: 'REJECTED' },
          },
        },
        repair: {
          skill: 'repair',
          output: {
            pattern: 'docs/dev/loopB-rep-v{version}-{provider}.md',
            contract: 'completion-artifact',
          },
        },
      },
    },
    tasks: {},
    pipelines: {
      pipeA: {
        stages: [
          { stageId: 'stage1', loop: 'loopA' },
          { stageId: 'stage2', loop: 'loopB' },
        ],
      },
    },
  };

  function createValidMeta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
    const base: ArtifactMeta = {
      schemaVersion: 1,
      bindingKind: 'loop',
      bindingId: 'loopA',
      chainId: 'chain-123',
      chainMode: 'pipeline-start',
      version: 1,
      kind: 'evaluate',
      step: 'evaluate',
      provider: 'fake',
      agent: 'fake',
      model: 'fake-model',
      sessionStrategy: 'fresh-per-invocation',
      sessionMode: 'fresh',
      sessionId: 'sess-123',
      parentArtifactIdentity: null,
      pipelineId: 'pipeA',
      pipelineRunId: 'run-999',
      stageId: 'stage1',
      inputFingerprint: 'inf-abc',
      resultFingerprint: 'res-xyz',
      loop: 'loopA',
      skill: 'evaluate',
      role: 'reviewer',
      target: '.',
      priorAudit: 'none',
      timestamp: new Date().toISOString(),
    };
    const merged = { ...base, ...overrides };
    merged.artifactIdentity = computeArtifactIdentity({
      schemaVersion: merged.schemaVersion!,
      pipelineId: merged.pipelineId ?? null,
      pipelineRunId: merged.pipelineRunId ?? null,
      stageId: merged.stageId ?? null,
      bindingKind: merged.bindingKind!,
      bindingId: merged.bindingId!,
      chainId: merged.chainId!,
      chainMode: merged.chainMode!,
      step: merged.step ?? merged.kind!,
      version: merged.version!,
      provider: merged.provider!,
      model: merged.model!,
      effort: merged.effort,
      sessionMode: merged.sessionMode,
      sessionId: merged.sessionId,
      parentArtifactIdentity: merged.parentArtifactIdentity ?? null,
      inputFingerprint: merged.inputFingerprint!,
      resultFingerprint: merged.resultFingerprint!,
    });
    return merged;
  }

  it('1. accepts a perfectly matching, correct artifact', () => {
    const meta = createValidMeta();
    const content = buildFrontMatter(meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(0);
    expect(snapshot.steps.length).toBe(1);
    expect(snapshot.steps[0]!.unclassified).toBeFalsy();
  });

  it('2. tampered digest: rejects artifact with tampered artifactIdentity', () => {
    const meta = createValidMeta();
    meta.artifactIdentity = 'tampered-hash-value'; // forged hash
    const content = buildFrontMatter(meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(1);
    expect(snapshot.unclassified[0]!.artifactPath).toContain('loopA-eval-v1-fake.md');
  });

  it('3. foreign binding: rejects artifact claiming different loop in same pattern', () => {
    const meta = createValidMeta({ bindingId: 'loopB' }); // LoopB inside LoopA's filename pattern
    const content = buildFrontMatter(meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(1);
  });

  it('4. wrong stage: rejects pipeline artifact claiming unbound stageId', () => {
    const meta = createValidMeta({ stageId: 'stage2' }); // stage2 is bound to loopB, not loopA
    const content = buildFrontMatter(meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(1);
  });

  it('5. forged pipeline start: rejects pipeline-start that is not the configured first stage', () => {
    const meta = createValidMeta({
      bindingId: 'loopB',
      stageId: 'stage2',
      chainMode: 'pipeline-start',
    });
    const content = buildFrontMatter(meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopB-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(1);
  });

  it('6. wrong run / uncompleted parent: stage-continuation must point to completed predecessor in same run', () => {
    // 1. First stage completed
    const firstMeta = createValidMeta();
    const firstContent = buildFrontMatter(firstMeta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), firstContent);

    // 2. Second stage continuation pointing to wrong run
    const secondMeta = createValidMeta({
      bindingId: 'loopB',
      stageId: 'stage2',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: firstMeta.artifactIdentity,
      pipelineRunId: 'run-DIFF', // wrong pipeline run ID
    });
    const secondContent = buildFrontMatter(secondMeta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopB-eval-v1-fake.md'), secondContent);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    // LoopB-eval-v1-fake.md must be unclassified because parent run-999 doesn't match run-DIFF
    const unclassPaths = snapshot.unclassified.map(s => s.artifactPath);
    expect(unclassPaths.some(p => p.includes('loopB-eval-v1-fake.md'))).toBe(true);
  });

  it('7. non-immediate parent: rejects same-chain steps with mismatched chainId', () => {
    const firstMeta = createValidMeta();
    const firstContent = buildFrontMatter(firstMeta) + '# Evaluation\n\n## Decision\n\nREJECTED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), firstContent);

    const secondMeta = createValidMeta({
      kind: 'repair',
      step: 'repair',
      version: 1,
      parentArtifactIdentity: firstMeta.artifactIdentity,
      chainId: 'chain-DIFF', // mismatched chain ID
    });
    const secondContent = buildFrontMatter(secondMeta) + '# Repair\n\n## Outcome\n\nCOMPLETED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-rep-v1-fake.md'), secondContent);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    const unclassPaths = snapshot.unclassified.map(s => s.artifactPath);
    expect(unclassPaths.some(p => p.includes('loopA-rep-v1-fake.md'))).toBe(true);
  });
});
