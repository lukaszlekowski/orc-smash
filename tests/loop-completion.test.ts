import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { fakeAdapter, fakeAdapterState } from '../src/adapters/fake.js';
import { createTestAdapterRegistry, resetFakeAdapterState } from '../src/adapters/testing.js';
import { createMockOutput } from './helpers/mock-output.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

const testRegistry = createTestAdapterRegistry();
const mockOutput = createMockOutput();

describe('generic execution-completeness and artifact gates', () => {
  const tempWorkspace = resolve(process.cwd(), 'temp-loop-completion');

  beforeEach(() => {
    createTempDir('temp-loop-completion');
    resetFakeAdapterState();
  });

  afterEach(() => {
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
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
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

    expect(result).toMatchObject({ success: false, verdict: 'unknown' });
    expect(result.message).toContain('produced no artifact at docs/dev/plan-followup-v1-fake.md');
    expect(existsSync(join(root, 'docs/dev/plan-audit-v2-fake.md'))).toBe(false);
    expect(stepFailed).toContainEqual(expect.objectContaining({ kind: 'repair', errorKind: 'missing_output' }));
  });
});
