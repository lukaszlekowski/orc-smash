import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanGlobalSnapshot } from '../src/artifact-index.js';
import { buildProjectSnapshotView } from '../src/project-snapshot-view.js';
import { computeArtifactIdentity } from '../src/pipeline-state.js';
import { artifactRecordFromStep, pipelineStageCandidates } from '../src/pipeline-stage-state.js';
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
    tasks: {
      completedTask: {
        skill: 'evaluate',
        target: { path: '.', kind: 'worktree' },
        inputs: [],
        output: {
          pattern: 'docs/dev/completed-task-v{version}-{provider}.md',
          contract: 'completion-artifact',
        },
      },
      completedSink: {
        skill: 'evaluate',
        target: { path: '.', kind: 'worktree' },
        inputs: [],
        output: {
          pattern: 'docs/dev/completed-sink-v{version}-{provider}.md',
          contract: 'completion-artifact',
        },
      },
      requiredTask: {
        skill: 'evaluate',
        target: { path: '.', kind: 'worktree' },
        inputs: [],
        output: {
          pattern: 'docs/dev/required-task-v{version}-{provider}.md',
          contract: 'required-artifact',
        },
      },
      requiredSink: {
        skill: 'evaluate',
        target: { path: '.', kind: 'worktree' },
        inputs: [],
        output: {
          pattern: 'docs/dev/required-sink-v{version}-{provider}.md',
          contract: 'required-artifact',
        },
      },
    },
    pipelines: {
      pipeA: {
        stages: [
          { stageId: 'stage1', loop: 'loopA' },
          { stageId: 'stage2', loop: 'loopB' },
          { stageId: 'stage3', loop: 'loopA' },
        ],
      },
      completedTaskPipe: {
        stages: [
          { stageId: 'completed-task-stage', task: 'completedTask' },
          { stageId: 'completed-sink-stage', task: 'completedSink' },
        ],
      },
      requiredTaskPipe: {
        stages: [
          { stageId: 'required-task-stage', task: 'requiredTask' },
          { stageId: 'required-sink-stage', task: 'requiredSink' },
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

  it('2. tampered digest: rejects artifact with cause-specific unclassifiedReason', () => {
    const meta = createValidMeta();
    meta.artifactIdentity = 'tampered-hash-value'; // forged hash
    const content = buildFrontMatter(meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(1);
    expect(snapshot.unclassified[0]!.artifactPath).toContain('loopA-eval-v1-fake.md');
    expect(snapshot.unclassified[0]!.unclassifiedReason).toContain('Artifact identity digest verification failed');
  });

  it('3. foreign binding: rejects artifact claiming different loop in same pattern with cause-specific reason', () => {
    const meta = createValidMeta({ bindingId: 'loopB' }); // LoopB inside LoopA's filename pattern
    const content = buildFrontMatter(meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(1);
    expect(snapshot.unclassified[0]!.unclassifiedReason).toContain('Filename pattern, phase, bindingId, and bindingKind mismatch');
  });

  it('4. wrong stage: rejects pipeline artifact claiming unbound stageId with cause-specific reason', () => {
    const meta = createValidMeta({ stageId: 'stage2' }); // stage2 is bound to loopB, not loopA
    const content = buildFrontMatter(meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(1);
    expect(snapshot.unclassified[0]!.unclassifiedReason).toContain("maps to loop 'loopB', but front matter has 'loopA'");
  });

  it('5. forged pipeline start: rejects pipeline-start that is not the configured first stage with cause-specific reason', () => {
    const meta = createValidMeta({
      bindingId: 'loopB',
      stageId: 'stage2',
      chainMode: 'pipeline-start',
    });
    const content = buildFrontMatter(meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopB-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(1);
    expect(snapshot.unclassified[0]!.unclassifiedReason).toContain("Stage 'stage2' is not the first stage in pipeline 'pipeA'");
  });

  it('6. wrong run / uncompleted parent: stage-continuation must point to completed predecessor in same run with cause-specific reason', () => {
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
    const target = snapshot.unclassified.find(s => s.artifactPath.includes('loopB-eval-v1-fake.md'));
    expect(target).toBeDefined();
    expect(target!.unclassifiedReason).toContain('is in a different pipeline/run/stage');
  });

  it('7. non-immediate parent: rejects same-chain steps with mismatched chainId with cause-specific reason', () => {
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
    const target = snapshot.unclassified.find(s => s.artifactPath.includes('loopA-rep-v1-fake.md'));
    expect(target).toBeDefined();
    expect(target!.unclassifiedReason).toContain('mismatched chainId');
  });

  it('8. contract failure: rejects decision artifact missing required decision section with cause-specific reason', () => {
    const meta = createValidMeta();
    const content = buildFrontMatter(meta) + '# Evaluation\n\nNo decision heading here.\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(1);
    expect(snapshot.unclassified[0]!.unclassifiedReason).toContain('Output contract validation failed');
  });

  it('9. pipeline-start chain rescan: root has null parent, descendants have immediate parent; all 3 remain classified with complete preserved provenance, status resolution, and stage eligibility', () => {
    const eval1Meta = createValidMeta({
      kind: 'evaluate',
      step: 'evaluate',
      version: 1,
      chainId: 'chain-pip-100',
      pipelineId: 'pipeA',
      pipelineRunId: 'run-pip-100',
      stageId: 'stage1',
      chainMode: 'pipeline-start',
      parentArtifactIdentity: null,
      provider: 'fake',
      agent: 'fake',
      model: 'fake-model',
      effort: 'medium',
      sessionStrategy: 'resume-per-skill',
      sessionMode: 'fresh',
      sessionId: 'sess-1',
      durationMs: 1200,
    });
    const eval1Content = buildFrontMatter(eval1Meta) + '# Evaluation\n\n## Decision\n\nREJECTED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), eval1Content);

    const rep1Meta = createValidMeta({
      kind: 'repair',
      step: 'repair',
      version: 1,
      chainId: 'chain-pip-100',
      pipelineId: 'pipeA',
      pipelineRunId: 'run-pip-100',
      stageId: 'stage1',
      chainMode: 'pipeline-start',
      parentArtifactIdentity: eval1Meta.artifactIdentity,
      provider: 'fake',
      agent: 'fake',
      model: 'fake-model',
      effort: 'high',
      sessionStrategy: 'fresh-per-invocation',
      sessionMode: 'fresh',
      sessionId: 'sess-2',
      durationMs: 2300,
    });
    const rep1Content = buildFrontMatter(rep1Meta) + '# Repair\n\n## Outcome\n\nCOMPLETED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-rep-v1-fake.md'), rep1Content);

    const eval2Meta = createValidMeta({
      kind: 'evaluate',
      step: 'evaluate',
      version: 2,
      chainId: 'chain-pip-100',
      pipelineId: 'pipeA',
      pipelineRunId: 'run-pip-100',
      stageId: 'stage1',
      chainMode: 'pipeline-start',
      parentArtifactIdentity: rep1Meta.artifactIdentity,
      provider: 'fake',
      agent: 'fake',
      model: 'fake-model',
      effort: 'medium',
      sessionStrategy: 'resume-per-skill',
      sessionMode: 'resumed',
      sessionId: 'sess-3',
      durationMs: 1500,
    });
    const eval2Content = buildFrontMatter(eval2Meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v2-fake.md'), eval2Content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(0);
    const loopASteps = snapshot.byBinding.get('loopA') ?? [];
    expect(loopASteps.length).toBe(3);
    const classifiedSteps = loopASteps.filter(s => !s.unclassified);
    expect(classifiedSteps.length).toBe(3);

    // 1. Verify complete preserved provenance for root (eval1)
    expect(classifiedSteps[0]!.parentArtifactIdentity).toBeNull();
    expect(classifiedSteps[0]!.provider).toBe('fake');
    expect(classifiedSteps[0]!.agent).toBe('fake');
    expect(classifiedSteps[0]!.model).toBe('fake-model');
    expect(classifiedSteps[0]!.effort).toBe('medium');
    expect(classifiedSteps[0]!.sessionStrategy).toBe('resume-per-skill');
    expect(classifiedSteps[0]!.sessionMode).toBe('fresh');
    expect(classifiedSteps[0]!.sessionId).toBe('sess-1');
    expect(classifiedSteps[0]!.durationMs).toBe(1200);
    expect(classifiedSteps[0]!.chainId).toBe('chain-pip-100');
    expect(classifiedSteps[0]!.pipelineId).toBe('pipeA');
    expect(classifiedSteps[0]!.pipelineRunId).toBe('run-pip-100');
    expect(classifiedSteps[0]!.stageId).toBe('stage1');
    expect(classifiedSteps[0]!.decision).toBe('retry');

    // 2. Verify descendant repair (rep1) provenance and outcome
    expect(classifiedSteps[1]!.parentArtifactIdentity).toBe(eval1Meta.artifactIdentity);
    expect(classifiedSteps[1]!.provider).toBe('fake');
    expect(classifiedSteps[1]!.effort).toBe('high');
    expect(classifiedSteps[1]!.sessionStrategy).toBe('fresh-per-invocation');
    expect(classifiedSteps[1]!.sessionMode).toBe('fresh');
    expect(classifiedSteps[1]!.sessionId).toBe('sess-2');
    expect(classifiedSteps[1]!.durationMs).toBe(2300);
    expect(classifiedSteps[1]!.chainId).toBe('chain-pip-100');
    expect(classifiedSteps[1]!.completionOutcome).toBe('completed');

    // 3. Verify final evaluate (eval2) provenance and decision
    expect(classifiedSteps[2]!.parentArtifactIdentity).toBe(rep1Meta.artifactIdentity);
    expect(classifiedSteps[2]!.version).toBe(2);
    expect(classifiedSteps[2]!.sessionMode).toBe('resumed');
    expect(classifiedSteps[2]!.sessionId).toBe('sess-3');
    expect(classifiedSteps[2]!.durationMs).toBe(1500);
    expect(classifiedSteps[2]!.chainId).toBe('chain-pip-100');
    expect(classifiedSteps[2]!.decision).toBe('accepted');

    // 4. Verify snapshot view status resolution & candidate eligibility
    const testConfig = {
      projectRoot: testDir,
      manifestPath: join(testDir, 'config/orc-smash.yaml'),
      manifestRoot: testDir,
      manifest,
      registry: { providers: {} },
    } as any;
    const view = buildProjectSnapshotView(testConfig, snapshot);
    const loopABindingView = view.bindings.find(b => b.bindingId === 'loopA');
    expect(loopABindingView).toBeDefined();
    expect(loopABindingView!.latestEvaluate?.step.decision).toBe('accepted');
    expect(loopABindingView!.latestRepair?.step.completionOutcome).toBe('completed');
  });

  it('10. forged pipeline-start root: rejects pipeline-start root claiming non-null parent identity when no predecessor exists', () => {
    const meta = createValidMeta({
      kind: 'evaluate',
      step: 'evaluate',
      version: 1,
      chainMode: 'pipeline-start',
      parentArtifactIdentity: 'forged-parent-id',
    });
    const content = buildFrontMatter(meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(1);
    expect(snapshot.unclassified[0]!.unclassifiedReason).toBeDefined();
    expect(snapshot.unclassified[0]!.unclassifiedReason).toContain('not found or has mismatched chainId');
  });

  it('11. pipeline-start first stage root: rejects pipeline-start first stage root specifying parentArtifactIdentity when no predecessor exists', () => {
    const meta = createValidMeta({
      kind: 'evaluate',
      step: 'evaluate',
      version: 1,
      pipelineId: 'pipeA',
      pipelineRunId: 'run-pipe-100',
      stageId: 'stage1',
      chainMode: 'pipeline-start',
      parentArtifactIdentity: 'unresolvable-parent-identity-12345',
    });
    const content = buildFrontMatter(meta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n';
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), content);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.length).toBe(1);
    expect(snapshot.unclassified[0]!.unclassifiedReason).toContain('not found or has mismatched chainId');
  });

  it('12. stage continuation accepts only an accepted loop predecessor, not completed repair', () => {
    const evalMeta = createValidMeta({ chainId: 'retry-chain', pipelineRunId: 'run-repair-parent', resultFingerprint: 'target' });
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), buildFrontMatter(evalMeta) + '# Evaluation\n\n## Decision\n\nREJECTED\n');
    const repairMeta = createValidMeta({
      kind: 'repair',
      step: 'repair',
      chainId: 'retry-chain',
      pipelineRunId: 'run-repair-parent',
      parentArtifactIdentity: evalMeta.artifactIdentity,
      resultFingerprint: 'target',
    });
    writeFileSync(join(testDir, 'docs/dev/loopA-rep-v1-fake.md'), buildFrontMatter(repairMeta) + '# Repair\n\n## Outcome\n\nCOMPLETED\n');
    const successorMeta = createValidMeta({
      bindingId: 'loopB',
      stageId: 'stage2',
      chainId: 'successor-chain',
      chainMode: 'stage-continuation',
      pipelineRunId: 'run-repair-parent',
      parentArtifactIdentity: repairMeta.artifactIdentity,
      resultFingerprint: 'target',
    });
    writeFileSync(join(testDir, 'docs/dev/loopB-eval-v1-fake.md'), buildFrontMatter(successorMeta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n');

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    const successor = snapshot.unclassified.find(step => step.artifactPath.includes('loopB-eval-v1-fake.md'));
    expect(successor).toBeDefined();
    expect(successor!.unclassifiedReason).toContain('not completion-capable');
  });

  it('13. a valid historical successor survives later independent chain activity', () => {
    const acceptedMeta = createValidMeta({ chainId: 'accepted-chain', pipelineRunId: 'run-history', resultFingerprint: 'target' });
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), buildFrontMatter(acceptedMeta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n');
    const successorMeta = createValidMeta({
      bindingId: 'loopB',
      stageId: 'stage2',
      chainId: 'successor-history-chain',
      chainMode: 'stage-continuation',
      pipelineRunId: 'run-history',
      parentArtifactIdentity: acceptedMeta.artifactIdentity,
      resultFingerprint: 'target',
    });
    writeFileSync(join(testDir, 'docs/dev/loopB-eval-v1-fake.md'), buildFrontMatter(successorMeta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n');
    const laterOpinion = createValidMeta({
      version: 2,
      chainId: 'independent-opinion-chain',
      pipelineRunId: 'run-history',
      resultFingerprint: 'target',
    });
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v2-fake.md'), buildFrontMatter(laterOpinion) + '# Evaluation\n\n## Decision\n\nREJECTED\n');

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.unclassified.some(step => step.artifactPath.includes('loopB-eval-v1-fake.md'))).toBe(false);
    expect(snapshot.steps.find(step => step.artifactPath.includes('loopB-eval-v1-fake.md'))?.unclassified).toBeFalsy();
  });

  it('14. stage-continuation loop repair cycles remain classified and unlock their next stage', () => {
    const firstMeta = createValidMeta({
      bindingId: 'loopA',
      pipelineRunId: 'run-loop-successor',
      stageId: 'stage1',
      chainId: 'source-chain',
      resultFingerprint: 'loopA-state',
    });
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), buildFrontMatter(firstMeta) + '# Evaluation\n\n## Decision\n\nAPPROVED\n');

    const successorEval1 = createValidMeta({
      bindingId: 'loopB',
      kind: 'evaluate',
      step: 'evaluate',
      pipelineRunId: 'run-loop-successor',
      stageId: 'stage2',
      chainId: 'successor-loop-chain',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: firstMeta.artifactIdentity,
      resultFingerprint: 'loopB-state',
    });
    writeFileSync(join(testDir, 'docs/dev/loopB-eval-v1-fake.md'), buildFrontMatter(successorEval1) + '# Evaluation\n\n## Decision\n\nREJECTED\n');

    const successorRepair = createValidMeta({
      bindingId: 'loopB',
      kind: 'repair',
      step: 'repair',
      pipelineRunId: 'run-loop-successor',
      stageId: 'stage2',
      chainId: 'successor-loop-chain',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: successorEval1.artifactIdentity,
      resultFingerprint: 'loopB-state',
    });
    writeFileSync(join(testDir, 'docs/dev/loopB-rep-v1-fake.md'), buildFrontMatter(successorRepair) + '# Repair\n\n## Outcome\n\nCOMPLETED\n');

    const successorEval2 = createValidMeta({
      bindingId: 'loopB',
      kind: 'evaluate',
      step: 'evaluate',
      version: 2,
      pipelineRunId: 'run-loop-successor',
      stageId: 'stage2',
      chainId: 'successor-loop-chain',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: successorRepair.artifactIdentity,
      resultFingerprint: 'loopB-state',
    });
    writeFileSync(join(testDir, 'docs/dev/loopB-eval-v2-fake.md'), buildFrontMatter(successorEval2) + '# Evaluation\n\n## Decision\n\nAPPROVED\n');

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    const successorSteps = snapshot.byBinding.get('loopB') ?? [];
    expect(snapshot.unclassified).toHaveLength(0);
    expect(successorSteps).toHaveLength(3);
    expect(successorSteps.every(step => !step.unclassified)).toBe(true);

    const candidates = pipelineStageCandidates(
      snapshot.steps.map(artifactRecordFromStep),
      manifest,
      new Map([['pipeA:stage2', 'loopB-state']]),
    );
    expect(candidates.find(candidate => candidate.artifactIdentity === successorEval2.artifactIdentity)).toEqual(expect.objectContaining({
      artifactIdentity: successorEval2.artifactIdentity,
      successorStageId: 'stage3',
      reason: 'eligible',
    }));
  });

  it('15. completed-task and valid-required-task successors remain historically classified', () => {
    const completedRoot = createValidMeta({
      bindingKind: 'task',
      bindingId: 'completedTask',
      kind: 'task',
      step: 'task',
      pipelineId: 'completedTaskPipe',
      pipelineRunId: 'run-completed-task',
      stageId: 'completed-task-stage',
      chainMode: 'pipeline-start',
      parentArtifactIdentity: null,
    });
    writeFileSync(join(testDir, 'docs/dev/completed-task-v1-fake.md'), buildFrontMatter(completedRoot) + '# Task\n\n## Outcome\n\nCOMPLETED\n');
    const completedSuccessor = createValidMeta({
      bindingKind: 'task',
      bindingId: 'completedSink',
      kind: 'task',
      step: 'task',
      pipelineId: 'completedTaskPipe',
      pipelineRunId: 'run-completed-task',
      stageId: 'completed-sink-stage',
      chainId: 'completed-successor-chain',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: completedRoot.artifactIdentity,
    });
    writeFileSync(join(testDir, 'docs/dev/completed-sink-v1-fake.md'), buildFrontMatter(completedSuccessor) + '# Task\n\n## Outcome\n\nCOMPLETED\n');

    const requiredRoot = createValidMeta({
      bindingKind: 'task',
      bindingId: 'requiredTask',
      kind: 'task',
      step: 'task',
      pipelineId: 'requiredTaskPipe',
      pipelineRunId: 'run-required-task',
      stageId: 'required-task-stage',
      chainMode: 'pipeline-start',
      parentArtifactIdentity: null,
    });
    writeFileSync(join(testDir, 'docs/dev/required-task-v1-fake.md'), buildFrontMatter(requiredRoot) + '# Required task ledger\n');
    const requiredSuccessor = createValidMeta({
      bindingKind: 'task',
      bindingId: 'requiredSink',
      kind: 'task',
      step: 'task',
      pipelineId: 'requiredTaskPipe',
      pipelineRunId: 'run-required-task',
      stageId: 'required-sink-stage',
      chainId: 'required-successor-chain',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: requiredRoot.artifactIdentity,
    });
    writeFileSync(join(testDir, 'docs/dev/required-sink-v1-fake.md'), buildFrontMatter(requiredSuccessor) + '# Required sink ledger\n');

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.steps.filter(step => step.pipelineId === 'completedTaskPipe' || step.pipelineId === 'requiredTaskPipe')
      .every(step => !step.unclassified)).toBe(true);
  });

  it('16. target drift suppresses new candidates without rewriting historical lineage', () => {
    const accepted = createValidMeta({
      bindingId: 'loopA',
      pipelineRunId: 'run-target-drift',
      stageId: 'stage1',
      chainId: 'target-drift-chain',
      resultFingerprint: 'recorded-before-edit',
    });
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), buildFrontMatter(accepted) + '# Evaluation\n\n## Decision\n\nAPPROVED\n');
    const snapshot = scanGlobalSnapshot(testDir, manifest);
    const candidates = pipelineStageCandidates(
      snapshot.steps.map(artifactRecordFromStep),
      manifest,
      new Map([['pipeA:stage1', 'current-after-edit']]),
    );

    expect(snapshot.steps[0]!.unclassified).toBeFalsy();
    expect(candidates.find(candidate => candidate.artifactIdentity === accepted.artifactIdentity)).toMatchObject({
      reason: 'target-fingerprint-drift',
      stale: true,
    });
    expect(snapshot.steps[0]!.unclassified).toBeFalsy();
  });

  it('17. rejects a stage-continuation root whose same-stage parent belongs to another chain', () => {
    const predecessor = createValidMeta({
      bindingId: 'loopA',
      pipelineRunId: 'run-same-stage-root',
      stageId: 'stage1',
      chainId: 'predecessor-chain',
      resultFingerprint: 'predecessor-state',
    });
    writeFileSync(join(testDir, 'docs/dev/loopA-eval-v1-fake.md'), buildFrontMatter(predecessor) + '# Evaluation\n\n## Decision\n\nAPPROVED\n');

    const sameStageParent = createValidMeta({
      bindingId: 'loopB',
      pipelineRunId: 'run-same-stage-root',
      stageId: 'stage2',
      chainId: 'valid-successor-chain',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: predecessor.artifactIdentity,
      resultFingerprint: 'successor-state',
    });
    writeFileSync(join(testDir, 'docs/dev/loopB-eval-v1-fake.md'), buildFrontMatter(sameStageParent) + '# Evaluation\n\n## Decision\n\nAPPROVED\n');

    const malformedRoot = createValidMeta({
      bindingId: 'loopB',
      pipelineRunId: 'run-same-stage-root',
      stageId: 'stage2',
      version: 2,
      chainId: 'malformed-root-chain',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: sameStageParent.artifactIdentity,
      resultFingerprint: 'malformed-root-state',
    });
    writeFileSync(join(testDir, 'docs/dev/loopB-eval-v2-fake.md'), buildFrontMatter(malformedRoot) + '# Evaluation\n\n## Decision\n\nAPPROVED\n');

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    const malformed = snapshot.steps.find(step => step.artifactIdentity === malformedRoot.artifactIdentity);
    expect(malformed?.unclassified).toBe(true);
    expect(malformed?.unclassifiedReason).toContain('is in a different pipeline/run/stage');
  });
});
