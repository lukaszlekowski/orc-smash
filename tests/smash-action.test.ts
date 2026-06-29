import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// Mock runLoop so smashAction's start-point derivation is exercised in isolation.
vi.mock('../src/loop.js', () => ({
  runLoop: vi.fn().mockResolvedValue({ success: true, verdict: 'APPROVED', message: 'mocked', lastAuditPath: null })
}));

import { smashAction } from '../src/commands/smash.js';
import { runLoop } from '../src/loop.js';
import { buildFrontMatter, type ArtifactMeta } from '../src/provenance.js';

const mockedRunLoop = vi.mocked(runLoop);

describe('smashAction start-point derivation (consumes canonical rule)', () => {
  const tempDir = join(process.cwd(), 'temp-smash-action');

  beforeEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    mockedRunLoop.mockClear();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // smashAction uses process.exit both as a terminal (after runLoop) and as a
    // guard (unknown verdict, invalid start point). Throwing halts guard logic so
    // it cannot fall through; callers catch the thrown error.
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeAudit(version: number, verdict: 'APPROVED' | 'REJECTED') {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const meta: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version, agent: 'fake', model: 'fake-model',
      target: 'docs/dev/plan.md', priorAudit: 'none', timestamp: '2026-06-29T00:00:00.000Z'
    };
    writeFileSync(
      join(tempDir, `docs/dev/plan-audit-v${version}-fake.md`),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\n${verdict}\n`
    );
  }

  async function runSmash() {
    // Non-interactive: loop + agent/model provided via flags.
    // The mocked process.exit throws on the terminal exit; swallow it.
    try {
      await smashAction({ project: tempDir, loop: 'plan', agent: 'fake', model: 'fake-model' });
    } catch {
      /* expected: mocked process.exit throws */
    }
  }

  it('REJECTED state => start-point resume (matches allowedStartPoint)', async () => {
    writeAudit(1, 'REJECTED');
    await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ startPoint: 'resume' });
  });

  it('APPROVED state => start-point new-round', async () => {
    writeAudit(1, 'APPROVED');
    await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ startPoint: 'new-round' });
  });

  it('fresh state (no audits) => start-point fresh', async () => {
    await runSmash();
    expect(mockedRunLoop).toHaveBeenCalledTimes(1);
    expect(mockedRunLoop.mock.calls[0]![5]).toMatchObject({ startPoint: 'fresh' });
  });

  it('unknown latest audit is terminal: rejected before runLoop is reached', async () => {
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    const meta: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 1, agent: 'fake', model: 'fake-model',
      target: 'docs/dev/plan.md', priorAudit: 'none', timestamp: '2026-06-29T00:00:00.000Z'
    };
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\nGARBAGE\n`
    );
    await runSmash();
    // The unparseable latest audit is a terminal state with no valid start point;
    // smash must error out without ever running the loop.
    expect(mockedRunLoop).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
