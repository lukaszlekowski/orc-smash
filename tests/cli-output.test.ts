import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { createPlainCliOutput, createPanelCliOutput } from '../src/cli-output.js';
import { createTestAdapterRegistry, resetFakeAdapterState } from '../src/adapters/testing.js';
import { fakeAdapterState } from '../src/adapters/fake.js';
import ora from 'ora';

const mockSpinner = {
  start: vi.fn(() => mockSpinner),
  stop: vi.fn(() => mockSpinner),
  succeed: vi.fn(() => mockSpinner),
  fail: vi.fn(() => mockSpinner)
};

vi.mock('ora', () => ({
  default: vi.fn(() => mockSpinner)
}));

describe('Plain mode loop-level integration', () => {
  const tempWorkspace = resolve(process.cwd(), 'temp-plain-mode-test');
  let logSpy: any;
  let clearSpy: any;

  beforeEach(() => {
    if (existsSync(tempWorkspace)) {
      rmSync(tempWorkspace, { recursive: true, force: true });
    }
    mkdirSync(tempWorkspace, { recursive: true });
    resetFakeAdapterState();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    clearSpy = vi.spyOn(console, 'clear').mockImplementation(() => {});
    vi.mocked(ora).mockClear();
    mockSpinner.start.mockClear();
    mockSpinner.stop.mockClear();
    mockSpinner.succeed.mockClear();
    mockSpinner.fail.mockClear();
  });

  afterEach(() => {
    rmSync(tempWorkspace, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function setupProject() {
    const root = join(tempWorkspace, 'project');
    const devDir = join(root, 'docs/dev');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(root, 'docs/dev/plan.md'), `# My Plan\nInitial content.\n`);
    return root;
  }

  it('normal path: REJECTED -> follow-up -> APPROVED', async () => {
    const root = setupProject();
    const config = loadConfig(root);
    fakeAdapterState.verdicts = ['REJECTED', 'APPROVED'];

    const registry = createTestAdapterRegistry();
    const output = createPlainCliOutput();

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    }, {
      maxIterations: 5,
      startPoint: 'fresh',
      registry,
      output,
      interactive: false
    });

    expect(result.success).toBe(true);
    expect(result.verdict).toBe('APPROVED');

    // console.clear must NOT be called in plain mode
    expect(clearSpy).not.toHaveBeenCalled();
    expect(ora).not.toHaveBeenCalled();

    // Verify logs capture stepStarted, stepSucceeded, stepFailed, finalSummary
    const logs = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    expect(logs).toContain('Step audit version 1 using fake (fake-model): running...');
    expect(logs).toContain('Step audit version 1: succeeded');
    expect(logs).toContain('Step follow-up version 1 using fake (fake-model): running...');
    expect(logs).toContain('Step follow-up version 1: succeeded');
    expect(logs).toContain('Step audit version 2 using fake (fake-model): running...');
    expect(logs).toContain('Step audit version 2: succeeded');
    expect(logs).toContain('Success: awaiting your review');
  });

  it('terminal unknown path', async () => {
    const root = setupProject();
    const config = loadConfig(root);
    fakeAdapterState.verdicts = ['unknown'];

    const registry = createTestAdapterRegistry();
    const output = createPlainCliOutput();

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    }, {
      maxIterations: 5,
      startPoint: 'fresh',
      registry,
      output,
      interactive: false
    });

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('unknown');

    expect(clearSpy).not.toHaveBeenCalled();
    expect(ora).not.toHaveBeenCalled();

    const logs = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    expect(logs).toContain('Step audit version 1 using fake (fake-model): running...');
    expect(logs).toContain('Step audit version 1: succeeded');
    expect(logs).toContain('Loop terminated: Audit failed to write a valid verdict');
  });

  it('hit-max path', async () => {
    const root = setupProject();
    const config = loadConfig(root);
    fakeAdapterState.verdicts = ['REJECTED', 'REJECTED', 'REJECTED'];

    const registry = createTestAdapterRegistry();
    const output = createPlainCliOutput();

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    }, {
      maxIterations: 2, // hit max iterations early
      startPoint: 'fresh',
      registry,
      output,
      interactive: false
    });

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('REJECTED');

    expect(clearSpy).not.toHaveBeenCalled();
    expect(ora).not.toHaveBeenCalled();

    const logs = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    expect(logs).toContain('Step audit version 1 using fake (fake-model): running...');
    expect(logs).toContain('Step audit version 1: succeeded');
    expect(logs).toContain('Step follow-up version 1 using fake (fake-model): running...');
    expect(logs).toContain('Step follow-up version 1: succeeded');
    expect(logs).toContain('Loop terminated: hit max-iterations, awaiting human');
  });

  it('panel mode: verifies spinners and logs are visually equivalent to pre-batch baseline', () => {
    const output = createPanelCliOutput();

    // 1. stepStarted for audit
    output.stepStarted({
      kind: 'audit',
      skillId: 'plan-audit',
      agent: 'fake',
      model: 'fake-model',
      iteration: 1,
      version: 1,
      message: 'Spawning fake for audit v1...'
    });
    expect(ora).toHaveBeenCalledWith(expect.stringContaining('Spawning fake for audit v1...'));
    expect(mockSpinner.start).toHaveBeenCalled();

    // 2. stepSucceeded
    output.stepSucceeded({
      kind: 'audit',
      skillId: 'plan-audit',
      version: 1,
      message: 'Audit execution completed'
    });
    expect(mockSpinner.succeed).toHaveBeenCalledWith(expect.stringContaining('Audit execution completed'));

    // 3. stepStarted for follow-up
    output.stepStarted({
      kind: 'follow-up',
      skillId: 'plan-follow-up',
      agent: 'fake',
      model: 'fake-model',
      iteration: 1,
      version: 1,
      message: 'Spawning fake for follow-up...'
    });
    expect(ora).toHaveBeenCalledWith(expect.stringContaining('Spawning fake for follow-up...'));

    // 4. stepFailed
    output.stepFailed({
      kind: 'follow-up',
      skillId: 'plan-follow-up',
      version: 1,
      message: 'Follow-up failed',
      errorKind: 'server'
    });
    expect(mockSpinner.fail).toHaveBeenCalledWith(expect.stringContaining('Follow-up failed'));

    // 5. finalSummary - success
    logSpy.mockClear();
    output.finalSummary({
      success: true,
      verdict: 'APPROVED',
      message: 'awaiting your review: docs/dev/plan-audit-v1-fake.md',
      lastAuditPath: 'docs/dev/plan-audit-v1-fake.md'
    });
    let logs = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    expect(logs).toContain('Success: awaiting your review: docs/dev/plan-audit-v1-fake.md');

    // 6. finalSummary - failure
    logSpy.mockClear();
    output.finalSummary({
      success: false,
      verdict: 'REJECTED',
      message: 'hit max-iterations, awaiting human',
      lastAuditPath: 'docs/dev/plan-audit-v1-fake.md'
    });
    logs = logSpy.mock.calls.map((c: any) => c.join(' ')).join('\n');
    expect(logs).toContain('Loop terminated: hit max-iterations, awaiting human');
  });
});
