import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './helpers/fs.js';

/**
 * v5-M1 plan-mandated coverage (§2 verification: `tests/process-group.descendant-stopped.test.ts`).
 * Deterministic ownership-layer proof (all platforms): a registered group whose
 * leader has exited but which still has a surviving descendant is killed via the
 * durable cgroup and then retired — the leader-gone descendant is stopped before
 * the group is removed from active.json. The cgroup primitives are mocked so the
 * control flow runs without a real cgroup-v2 hierarchy; the real descendant-
 * containment behavior runs under Linux + delegated cgroup-v2 below.
 */

const tmp = join(process.cwd(), 'temp-pg-descendant');
let runDir: string;

const fakeReadCgroupProcs = vi.fn();
const fakeKillCgroup = vi.fn();

vi.mock('../src/adapters/process-group.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    readCgroupProcs: (...a: unknown[]) => fakeReadCgroupProcs(...a),
    killCgroup: (...a: unknown[]) => fakeKillCgroup(...a)
  };
});

// Imported after the mock is registered.
const { confirmGroupClosed } = await import('../src/run-ownership.js');

beforeEach(() => {
  createTempDir('temp-pg-descendant');
  runDir = join(tmp, 'run');
  mkdirSync(runDir, { recursive: true });
  fakeReadCgroupProcs.mockReset();
  fakeKillCgroup.mockReset();
});

afterEach(() => {
  removeTempDir(tmp);
});

function seedActive(withGroup: boolean): void {
  const groups = withGroup
    ? [{
        cgroupPath: '/sys/fs/cgroup/orc-smash/desc-run',
        pgid: 4242, leaderPid: 4242, leaderStartMs: 0, command: 'provider',
        cgroupIno: 99, cgroupDev: 5
      }]
    : [];
  writeFileSync(
    join(runDir, 'active.json'),
    JSON.stringify({
      cliIdentity: { pid: process.pid, startMs: 0, command: 'orc' },
      groups,
      state: 'running',
      cliRevision: 1
    }),
    { mode: 0o600 }
  );
}

describe('confirmGroupClosed — leader-gone descendant is stopped, then retired (deterministic)', () => {
  it('kills a surviving descendant via killCgroup and removes the group from active.json', async () => {
    seedActive(true);
    // A descendant remains after the leader is gone.
    fakeReadCgroupProcs.mockReturnValue(['9999']);
    fakeKillCgroup.mockReturnValue({ survivors: [], unverifiable: false });

    const handle = {
      cgroupPath: '/sys/fs/cgroup/orc-smash/desc-run',
      pgid: 4242, leaderPid: 4242, leaderStartMs: 0, command: 'provider',
      cgroupIno: 99, cgroupDev: 5
    };
    await confirmGroupClosed(runDir, handle);

    // The descendant was detected and killCgroup was invoked against the durable cgroup.
    expect(fakeReadCgroupProcs).toHaveBeenCalledTimes(1);
    expect(fakeKillCgroup).toHaveBeenCalledTimes(1);
    // The group was retired from active.json (no survivors remained after the kill).
    const active = JSON.parse(readFileSync(join(runDir, 'active.json'), 'utf-8'));
    expect(active.groups).toEqual([]);
    expect(active.cliRevision).toBe(2);
  });

  it('retires immediately when the cgroup is already empty (no descendant)', async () => {
    seedActive(true);
    fakeReadCgroupProcs.mockReturnValue([]);

    await confirmGroupClosed(runDir, {
      cgroupPath: '/sys/fs/cgroup/orc-smash/desc-run',
      pgid: 4242, leaderPid: 4242, leaderStartMs: 0, command: 'provider',
      cgroupIno: 99, cgroupDev: 5
    });

    expect(fakeKillCgroup).not.toHaveBeenCalled();
    const active = JSON.parse(readFileSync(join(runDir, 'active.json'), 'utf-8'));
    expect(active.groups).toEqual([]);
  });

  it('fails closed (throws) when an unkillable survivor remains after killCgroup', async () => {
    seedActive(true);
    fakeReadCgroupProcs.mockReturnValue(['9999']);
    fakeKillCgroup.mockReturnValue({ survivors: ['9999'], unverifiable: false });

    await expect(confirmGroupClosed(runDir, {
      cgroupPath: '/sys/fs/cgroup/orc-smash/desc-run',
      pgid: 4242, leaderPid: 4242, leaderStartMs: 0, command: 'provider',
      cgroupIno: 99, cgroupDev: 5
    })).rejects.toThrow(/Terminal ownership failure/);
    // The group is NOT retired when the survivor is unkillable.
    const active = JSON.parse(readFileSync(join(runDir, 'active.json'), 'utf-8'));
    expect(active.groups).toHaveLength(1);
  });
});

// ---- Linux + delegated cgroup-v2 gated real descendant containment ----------
const describeOnLinuxCgroup = process.platform === 'linux' ? describe : describe.skip;
describeOnLinuxCgroup('descendant-stopped — real cgroup containment (Linux + cgroup-v2)', () => {
  it('a forked grandchild that outlives the leader is stopped by killCgroup before the group is retired', async () => {
    const { checkCgroupV2Capability, ProcessGroupRuntime, readCgroupProcs, killCgroup } = await import('../src/adapters/process-group.js');
    expect(checkCgroupV2Capability().supported).toBe(true);
    // Provider forks a long-lived grandchild then exits; the grandchild stays in
    // the per-run cgroup. killCgroup must reach it leader-independently.
    const r = ProcessGroupRuntime.createGroup('desc-real-run', join(tmp, 'realrun'), 'sh', ['-c', 'sleep 30 &'], { PATH: '/usr/bin' });
    await r.ready;
    // Wait briefly for the provider to exit while the grandchild remains.
    await new Promise((res) => setTimeout(res, 200));
    killCgroup(r.handle.cgroupPath, r.handle.cgroupIno, r.handle.cgroupDev);
    expect(readCgroupProcs(r.handle.cgroupPath, r.handle.cgroupIno, r.handle.cgroupDev)).toEqual([]);
  });
});
