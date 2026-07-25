import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop, runTask } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { fakeAdapter } from '../src/adapters/fake.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';
import { scanGlobalSnapshot } from '../src/artifact-index.js';
import { artifactRecordFromStep, completionEvidenceForStage, validateContinuationParent } from '../src/pipeline-stage-state.js';
import type { RunEvent } from '../src/run-event.js';
import { parseArtifactMeta } from '../src/provenance.js';

describe('generic one-off task execution', () => {
  const tempWorkspace = resolve(process.cwd(), 'temp-loop-implement');
  const output = createMockOutput();

  beforeEach(() => {
    createTempDir('temp-loop-implement');
    mkdirSync(join(tempWorkspace, 'docs/dev'), { recursive: true });
    writeFileSync(join(tempWorkspace, 'docs/dev/plan.md'), '# Plan\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeTempDir(tempWorkspace);
  });

  function taskOptions(config: ReturnType<typeof loadConfig>) {
    return {
      maxIterations: 4,
      registry: createTestAdapterRegistry(),
      output,
      interactive: false,
      globalOverrides: { agent: 'fake', model: 'fake-model' },
    };
  }

  it('runs the configured task exactly once and stamps ad-hoc v1 provenance', async () => {
    const config = loadConfig(tempWorkspace);
    const task = config.manifest.tasks!.implement!;
    const result = await runTask(
      tempWorkspace,
      'implement',
      task,
      config,
      { '30-simple-implement': { agent: 'fake', model: 'fake-model' } },
      taskOptions(config),
    );

    expect(result.success).toBe(true);
    expect(result.outcome?.kind).toBe('completed');
    expect(result.lastAuditPath).toContain('impl-v1-fake.md');
    const artifact = readFileSync(result.lastAuditPath!, 'utf8');
    expect(artifact).toContain('kind: task');
    expect(artifact).toContain('step: task');
    expect(artifact).toContain('bindingKind: task');
    expect(artifact).toContain('pipelineId: null');
    expect(artifact).toContain('parentArtifactIdentity: null');
    expect(artifact).toContain('artifactIdentity:');
    expect(artifact).toContain('## Requirement Coverage');
  });

  it('does not advance when a required-artifact validator fails', async () => {
    const config = loadConfig(tempWorkspace);
    const task = config.manifest.tasks!.implement!;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const match = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      if (match?.[1]) {
        const path = resolve(input.cwd, match[1].trim());
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        writeFileSync(path, '# incomplete ledger\n');
      }
      return { stdout: 'done', exitCode: 0 };
    });

    const result = await runTask(
      tempWorkspace,
      'implement',
      task,
      config,
      { '30-simple-implement': { agent: 'fake', model: 'fake-model' } },
      taskOptions(config),
    );

    expect(result.success).toBe(false);
    expect(result.outcome?.kind).toBe('unknown');
    expect(result.message).toContain('invalid');
    expect(readFileSync(join(tempWorkspace, 'docs/dev/impl-v1-fake.md'), 'utf8')).not.toContain('schemaVersion: 1');
  });

  it('persists a structurally complete unresolved ledger as blocked evidence without successor eligibility', async () => {
    const config = loadConfig(tempWorkspace);
    const task = config.manifest.tasks!.implement!;
    const events: RunEvent[] = [];
    const blockedOutput = createMockOutput({ emit: (event: RunEvent) => events.push(event) });
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const match = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      if (match?.[1]) {
        const path = resolve(input.cwd, match[1].trim());
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        writeFileSync(path,
          '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n'
          + '| --- | --- | --- | --- | --- |\n'
          + '| Step 1 | src/x.ts | pnpm test | pending | none |\n\n'
          + '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n'
          + '| --- | --- | --- | --- |\n'
          + '| Req A | src/x.ts | tests/x.test.ts | pass |\n\n'
          + 'Confidence: 0.95\n');
      }
      return { stdout: 'done', exitCode: 0 };
    });

    const result = await runTask(
      tempWorkspace,
      'implement',
      task,
      config,
      { '30-simple-implement': { agent: 'fake', model: 'fake-model' } },
      { ...taskOptions(config), output: blockedOutput },
    );

    expect(result.success).toBe(false);
    expect(result.outcome?.kind).toBe('blocked');
    expect(events.find(event => event.type === 'artifact.verified')).toMatchObject({ type: 'artifact.verified', result: 'blocked' });
    expect(events.find(event => event.type === 'stage.blocked')).toMatchObject({ type: 'stage.blocked' });

    const snapshot = scanGlobalSnapshot(tempWorkspace, config.manifest);
    const step = snapshot.steps.find(item => item.bindingId === 'implement');
    expect(step).toMatchObject({ contractValid: true, unclassified: false, completionOutcome: 'blocked' });
    expect(step?.contractDiagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unresolved-row', table: 'evidence', rowLabel: 'Step 1' }),
    ]));

    const record = {
      ...artifactRecordFromStep(step!),
      pipelineId: 'default',
      pipelineRunId: 'run-1',
      stageId: 'implement',
    };
    expect(record.normalizedResult).toBe('blocked');
    expect(record.contractValid).toBe(true);
    expect(completionEvidenceForStage([record], 'default', 'implement', config.manifest)).toEqual([]);

    const child = {
      ...record,
      artifactIdentity: 'child',
      bindingKind: 'loop' as const,
      bindingId: 'review',
      phase: 'evaluate',
      contract: 'decision-artifact' as const,
      normalizedResult: 'unknown' as const,
      pipelineId: 'default',
      pipelineRunId: record.pipelineRunId,
      stageId: 'review',
      chainMode: 'stage-continuation' as const,
      parentArtifactIdentity: record.artifactIdentity,
      unclassified: false,
    };
    expect(validateContinuationParent(child, [record, child], config.manifest)).toMatchObject({
      valid: false,
      reason: expect.stringContaining('not completion-capable'),
    });
  });

  it('returns unknown before provider execution when a declared project file is missing', async () => {
    const config = loadConfig(tempWorkspace);
    const task = config.manifest.tasks!.implement!;
    const run = vi.spyOn(fakeAdapter, 'run');
    const planPath = join(tempWorkspace, 'docs/dev/plan.md');
    // The task input is declared, so this is an executor-level input failure
    // for direct engine callers; smashAction performs the earlier preflight.
    writeFileSync(planPath, '');
    const result = await runTask(
      tempWorkspace,
      'implement',
      task,
      config,
      { '30-simple-implement': { agent: 'fake', model: 'fake-model' } },
      taskOptions(config),
    );
    expect(result.success).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('corrects one qualified decision line after operator confirmation without a second provider call', async () => {
    const config = loadConfig(tempWorkspace);
    const loop = config.manifest.loops.plan!;
    const events: RunEvent[] = [];
    const correctionOutput = createMockOutput({ emit: (event: RunEvent) => events.push(event) });
    const provider = vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const match = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      if (match?.[1]) {
        const path = resolve(input.cwd, match[1].trim());
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        writeFileSync(path, '# Plan Audit\n\n## Verdict\n\nREJECTED (narrow)\n\nReason: one caveat\n');
      }
      return { stdout: 'done', exitCode: 0 };
    });
    const correction = vi.fn(async (request: { invalidLine?: string; acceptedToken: string; retryToken: string; safe: boolean; artifactPath: string }) => {
      expect(request.safe).toBe(true);
      expect(request.invalidLine).toBe('REJECTED (narrow)');
      return { kind: 'correct' as const, token: request.acceptedToken };
    });

    const result = await runLoop(
      tempWorkspace,
      'plan',
      loop,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model' },
      },
      {
        maxIterations: 4,
        registry: createTestAdapterRegistry(),
        output: correctionOutput,
        interactive: false,
        globalOverrides: { agent: 'fake', model: 'fake-model' },
        decisionCorrection: correction,
      },
    );

    expect(result.success).toBe(true);
    expect(result.outcome?.kind).toBe('completed');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(correction).toHaveBeenCalledTimes(1);
    const active = readFileSync(join(tempWorkspace, 'docs/dev/plan-audit-v1-fake.md'), 'utf8');
    expect(active).toContain('schemaVersion: 1');
    expect(active).toContain('APPROVED');
    expect(active.match(/\n---\n\n([\s\S]*)$/)?.[1]).not.toContain('REJECTED (narrow)');
    const meta = parseArtifactMeta(active, { agent: 'fake', version: 1 });
    expect(meta.decisionCorrection).toMatchObject({
      originalLine: 'REJECTED (narrow)',
      selectedToken: 'APPROVED',
      archivedEvidencePath: expect.stringContaining('docs/dev/archived/'),
    });
    const rescanned = scanGlobalSnapshot(tempWorkspace, config.manifest).steps.find(step => step.bindingId === 'plan');
    expect(rescanned?.decisionCorrection).toMatchObject({
      originalLine: 'REJECTED (narrow)',
      selectedToken: 'APPROVED',
    });
    const archived = readdirSync(join(tempWorkspace, 'docs/dev/archived'));
    expect(archived.some(file => file.includes('decision-correction'))).toBe(true);
    expect(events.find(event => event.type === 'artifact.decision-corrected')).toMatchObject({
      type: 'artifact.decision-corrected',
      originalLine: 'REJECTED (narrow)',
      selectedToken: 'APPROVED',
    });
    expect(events.find(event => event.type === 'artifact.verified')).toMatchObject({ result: 'accepted' });
  });

  it('archives a declined qualified decision unchanged and stops unknown', async () => {
    const config = loadConfig(tempWorkspace);
    const loop = config.manifest.loops.plan!;
    const events: RunEvent[] = [];
    const declineOutput = createMockOutput({ emit: (event: RunEvent) => events.push(event) });
    const provider = vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const match = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      if (match?.[1]) {
        const path = resolve(input.cwd, match[1].trim());
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        writeFileSync(path, '# Plan Audit\n\n## Verdict\n\nREJECTED (narrow)\n');
      }
      return { stdout: 'done', exitCode: 0 };
    });
    const result = await runLoop(
      tempWorkspace,
      'plan',
      loop,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model' },
      },
      {
        maxIterations: 4,
        registry: createTestAdapterRegistry(),
        output: declineOutput,
        interactive: false,
        globalOverrides: { agent: 'fake', model: 'fake-model' },
        decisionCorrection: async () => ({ kind: 'archive' as const }),
      },
    );
    expect(result.success).toBe(false);
    expect(result.outcome?.kind).toBe('unknown');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(existsSync(join(tempWorkspace, 'docs/dev/plan-audit-v1-fake.md'))).toBe(false);
    const archivedPath = readdirSync(join(tempWorkspace, 'docs/dev/archived'))
      .find(file => file.includes('decision-correction'));
    expect(archivedPath).toBeDefined();
    const archived = readFileSync(join(tempWorkspace, 'docs/dev/archived', archivedPath!), 'utf8');
    expect(archived).toContain('REJECTED (narrow)');
    expect(archived).not.toContain('schemaVersion: 1');
    expect(events.find(event => event.type === 'decision.unknown')).toMatchObject({
      type: 'decision.unknown',
      reason: expect.stringContaining('Archived evidence'),
    });
  });
});
