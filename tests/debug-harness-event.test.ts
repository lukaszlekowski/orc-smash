import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { configureSpawnDebug, debugHarnessEvent } from '../src/debug-spawn.js';
import { createPanelCliOutput } from '../src/cli-output.js';

describe('Debug Harness Events and Buffering', () => {
  const tempDir = join(process.cwd(), 'temp-debug-harness-test');

  beforeEach(() => {
    createTempDir('temp-debug-harness-test');
    vi.stubEnv('ORC_DEBUG_SPAWN', '0');
    configureSpawnDebug({ enabled: false, filePath: null });
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.unstubAllEnvs();
    configureSpawnDebug({ enabled: false, filePath: null });
    vi.restoreAllMocks();
  });

  it('does not write to log file when spawn debug is disabled', () => {
    debugHarnessEvent({
      cwd: tempDir,
      category: 'preflight',
      event: 'test-event-disabled',
      result: 'pass'
    });
    const logPath = join(tempDir, 'docs/dev/spawn-debug.log');
    expect(existsSync(logPath)).toBe(false);
  });

  it('writes to spawn-debug.log when spawn debug is enabled', () => {
    configureSpawnDebug({ enabled: true, filePath: 'docs/dev/spawn-debug.log' });
    debugHarnessEvent({
      cwd: tempDir,
      category: 'preflight',
      event: 'test-event-enabled',
      result: 'pass',
      detail: 'extra-info'
    });
    const logPath = join(tempDir, 'docs/dev/spawn-debug.log');
    expect(existsSync(logPath)).toBe(true);
    const content = readFileSync(logPath, 'utf8');
    expect(content).toContain('[ORC_DEBUG_HARNESS] preflight');
    expect(content).toContain('event=test-event-enabled');
    expect(content).toContain('detail=extra-info');
    expect(content).toContain('result=pass');
  });

  it('buffers and flushes event log in createPanelCliOutput', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const output = createPanelCliOutput(tempDir);
    output.note('Test Note');
    output.warn('Test Warning');
    output.error('Test Error');
    output.iterationStarted({ iteration: 1, maxIterations: 5 });
    output.stepStarted({ kind: 'audit', skillId: 'plan-audit', agent: 'fake', model: 'fake-model', iteration: 1, version: 1, message: 'spawning fake' });
    output.stepSucceeded({ kind: 'audit', skillId: 'plan-audit', version: 1, message: 'succeeded' });
    output.stepFailed({ kind: 'audit', skillId: 'plan-audit', version: 1, message: 'failed', errorKind: 'unknown' });

    // Since alt-screen is not active, standard outputs are printed directly, but let's call finalSummary
    output.finalSummary({ success: true, verdict: 'APPROVED', message: 'completed loop', lastAuditPath: '/some/path' });

    const printedLines = logSpy.mock.calls.map(call => call[0]).join('\n');
    expect(printedLines).toContain('── Harness Event Log ──');
    expect(printedLines).toContain('[NOTE] Test Note');
    expect(printedLines).toContain('[WARN] Test Warning');
    expect(printedLines).toContain('[ERROR] Test Error');
    expect(printedLines).toContain('[ITERATION] 1/5');
    expect(printedLines).toContain('[STARTED] audit v1 → fake (fake-model)');
    expect(printedLines).toContain('[OK] audit v1: succeeded');
    expect(printedLines).toContain('[FAIL] audit v1: failed (unknown)');
  });
});
