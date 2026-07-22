import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { fakeAdapter, fakeAdapterState } from '../src/adapters/fake.js';
import { createTestAdapterRegistry, resetFakeAdapterState } from '../src/adapters/testing.js';
import { createMockOutput } from './helpers/mock-output.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

vi.mock('../src/interactive.js', () => ({
  promptIterationExtension: vi.fn(),
}));

vi.mock('../src/run-ownership.js', async (importOriginal) => {
  const original = await importOriginal<any>();
  return {
    ...original,
    mayStartStep: vi.fn((control, active, now, ownership) => {
      if ((global as any).__mockFenceReject) return false;
      return original.mayStartStep(control, active, now, ownership);
    }),
  };
});

const testRegistry = createTestAdapterRegistry();
const mockOutput = createMockOutput();

describe('generic execution-completeness and artifact gates', () => {
  const tempWorkspace = resolve(process.cwd(), 'temp-loop-completion');

  beforeEach(() => {
    createTempDir('temp-loop-completion');
    resetFakeAdapterState();
  });

  afterEach(() => {
    delete (global as any).__mockFenceReject;
    vi.restoreAllMocks();
    removeTempDir(tempWorkspace);
  });

  function setupProject() {
    const root = join(tempWorkspace, 'project');
    mkdirSync(join(root, 'docs/dev'), { recursive: true });
    writeFileSync(join(root, 'docs/dev/plan.md'), '# My Plan\nInitial content.\n');
    return root;
  }

  const runners = {
    'plan-audit': { agent: 'fake', model: 'fake-model' },
    'plan-follow-up': { agent: 'fake', model: 'fake-model' }
  };

  async function runPlan(root: string, overrides: Record<string, unknown> = {}) {
    const config = loadConfig(root);
    return runLoop(root, 'plan', config.manifest.loops.plan!, config, runners, {
      maxIterations: 3,
      registry: testRegistry,
      output: mockOutput,
      interactive: false,
      ...overrides
    });
  }

  it.each([
    ['truncated', 'length'],
    ['interrupted', undefined]
  ] as const)('treats %s provider completion as terminal unknown before artifact parsing', async (completion, reason) => {
    const root = setupProject();
    vi.spyOn(fakeAdapter, 'run').mockResolvedValue({
      stdout: '',
      exitCode: 0,
      completion,
      stopReason: reason
    });

    const result = await runPlan(root);

    expect(result).toMatchObject({ success: false, verdict: 'unknown' });
    expect(result.message).toContain('evaluate execution truncated or interrupted');
    if (reason) expect(result.message).toContain(reason);
    expect(existsSync(join(root, 'docs/dev/plan-audit-v1-fake.md'))).toBe(false);
  });

  it('requires the configured evaluate artifact even when the provider exits cleanly', async () => {
    const root = setupProject();
    fakeAdapterState.writeVerdictFile = false;
    const stepFailed: any[] = [];

    const result = await runPlan(root, {
      output: { ...mockOutput, stepFailed: (event: any) => stepFailed.push(event) }
    });

    expect(result).toMatchObject({ success: false, verdict: 'unknown' });
    expect(result.message).toContain('produced no artifact at docs/dev/plan-audit-v1-fake.md');
    expect(stepFailed).toContainEqual(expect.objectContaining({ kind: 'evaluate', errorKind: 'missing_output' }));
  });

  it('requires a valid repair artifact before starting the next evaluation', async () => {
    const root = setupProject();
    const originalRun = fakeAdapter.run;
    const spy = vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const outputMatch = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      const outputPath = outputMatch?.[1]?.trim();
      if (input.kind === 'evaluate' && outputPath) {
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        writeFileSync(resolve(root, outputPath), '# Plan Audit\n\n## Verdict\n\nREJECTED\n');
        return { stdout: '', exitCode: 0 };
      }
      if (input.kind === 'repair') return { stdout: '', exitCode: 0 };
      return originalRun(input);
    });

    const stepFailed: any[] = [];
    const result = await runPlan(root, {
      output: { ...mockOutput, stepFailed: (event: any) => stepFailed.push(event) }
    });

    spy.mockRestore();

    expect(result).toMatchObject({ success: false, verdict: 'unknown' });
    expect(result.message).toContain('produced no artifact at docs/dev/plan-followup-v1-fake.md');
    expect(existsSync(join(root, 'docs/dev/plan-audit-v2-fake.md'))).toBe(false);
    expect(stepFailed).toContainEqual(expect.objectContaining({ kind: 'repair', errorKind: 'missing_output' }));
  });

  it('closes immediately on final round acceptance with no extension prompt', async () => {
    const root = setupProject();
    fakeAdapterState.verdicts = ['REJECTED', 'APPROVED'];

    const { promptIterationExtension } = await import('../src/interactive.js');
    vi.mocked(promptIterationExtension).mockClear();

    const result = await runPlan(root, { maxIterations: 2 });

    expect(result).toMatchObject({ success: true, verdict: 'accepted' });
    expect(promptIterationExtension).not.toHaveBeenCalled();
  });

  it('offers extension choices on final round retry and applies selected extension', async () => {
    const root = setupProject();
    fakeAdapterState.verdicts = ['REJECTED', 'REJECTED', 'APPROVED'];

    const { promptIterationExtension } = await import('../src/interactive.js');
    vi.mocked(promptIterationExtension).mockResolvedValueOnce('extend-3');

    const result = await runPlan(root, { maxIterations: 2, interactive: true });

    expect(result).toMatchObject({ success: true, verdict: 'accepted' });
    expect(promptIterationExtension).toHaveBeenCalledTimes(1);
    expect(promptIterationExtension).toHaveBeenLastCalledWith(2, 2, 3); // currentBudget, roundsUsed, providerCalls
  });

  it('tracks accurate round and provider call counts', async () => {
    const root = setupProject();
    fakeAdapterState.verdicts = ['REJECTED', 'REJECTED', 'APPROVED'];

    const notes: string[] = [];
    const customOutput = {
      ...mockOutput,
      note: (msg: string) => { notes.push(msg); }
    };

    const result = await runPlan(root, { maxIterations: 3, output: customOutput });

    expect(result).toMatchObject({ success: true, verdict: 'accepted' });
    expect(notes).toEqual([
      'Round 1/3 - provider calls 1',
      'Round 1/3 - provider calls 2',
      'Round 2/3 - provider calls 3',
      'Round 2/3 - provider calls 4',
      'Round 3/3 - provider calls 5'
    ]);
  });

  it('does not increment providerCallCount if ownership fence rejects the provider spawn', async () => {
    const root = setupProject();
    const { runLoop } = await import('../src/loop.js');

    const controlRecord = {
      schemaVersion: 1 as const,
      runId: 'active-run',
      ownerTokenHash: 'somehash',
      projectRoot: root,
      hostInstanceId: 'host',
      leaseIssuedMs: Date.now(),
      leaseTtlMs: 100000,
      leaseExpiresMs: Date.now() + 100000,
      issuerRevision: 1,
    };
    const activeRecord = {
      schemaVersion: 1 as const,
      cliIdentity: {
        pid: process.pid,
        startMs: Date.now() - 5000,
        command: 'node bin/orc.js',
      },
      groups: [],
      state: 'running',
      cliRevision: 1,
    };

    const runDir = join(root, '.orc-smash');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'control.json'), JSON.stringify(controlRecord));
    writeFileSync(join(runDir, 'active.json'), JSON.stringify(activeRecord));

    const { chmodSync } = await import('node:fs');
    chmodSync(runDir, 0o700);
    chmodSync(join(runDir, 'control.json'), 0o600);
    chmodSync(join(runDir, 'active.json'), 0o600);

    (global as any).__mockFenceReject = true;

    const notes: string[] = [];
    const customOutput = {
      ...mockOutput,
      note: (msg: string) => { notes.push(msg); }
    };

    const config = loadConfig(root);
    const result = await runLoop(
      root,
      'plan',
      config.manifest.loops.plan!,
      config,
      { evaluate: { agent: 'fake', model: 'fake-model' }, repair: { agent: 'fake', model: 'fake-model' } },
      {
        maxIterations: 1,
        registry: testRegistry,
        output: customOutput,
        interactive: false,
        ownership: {
          token: 'tok',
          runId: 'active-run',
          stateDir: runDir,
          projectDir: root,
          runDir,
          control: controlRecord,
          env: {},
        }
      }
    );

    expect(result.success).toBe(false);
    expect(result.outcome?.kind).toBe('ownership-lost');
    expect(notes.length).toBe(0);
  });
});
