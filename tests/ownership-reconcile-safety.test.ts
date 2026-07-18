import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { reconcileOnStart } from '../src/run-ownership.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

/**
 * Integration safety for the restart-reconciliation path. `reconcileOnStart`
 * reads stale groups from durable active.json after a CLI crash and must NEVER
 * issue a real negative-pid kill to an unverifiable or forbidden group — that
 * is exactly the operation that killed a prior dev session. A canary intercepts
 * every `process.kill(-pid, …)` so the test cannot send a real group signal even
 * if the gate regressed; positive pids (liveness pings) still pass through.
 */
const tmp = join(process.cwd(), 'temp-reconcile-safety');
let runDir: string;

beforeEach(() => {
  createTempDir('temp-reconcile-safety');
  runDir = join(tmp, 'run');
  mkdirSync(runDir, { recursive: true });
  chmodSync(runDir, 0o700);
});

afterEach(() => {
  removeTempDir(tmp);
});

function seedStaleGroup(pgid: number, leaderPid: number): void {
  writeFileSync(
    join(runDir, 'active.json'),
    JSON.stringify({
      schemaVersion: 1,
      cliIdentity: { pid: 999998, startMs: 0, command: 'orc' }, // dead prior holder
      groups: [{ pgid, leaderPid, sessionId: pgid, leaderStartMs: 0, command: 'provider', bootstrapExecutablePath: process.execPath, executablePath: 'provider' }],
      state: 'running',
      cliRevision: 1
    }),
    { mode: 0o600 }
  );
}

describe('reconcileOnStart — fail-closed, never sends a real negative-pid kill', () => {
  it('throws (retains admission) when the stale leader is gone', async () => {
    const realKill = process.kill;
    const negCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: any) => {
      if (typeof pid === 'number' && pid < 0) {
        negCalls.push({ pid, signal });
        return true; // canary: never really signal a group
      }
      return (realKill as any)(pid, signal);
    }) as any);

    seedStaleGroup(999999, 999999); // sentinel: no such process anywhere
    await expect(reconcileOnStart(runDir)).rejects.toThrow(/terminal ownership-failure/);
    expect(negCalls).toEqual([]);

    spy.mockRestore();
  });

  it('refuses to kill a stale group whose pgid is the CLI own pid (structural reject)', async () => {
    const realKill = process.kill;
    const negCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }> = [];
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: any) => {
      if (typeof pid === 'number' && pid < 0) {
        negCalls.push({ pid, signal });
        return true;
      }
      return (realKill as any)(pid, signal);
    }) as any);

    seedStaleGroup(process.pid, 999997);
    await expect(reconcileOnStart(runDir)).rejects.toThrow();
    expect(negCalls).toEqual([]);

    spy.mockRestore();
  });
});
