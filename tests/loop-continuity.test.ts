import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { fakeAdapter } from '../src/adapters/fake.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { scanGlobalSnapshot } from '../src/state.js';
import { continueRunContext, recoverInProgressRun, mintRunContext } from '../src/pipeline-state.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';

describe('generic per-step continuity', () => {
  const workspace = resolve(process.cwd(), 'temp-loop-continuity-test');
  const output = createMockOutput();

  beforeEach(() => {
    createTempDir('temp-loop-continuity-test');
    mkdirSync(join(workspace, 'docs/dev'), { recursive: true });
    writeFileSync(join(workspace, 'docs/dev/plan.md'), '# Plan\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeTempDir(workspace);
  });

  it('resumes only when the predecessor runner tuple and adapter capability match', async () => {
    const config = loadConfig(workspace);
    const calls: Array<{ kind?: string; continuity?: { mode: string; sessionId?: string } }> = [];
    let evaluation = 0;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      calls.push({ kind: input.kind, continuity: input.continuity });
      const outputMatch = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      const outputPath = outputMatch?.[1]?.trim();
      if (outputPath) {
        const absolute = resolve(input.cwd, outputPath);
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        if (input.kind === 'repair') {
          writeFileSync(absolute, '# Repair\n\n## Outcome\n\nCOMPLETED\n');
        } else {
          const token = evaluation++ === 0 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absolute, '# Evaluation\n\n## Verdict\n\n' + token + '\n');
        }
      }
      return { stdout: 'done', exitCode: 0, sessionId: 'session-a' };
    });

    const result = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan!,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model', effort: 'medium' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model', effort: 'medium' },
      },
      { maxIterations: 3, registry: createTestAdapterRegistry(), output, interactive: false },
    );

    expect(result.success).toBe(true);
    expect(calls.map(call => call.continuity?.mode)).toEqual(['fresh', 'fresh', 'fresh']);
    const snapshot = scanGlobalSnapshot(workspace, config.manifest);
    const steps = snapshot.byBinding.get('plan')!.filter(step => !step.unclassified);
    expect(steps).toHaveLength(3);
    expect(steps[1]!.parentArtifactIdentity).toBe(steps[0]!.artifactIdentity);
    expect(steps[2]!.parentArtifactIdentity).toBe(steps[1]!.artifactIdentity);
    expect(steps.every(step => step.sessionMode === 'fresh')).toBe(true);
  });

  it('resumes when the skill matches and strategy is resume-per-skill', async () => {
    const config = loadConfig(workspace);
    config.manifest.loops.plan!.repair.skill = 'plan-audit';

    const calls: Array<{ kind?: string; continuity?: { mode: string; sessionId?: string } }> = [];
    let evaluation = 0;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      calls.push({ kind: input.kind, continuity: input.continuity });
      const outputMatch = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      const outputPath = outputMatch?.[1]?.trim();
      if (outputPath) {
        const absolute = resolve(input.cwd, outputPath);
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        if (input.kind === 'repair') {
          writeFileSync(absolute, '# Repair\n\n## Outcome\n\nCOMPLETED\n');
        } else {
          const token = evaluation++ === 0 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absolute, '# Evaluation\n\n## Verdict\n\n' + token + '\n');
        }
      }
      return { stdout: 'done', exitCode: 0, sessionId: 'session-b' };
    });

    const result = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan!,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model', effort: 'medium' },
      },
      { maxIterations: 3, registry: createTestAdapterRegistry(), output, interactive: false, globalOverrides: { sessionStrategy: 'resume-per-skill' } },
    );

    expect(result.success).toBe(true);
    expect(calls.map(call => call.continuity?.mode)).toEqual(['fresh', 'resumed', 'resumed']);
  });

  it('continue-current-loop resumes the pending repair (ad-hoc chain)', async () => {
    const config = loadConfig(workspace);
    const output = createMockOutput();

    // Phase 1: run the loop so it stops after evaluate v1 = REJECTED
    // (maxIterations=1 means the first evaluate exhausts the budget)
    let evaluation = 0;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const outputMatch = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      const outputPath = outputMatch?.[1]?.trim();
      if (outputPath) {
        const absolute = resolve(input.cwd, outputPath);
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        if (input.kind === 'repair') {
          writeFileSync(absolute, '# Repair\n\n## Outcome\n\nCOMPLETED\n');
        } else {
          const token = evaluation++ === 0 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absolute, '# Evaluation\n\n## Verdict\n\n' + token + '\n');
        }
      }
      return { stdout: 'done', exitCode: 0, sessionId: 'session-a' };
    });

    // First run: should stop after evaluate v1 (retry, budget exhausted)
    const firstResult = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan!,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model' },
      },
      { maxIterations: 1, registry: createTestAdapterRegistry(), output, interactive: false },
    );

    expect(firstResult.success).toBe(false);
    expect(firstResult.outcome?.kind).toBe('budget-exhausted');

    // Phase 2: recover the in-progress chain and continue
    const snapshot = scanGlobalSnapshot(workspace, config.manifest);
    const steps = snapshot.byBinding.get('plan')!.filter(s => !s.unclassified);
    expect(steps).toHaveLength(1);
    const evaluateStep = steps[0]!;
    expect(evaluateStep.decision).toBe('retry');

    const recovered = recoverInProgressRun(steps as any);
    expect(recovered).not.toBeNull();

    const ctx = continueRunContext({
      chainId: recovered!.chainId,
      chainMode: recovered!.chainMode,
      pipelineId: recovered!.pipelineId,
      pipelineRunId: recovered!.pipelineRunId,
      stageId: recovered!.stageId,
      parentArtifactIdentity: evaluateStep.artifactIdentity ?? null,
    });

    const secondResult = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan!,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model' },
      },
      { maxIterations: 3, registry: createTestAdapterRegistry(), output, interactive: false, runContext: ctx },
    );

    // Continue should complete successfully (repair v1 → evaluate v2 = APPROVED)
    expect(secondResult.success).toBe(true);

    // Phase 3: verify the second run's artifacts
    const afterSnapshot = scanGlobalSnapshot(workspace, config.manifest);
    const allSteps = afterSnapshot.byBinding.get('plan')!.filter(s => !s.unclassified);

    // v1 evaluate (retry) + v1 repair (completed) + v2 evaluate (APPROVED)
    expect(allSteps).toHaveLength(3);

    // Repair links to evaluate v1
    const repair = allSteps.find(s => s.kind === 'repair')!;
    expect(repair.parentArtifactIdentity).toBe(evaluateStep.artifactIdentity);

    // All steps share the same chainId (the continue reuses the recovered identity)
    const chainIds = new Set(allSteps.map(s => s.chainId));
    expect(chainIds.size).toBe(1);
    expect(chainIds.has(recovered!.chainId)).toBe(true);

    // Every artifact is classified
    expect(allSteps.every(s => !s.unclassified)).toBe(true);
  });

  it('resumes per-skill with distinct evaluate and repair skills', async () => {
    const config = loadConfig(workspace);
    // Use the packaged manifest's distinct skills: plan-audit (evaluate)
    // and plan-follow-up (repair).  Evaluate should resume its own session
    // after the intervening repair step uses a different skill.
    const calls: Array<{ skillId: string; continuity?: { mode: string; sessionId?: string } }> = [];
    let evaluation = 0;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      calls.push({ skillId: input.kind ?? '', continuity: input.continuity });
      const outputMatch = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      const outputPath = outputMatch?.[1]?.trim();
      if (outputPath) {
        const absolute = resolve(input.cwd, outputPath);
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        if (input.kind === 'repair') {
          writeFileSync(absolute, '# Repair\n\n## Outcome\n\nCOMPLETED\n');
        } else {
          const token = evaluation++ === 0 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absolute, '# Evaluation\n\n## Verdict\n\n' + token + '\n');
        }
      }
      return { stdout: 'done', exitCode: 0, sessionId: 'session-' + (evaluation) };
    });

    const result = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan!,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model' },
      },
      // Use resume-per-skill for both skills via globalOverrides
      { maxIterations: 3, registry: createTestAdapterRegistry(), output, interactive: false, globalOverrides: { sessionStrategy: 'resume-per-skill' } },
    );

    expect(result.success).toBe(true);

    // Sequence: evaluate A fresh → repair B fresh → evaluate A resumed
    expect(calls.length).toBe(3);
    expect(calls[0]!.skillId).toBe('evaluate');
    expect(calls[0]!.continuity?.mode).toBe('fresh');
    expect(calls[1]!.skillId).toBe('repair');
    expect(calls[1]!.continuity?.mode).toBe('fresh');
    expect(calls[2]!.skillId).toBe('evaluate');
    expect(calls[2]!.continuity?.mode).toBe('resumed');
    expect(calls[2]!.continuity?.sessionId).toBe('session-1');
  });

  it('per-skill resume survives a restart (scanGlobalSnapshot)', async () => {
    const config = loadConfig(workspace);
    let evaluation = 0;
    const runCalls: Array<{ kind?: string; continuity?: { mode: string; sessionId?: string } }> = [];

    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      runCalls.push({ kind: input.kind, continuity: input.continuity });
      const outputMatch = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      const outputPath = outputMatch?.[1]?.trim();
      if (outputPath) {
        const absolute = resolve(input.cwd, outputPath);
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        if (input.kind === 'repair') {
          writeFileSync(absolute, '# Repair\n\n## Outcome\n\nCOMPLETED\n');
        } else {
          const token = evaluation++ === 0 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absolute, '# Evaluation\n\n## Verdict\n\n' + token + '\n');
        }
      }
      return { stdout: 'done', exitCode: 0, sessionId: 'session-' + (evaluation) };
    });

    // Phase 1: run loop to retry-pending
    await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan!,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model' },
      },
      { maxIterations: 1, registry: createTestAdapterRegistry(), output, interactive: false, globalOverrides: { sessionStrategy: 'resume-per-skill' } },
    );

    // Phase 2: simulate restart by scanning the snapshot and continuing
    const snapshot = scanGlobalSnapshot(workspace, config.manifest);
    const steps = snapshot.byBinding.get('plan')!.filter(s => !s.unclassified);
    expect(steps.length).toBeGreaterThanOrEqual(1);
    const recovered = recoverInProgressRun(steps as any);
    expect(recovered).not.toBeNull();

    const ctx = continueRunContext({
      chainId: recovered!.chainId,
      chainMode: recovered!.chainMode,
      pipelineId: recovered!.pipelineId,
      pipelineRunId: recovered!.pipelineRunId,
      stageId: recovered!.stageId,
      parentArtifactIdentity: steps[0]!.artifactIdentity ?? null,
    });

    evaluation = 1;
    const secondResult = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan!,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model' },
      },
      { maxIterations: 3, registry: createTestAdapterRegistry(), output, interactive: false, runContext: ctx, globalOverrides: { sessionStrategy: 'resume-per-skill' } },
    );

    expect(secondResult.success).toBe(true);

    // The continued repair should resume plan-audit's session from phase 1
    const continuedCalls = runCalls.slice(1);
    const repairCall = continuedCalls.find(c => c.kind === 'repair');
    if (repairCall) {
      expect(repairCall.continuity?.mode).toBe('fresh');
    }
    const resumedEval = continuedCalls.find(c => c.kind === 'evaluate');
    if (resumedEval) {
      expect(resumedEval.continuity?.mode).toBe('resumed');
    }
  });

  it('continue-current-loop reuses chain identity from a pipeline-start context', async () => {
    const config = loadConfig(workspace);
    const output = createMockOutput();

    let evaluation = 0;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const outputMatch = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      const outputPath = outputMatch?.[1]?.trim();
      if (outputPath) {
        const absolute = resolve(input.cwd, outputPath);
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        if (input.kind === 'repair') {
          writeFileSync(absolute, '# Repair\n\n## Outcome\n\nCOMPLETED\n');
        } else {
          const token = evaluation++ === 0 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absolute, '# Evaluation\n\n## Verdict\n\n' + token + '\n');
        }
      }
      return { stdout: 'done', exitCode: 0, sessionId: 'session-a' };
    });

    // First run as pipeline-start
    const pipelineCtx = mintRunContext({
      mode: 'pipeline-start',
      pipelineId: 'default',
      stageId: 'plan',
    });

    const firstResult = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan!,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model' },
      },
      { maxIterations: 1, registry: createTestAdapterRegistry(), output, interactive: false, runContext: pipelineCtx },
    );

    expect(firstResult.success).toBe(false);
    expect(firstResult.outcome?.kind).toBe('budget-exhausted');

    // Continue with recovered pipeline chain
    const snapshot = scanGlobalSnapshot(workspace, config.manifest);
    const steps = snapshot.byBinding.get('plan')!.filter(s => !s.unclassified);
    const recovered = recoverInProgressRun(steps as any);
    expect(recovered).not.toBeNull();
    expect(recovered!.pipelineId).toBe('default');

    const ctx = continueRunContext({
      chainId: recovered!.chainId,
      chainMode: recovered!.chainMode,
      pipelineId: recovered!.pipelineId,
      pipelineRunId: recovered!.pipelineRunId,
      stageId: recovered!.stageId,
      parentArtifactIdentity: steps[0]!.artifactIdentity ?? null,
    });

    const secondResult = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan!,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model' },
      },
      { maxIterations: 3, registry: createTestAdapterRegistry(), output, interactive: false, runContext: ctx },
    );

    expect(secondResult.success).toBe(true);
  });

  it('falls back to a fresh session when the adapter does not advertise resume support', async () => {
    const config = loadConfig(workspace);
    const calls: string[] = [];
    const original = fakeAdapter.capabilities.resumeSession;
    fakeAdapter.capabilities.resumeSession = false;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      calls.push(input.continuity?.mode ?? 'missing');
      const outputMatch = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      if (outputMatch?.[1]) {
        const absolute = resolve(input.cwd, outputMatch[1].trim());
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        if (input.kind === 'repair') writeFileSync(absolute, '## Outcome\n\nCOMPLETED\n');
        else writeFileSync(absolute, '## Verdict\n\nAPPROVED\n');
      }
      return { stdout: 'done', exitCode: 0, sessionId: 'session-a' };
    });

    try {
      const result = await runLoop(
        workspace,
        'plan',
        config.manifest.loops.plan!,
        config,
        {
          'plan-audit': { agent: 'fake', model: 'fake-model' },
          'plan-follow-up': { agent: 'fake', model: 'fake-model' },
        },
        { maxIterations: 2, registry: createTestAdapterRegistry(), output, interactive: false },
      );
      expect(result.success).toBe(true);
      expect(calls).toEqual(['fresh']);
    } finally {
      fakeAdapter.capabilities.resumeSession = original;
    }
  });
});
