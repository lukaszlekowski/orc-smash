import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { confirmGroupClosed } from '../src/run-ownership.js';
import { __setForbiddenPgidResolverForTests, __setSignalSenderForTests, __resetForbiddenPgidCacheForTests } from '../src/kill-gate.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

/**
 * Portable PGID behavior: `confirmGroupClosed` is called from the close path
 * AFTER the leader has exited. Because the portable design cannot verify group
 * ownership without a live leader, it must NOT issue a group kill here — a
 * recycled PGID must never be signalled. It only retires the record. Any
 * descendant that outlived the leader orphans (documented residual risk; see
 * docs/dev/plan.md Architecture Decision Note).
 *
 * The previous version of this test asserted that a real `kill(-4242)` was
 * issued; that is exactly the unsafe behavior this rewrite forbids.
 */
const tmp = join(process.cwd(), 'temp-pg-descendant');
let runDir: string;

beforeEach(() => {
  createTempDir('temp-pg-descendant');
  runDir = join(tmp, 'run');
  mkdirSync(runDir, { recursive: true });
  chmodSync(runDir, 0o700);
  __setForbiddenPgidResolverForTests(() => new Set([0, 1]));
  __setSignalSenderForTests(() => {
    const error: Error & { code?: string } = new Error('gone');
    error.code = 'ESRCH';
    throw error;
  });
});

afterEach(() => {
  __setSignalSenderForTests(null);
  __resetForbiddenPgidCacheForTests();
  removeTempDir(tmp);
});

function seedActive(withGroup: boolean): void {
  const groups = withGroup
    ? [{ pgid: 4242, leaderPid: 4242, sessionId: 4242, leaderStartMs: 0, command: 'provider', bootstrapExecutablePath: process.execPath, executablePath: 'provider' }]
    : [];
  writeFileSync(
    join(runDir, 'active.json'),
    JSON.stringify({
      schemaVersion: 1,
      cliIdentity: { pid: process.pid, startMs: 0, command: 'orc' },
      groups,
      state: 'running',
      cliRevision: 1
    }),
    { mode: 0o600 }
  );
}

describe('confirmGroupClosed — retires the record without an unsafe group kill', () => {
  it('removes the group from active.json and bumps the revision', async () => {
    seedActive(true);
    await confirmGroupClosed(runDir, {
      pgid: 4242,
      leaderPid: 4242,
      sessionId: 4242,
      leaderStartMs: 0,
      command: 'provider',
      bootstrapExecutablePath: process.execPath,
      executablePath: 'provider'
    });
    const active = JSON.parse(readFileSync(join(runDir, 'active.json'), 'utf-8'));
    expect(active.groups).toEqual([]);
    expect(active.cliRevision).toBe(2);
  });

  it('issues NO negative-pid process.kill (a recycled PGID must never be signalled)', async () => {
    const killSpy = vi.spyOn(process, 'kill');
    seedActive(true);
    await confirmGroupClosed(runDir, {
      pgid: 4242,
      leaderPid: 4242,
      sessionId: 4242,
      leaderStartMs: 0,
      command: 'provider',
      bootstrapExecutablePath: process.execPath,
      executablePath: 'provider'
    });
    const negKills = killSpy.mock.calls.filter(
      ([p]) => typeof p === 'number' && p < 0
    );
    expect(negKills).toEqual([]);
    killSpy.mockRestore();
  });

  it('leaves the groups set unchanged when the handle pgid is not registered', async () => {
    seedActive(true);
    await confirmGroupClosed(runDir, {
      pgid: 9999,
      leaderPid: 9999,
      sessionId: 9999,
      leaderStartMs: 0,
      command: 'other',
      bootstrapExecutablePath: process.execPath,
      executablePath: 'other'
    });
    const active = JSON.parse(readFileSync(join(runDir, 'active.json'), 'utf-8'));
    expect(active.groups).toHaveLength(1);
  });
});
