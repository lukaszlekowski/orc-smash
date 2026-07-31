import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop, runTask } from '../../src/loop.js';
import { loadConfig } from '../../src/config.js';
import { fakeAdapter, fakeAdapterState } from '../../src/adapters/fake.js';
import { createTestAdapterRegistry, resetFakeAdapterState } from '../../src/adapters/testing.js';
import { createMockOutput } from '../helpers/mock-output.js';
import { pipelineSuggestions, allPipelineCandidates } from '../../src/next-step.js';
import { completionEvidenceForStage } from '../../src/pipeline-stage-state.js';
import { mintRunContext } from '../../src/pipeline-state.js';
import { scanGlobalSnapshot } from '../../src/artifact-index.js';
import { writeArtifactWithMeta } from '../../src/provenance.js';
import { makeV1ArtifactMeta } from '../helpers/v1-artifact.js';
import { captureTargetFingerprint } from '../../src/target-snapshot.js';
import type { TaskBinding } from '../../src/manifest.js';

const project = resolve(process.cwd(), 'temp-batch8-cutover');
const output = createMockOutput();

function runners(): Record<string, { agent: string; model: string }> {
  return {
    '23-simple-create-plan': { agent: 'fake', model: 'fake-model' },
    '24-simple-create-spec': { agent: 'fake', model: 'fake-model' },
    'plan-audit': { agent: 'fake', model: 'fake-model' },
    'plan-follow-up': { agent: 'fake', model: 'fake-model' },
    '30-simple-implement': { agent: 'fake', model: 'fake-model' },
  };
}

function options() {
  return {
    maxIterations: 4,
    registry: createTestAdapterRegistry(),
    output,
    interactive: false,
  };
}

/** The pre-Batch-8 implement binding shape: planPath only, no specPath. */
function legacyImplementBinding(): TaskBinding {
  return {
    skill: '30-simple-implement',
    target: { path: '.', kind: 'worktree' },
    files: { planPath: 'docs/dev/plan.md' },
    inputs: [
      { source: 'planPath' },
      { source: 'version' },
      { source: 'priorArtifact' },
      { source: 'outputPath' },
    ],
    output: { pattern: 'docs/dev/impl-v{version}-{provider}.md', contract: 'required-artifact', validator: 'implement-ledger' },
  };
}

