import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Mock runLoop so smashAction's start-point derivation is exercised in isolation.
vi.mock('../src/loop.js', () => ({
  runLoop: vi.fn().mockResolvedValue({ success: true, verdict: 'APPROVED', message: 'mocked', lastAuditPath: null })
}));

import { smashAction } from '../src/commands/smash.js';
import { runLoop } from '../src/loop.js';
import { buildFrontMatter } from '../src/provenance.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { makeArtifactMeta } from './helpers/provenance.js';

const mockedRunLoop = vi.mocked(runLoop);

let lastErrorMessage = '';
const mockOutput = {
  note: () => {},
  warn: () => {},
  error: (msg: string) => { lastErrorMessage = msg; },
  iterationStarted: () => {},
  stepStarted: () => {},
  stepSucceeded: () => {},
  stepFailed: () => {},
  renderPanel: () => {},
  finalSummary: () => {}
};

describe('smashAction start-point derivation (consumes canonical rule)', () => {
  const tempDir = join(process.cwd(), 'temp-smash-action');

  beforeEach(() => {
    createTempDir('temp-smash-action');
    mockedRunLoop.mockClear();
    mockedRunLoop.mockResolvedValue({ success: true, verdict: 'APPROVED', message: 'mocked', lastAuditPath: null });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.restoreAllMocks();
  });

  function writeAudit(version: number, verdict: 'APPROVED' | 'REJECTED') {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const meta = makeArtifactMeta({ version });
    writeFileSync(
      join(tempDir, `docs/dev/plan-audit-v${version}-fake.md`),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\n${verdict}\n`
    );
  }

  async function runSmash() {
    return await smashAction({
      project: tempDir,
      loop: 'plan',
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
    });
  }

  it('REJECTED state => start-point resume (matches allowedStartPoint)', async () => {
    writeAudit(1, 'REJECTED');
    const res = await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ startPoint: 'resume' });
    expect(res.exitCode).toBe(0);
  });

  it('APPROVED state => start-point new-round', async () => {
    writeAudit(1, 'APPROVED');
    const res = await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ startPoint: 'new-round' });
    expect(lastErrorMessage).toBe('');
    expect(res.exitCode).toBe(0);
  });

  it('fresh state (no audits) => start-point fresh', async () => {
    const res = await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ startPoint: 'fresh' });
    expect(lastErrorMessage).toBe('');
    expect(res.exitCode).toBe(0);
  });

  it('unknown latest audit is terminal: rejected before runLoop is reached', async () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const meta = makeArtifactMeta({ version: 1 });
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\nGARBAGE\n`
    );
    const res = await runSmash();
    expect(mockedRunLoop).not.toHaveBeenCalled();
    expect(res.exitCode).toBe(1);
  });

  it('loop failure with verdict unknown returns exitCode: 1', async () => {
    mockedRunLoop.mockResolvedValueOnce({ success: false, verdict: 'unknown', message: 'failed', lastAuditPath: null });
    const res = await runSmash();
    expect(res.exitCode).toBe(1);
  });

  it('loop failure with verdict REJECTED (max iterations reached) returns exitCode: 0', async () => {
    mockedRunLoop.mockResolvedValueOnce({ success: false, verdict: 'REJECTED', message: 'max iterations', lastAuditPath: null });
    const res = await runSmash();
    expect(res.exitCode).toBe(0);
  });

  it('forwards the custom output options object to runLoop', async () => {
    const customOutput = { ...mockOutput };
    await smashAction({
      project: tempDir,
      loop: 'plan',
      agent: 'fake',
      model: 'fake-model',
      output: customOutput
    });
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ output: customOutput });
  });
});