describe('Batch 8 cutover: blocked first slice, create-spec migration, joint approval, second slice', () => {
  beforeEach(() => {
    rmSync(project, { recursive: true, force: true });
    mkdirSync(join(project, 'docs/dev'), { recursive: true });
    writeFileSync(join(project, 'docs/dev/plan.md'), '---\nstatus: ready\nconfidence: 0.98\n---\n\n# Legacy plan\n');
    resetFakeAdapterState();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(project, { recursive: true, force: true });
  });

  it('runs the discrete cutover sequence with zero nested provider runs and a distinct accepted joint edge', async () => {
    const config = loadConfig(project);
    const originalRun = fakeAdapter.run;
    const providerCalls: string[] = [];
    const capturedPrompts: string[] = [];
    vi.spyOn(fakeAdapter, 'run').mockImplementation(function (input: Parameters<typeof fakeAdapter.run>[0]) {
      providerCalls.push(input.skillId ?? 'unknown');
      capturedPrompts.push(input.prompt);
      return originalRun.call(fakeAdapter, input);
    });

    // ---- Step 1: legacy plan-only acceptance with a pre-Batch-8
    // target-only result fingerprint. ----
    const legacyFingerprint = captureTargetFingerprint(project, config.manifest.loops.plan!.target, config.manifest);
    const legacyMeta = makeV1ArtifactMeta({
      bindingId: 'plan',
      bindingKind: 'loop',
      kind: 'evaluate',
      pipelineId: 'default',
      pipelineRunId: 'legacy-run',
      stageId: 'plan',
      chainId: 'legacy-chain',
      chainMode: 'pipeline-start',
      resultFingerprint: legacyFingerprint,
    });
    writeArtifactWithMeta(
      join(project, 'docs/dev/plan-audit-v1-fake.md'),
      '# Plan Audit\n\n## Verdict\n\nAPPROVED\n',
      legacyMeta,
    );

    // ---- Step 2: first implementation invocation from the accepted legacy
    // plan edge, composed with the legacy binding the running subprocess
    // started with. It ends with a structurally valid blocked ledger whose
    // exact remaining blocker is `fresh joint plan approval required`. ----
    fakeAdapterState.implementLedgerBlocked = 'fresh joint plan approval required';
    const firstImpl = await runTask(
      project,
      'implement',
      legacyImplementBinding(),
      config,
      runners(),
      {
        ...options(),
        runContext: mintRunContext({
          mode: 'stage-continuation',
          pipelineId: 'default',
          pipelineRunId: 'legacy-run',
          stageId: 'implement',
          parentArtifactIdentity: legacyMeta.artifactIdentity,
        }),
      },
    );
    expect(firstImpl.success).toBe(false);
    expect(firstImpl.outcome?.kind).toBe('blocked');
    const ledger = readFileSync(join(project, 'docs/dev/impl-v1-fake.md'), 'utf8');
    expect(ledger).toContain('fresh joint plan approval required');

    const afterFirstImpl = scanGlobalSnapshot(project, config.manifest);
    const blockedStep = afterFirstImpl.steps.find(step => step.bindingId === 'implement');
    expect(blockedStep).toMatchObject({ contractValid: true, unclassified: false, completionOutcome: 'blocked' });
    // A blocked ledger is durable terminal evidence: it never unlocks review.
    expect(pipelineSuggestions(project, config.manifest)).toEqual([]);
    expect(completionEvidenceForStage(
      afterFirstImpl.steps.map(step => ({
        artifactIdentity: step.artifactIdentity ?? '',
        bindingKind: (step.bindingKind ?? 'task') as 'loop' | 'task',
        bindingId: step.bindingId ?? '',
        phase: step.kind,
        contract: step.contract ?? 'completion-artifact',
        normalizedResult: step.decision === 'accepted' ? 'accepted' : (step.completionOutcome as any) ?? 'unknown',
        contractValid: step.contractValid === true,
        unclassified: step.unclassified === true,
        pipelineId: step.pipelineId ?? null,
        pipelineRunId: step.pipelineRunId ?? null,
        stageId: step.stageId ?? null,
        chainId: step.chainId ?? '',
        chainMode: step.chainMode as any,
        parentArtifactIdentity: step.parentArtifactIdentity ?? null,
        resultFingerprint: step.resultFingerprint ?? '',
        artifactPath: step.artifactPath,
        version: step.version,
        decision: step.decision,
        completionOutcome: step.completionOutcome,
      })),
      'default',
      'review',
      config.manifest,
    )).toEqual([]);

    // ---- Step 3: separate operator invocation of the ordinary create-spec
    // task. It requires only planPath and remains available while the
    // plan/implement/review actions are disabled by missing-input preflight.
    // The plan bytes are preserved byte-for-byte. ----
    const planBefore = readFileSync(join(project, 'docs/dev/plan.md'), 'utf8');
    const createSpec = await runTask(
      project,
      'create-spec',
      config.manifest.tasks?.['create-spec']!,
      config,
      runners(),
      options(),
    );
    expect(createSpec.success).toBe(true);
    expect(existsSync(join(project, 'docs/dev/spec.md'))).toBe(true);
    expect(readFileSync(join(project, 'docs/dev/plan.md'), 'utf8')).toBe(planBefore);
    const specContent = readFileSync(join(project, 'docs/dev/spec.md'), 'utf8');
    expect(specContent).toContain('sourceKind: plan-bootstrap');
    expect(specContent).toContain('sourceArtifactIdentity: none');
    expect(readFileSync(join(project, 'docs/dev/create-spec-v1-fake.md'), 'utf8')).toContain('## Outcome\n\nCOMPLETED');

    // After migration, the legacy target-only approval can neither unlock
    // implement nor a fresh review: the first blocked slice consumed the
    // legacy edge, and a blocked ledger is never completion evidence. Only a
    // fresh joint approval can open the implement stage.
    const legacyPlanCandidate = allPipelineCandidates(project, config.manifest)
      .find(item => item.predecessorStageId === 'plan');
    expect(legacyPlanCandidate).toMatchObject({ reason: 'exact-edge-consumed' });
    expect(legacyPlanCandidate?.evidence.decision).toBe('accepted');
    const consumedBy = legacyPlanCandidate?.evidence.consumedByArtifactIdentity;
    expect(consumedBy).toBe(blockedStep?.artifactIdentity);
    // The blocked first ledger is not completion-capable for the implement
    // stage, so no review candidate can descend from it.
    expect(completionEvidenceForStage(
      scanGlobalSnapshot(project, config.manifest).steps.map(step => ({
        artifactIdentity: step.artifactIdentity ?? '',
        bindingKind: (step.bindingKind ?? 'task') as 'loop' | 'task',
        bindingId: step.bindingId ?? '',
        phase: step.kind,
        contract: step.contract ?? 'completion-artifact',
        normalizedResult: step.decision === 'accepted' ? 'accepted' : (step.completionOutcome as any) ?? 'unknown',
        contractValid: step.contractValid === true,
        unclassified: step.unclassified === true,
        pipelineId: step.pipelineId ?? null,
        pipelineRunId: step.pipelineRunId ?? null,
        stageId: step.stageId ?? null,
        chainId: step.chainId ?? '',
        chainMode: step.chainMode as any,
        parentArtifactIdentity: step.parentArtifactIdentity ?? null,
        resultFingerprint: step.resultFingerprint ?? '',
        artifactPath: step.artifactPath,
        version: step.version,
        decision: step.decision,
        completionOutcome: step.completionOutcome,
      })),
      'default',
      'implement',
      config.manifest,
    )).toEqual([]);
    expect(pipelineSuggestions(project, config.manifest)).toEqual([]);

    // The create-spec completion is idempotent after evidence removal and
    // never regenerates or replaces the published spec.
    rmSync(join(project, 'docs/dev/create-spec-v1-fake.md'));
    const specAfterEvidenceRemoval = readFileSync(join(project, 'docs/dev/spec.md'), 'utf8');
    const rerunSpec = await runTask(
      project,
      'create-spec',
      config.manifest.tasks?.['create-spec']!,
      config,
      runners(),
      options(),
    );
    expect(rerunSpec.success).toBe(true);
    expect(readFileSync(join(project, 'docs/dev/spec.md'), 'utf8')).toBe(specAfterEvidenceRemoval);
    expect(readFileSync(join(project, 'docs/dev/plan.md'), 'utf8')).toBe(planBefore);
    expect(readFileSync(join(project, 'docs/dev/create-spec-v1-fake.md'), 'utf8')).toContain('## Outcome\n\nCOMPLETED');

    // ---- Step 4: separate operator invocation of the now-joint plan loop.
    // The composite binding snapshot makes the target-only legacy approval
    // stale; the blocked implementation artifact is not approval evidence.
    // A distinct accepted joint edge is required. ----
    fakeAdapterState.verdicts = ['APPROVED'];
    const joint = await runLoop(
      project,
      'plan',
      config.manifest.loops.plan,
      config,
      runners(),
      { ...options(), runContext: mintRunContext({ mode: 'pipeline-start', pipelineId: 'default', stageId: 'plan' }) },
    );
    expect(joint.success).toBe(true);
    const jointAuditPath = joint.lastAuditPath!;
    expect(jointAuditPath).toContain('plan-audit-v2-fake.md');
    const jointStep = scanGlobalSnapshot(project, config.manifest).steps.find(step => step.artifactPath === jointAuditPath)!;
    expect(jointStep.artifactIdentity).not.toBe(legacyMeta.artifactIdentity);

    // The accepted joint edge unlocks exactly one implement candidate.
    const implementCandidate = pipelineSuggestions(project, config.manifest)
      .find(item => item.predecessorStageId === 'plan');
    expect(implementCandidate).toMatchObject({ successorStageId: 'implement', reason: 'eligible' });
    expect(implementCandidate?.artifactIdentity).toBe(jointStep.artifactIdentity);

    // ---- Step 5: second implementation invocation starts only from the
    // distinct accepted joint edge. The manifest edit (specPath wiring) was
    // installed before this subprocess: the prompt carries both absolute
    // document paths, and preflight passed with both present. ----
    fakeAdapterState.implementLedgerBlocked = undefined;
    const secondImpl = await runTask(
      project,
      'implement',
      config.manifest.tasks.implement,
      config,
      runners(),
      {
        ...options(),
        runContext: mintRunContext({
          mode: 'stage-continuation',
          pipelineId: implementCandidate!.pipelineId,
          pipelineRunId: implementCandidate!.pipelineRunId,
          stageId: 'implement',
          parentArtifactIdentity: implementCandidate!.artifactIdentity,
        }),
      },
    );
    expect(secondImpl.success).toBe(true);
    expect(secondImpl.outcome?.kind).toBe('completed');
    const secondPrompt = [...capturedPrompts].reverse().find(prompt => prompt.includes('# Skill: 30-simple-implement'))!;
    expect(secondPrompt).toContain(`Specification document: ${resolve(project, 'docs/dev/spec.md')}`);
    expect(secondPrompt).toContain(`Implementation plan document: ${resolve(project, 'docs/dev/plan.md')}`);
    const secondStep = scanGlobalSnapshot(project, config.manifest).steps
      .find(step => step.bindingId === 'implement' && step.contractValid === true && step.completionOutcome === undefined);
    expect(secondStep?.parentArtifactIdentity).toBe(jointStep.artifactIdentity);

    // Zero nested provider runs: exactly one call per harness invocation.
    expect(providerCalls).toEqual([
      '30-simple-implement', // first blocked slice
      '24-simple-create-spec', // migration
      '24-simple-create-spec', // idempotent evidence rerun
      'plan-audit', // joint approval
      '30-simple-implement', // second slice
    ]);
  }, 20_000);

  it('blocks create-spec on an unrelated pre-existing spec and preserves both documents', async () => {
    const config = loadConfig(project);
    const planBefore = readFileSync(join(project, 'docs/dev/plan.md'), 'utf8');
    writeFileSync(join(project, 'docs/dev/spec.md'), '# Unrelated pre-existing spec\n');
    const result = await runTask(
      project,
      'create-spec',
      config.manifest.tasks?.['create-spec']!,
      config,
      runners(),
      options(),
    );
    expect(result.success).toBe(false);
    expect(result.outcome?.kind).toBe('blocked');
    expect(readFileSync(join(project, 'docs/dev/spec.md'), 'utf8')).toBe('# Unrelated pre-existing spec\n');
    expect(readFileSync(join(project, 'docs/dev/plan.md'), 'utf8')).toBe(planBefore);
    expect(readFileSync(join(project, 'docs/dev/create-spec-v1-fake.md'), 'utf8')).toContain('## Outcome\n\nBLOCKED');
    expect(pipelineSuggestions(project, config.manifest)).toEqual([]);
  });

  it('keeps create-spec outside pipeline progression after a successful migration', async () => {
    const config = loadConfig(project);
    const result = await runTask(
      project,
      'create-spec',
      config.manifest.tasks?.['create-spec']!,
      config,
      runners(),
      options(),
    );
    expect(result.success).toBe(true);
    expect(scanGlobalSnapshot(project, config.manifest).steps.find(step => step.bindingId === 'create-spec'))
      .toMatchObject({ pipelineId: null, stageId: null });
    expect(pipelineSuggestions(project, config.manifest)).toEqual([]);
    expect(allPipelineCandidates(project, config.manifest)).toEqual([]);
  });
});
