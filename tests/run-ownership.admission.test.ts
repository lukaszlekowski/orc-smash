import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  acquireProjectLock,
  getProcessStartTime,
  getProcessCommand,
  type LockRecord
} from '../src/run-ownership.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

/**
 * C1 coverage: the canonical-project admission lock must stay on ONE primitive
 * (O_EXCL / `wx`) across both first-acquisition and stale-holder reclaim. The
 * previous reclaim path overwrote the lock file in place, so two concurrent
 * reclaimers could both conclude the holder was dead and both "win"; the fix
 * reclaims via unlink → `wx` retry with a liveness re-check on EEXIST.
 */
describe('acquireProjectLock — O_EXCL project admission', () => {
  const tmp = join(process.cwd(), 'temp-ownership-admission');
  let projectDir: string;

  beforeEach(() => {
    createTempDir('temp-ownership-admission');
    projectDir = join(tmp, 'proj-hash');
  });

  afterEach(() => {
    removeTempDir(tmp);
  });

  /** A lock record that `verifyIdentity` considers LIVE (the current process). */
  function liveLock(runId: string, runDir: string): LockRecord {
    return {
      schemaVersion: 1,
      runId,
      pid: process.pid,
      startMs: getProcessStartTime(process.pid),
      runDir,
      command: getProcessCommand(process.pid)
    };
  }

  /** Seed a lock file directly (mode 0o600 so verifyFilePermissions accepts it). */
  function seedLock(dir: string, record: LockRecord): void {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project.lock'), JSON.stringify(record), { mode: 0o600 });
  }

  it('first acquisition creates project.lock and project.json', async () => {
    const record = liveLock('run-a', join(tmp, 'run-a'));
    await acquireProjectLock(projectDir, record);

    expect(existsSync(join(projectDir, 'project.lock'))).toBe(true);
    expect(existsSync(join(projectDir, 'project.json'))).toBe(true);

    const lock = JSON.parse(readFileSync(join(projectDir, 'project.lock'), 'utf-8'));
    expect(lock.runId).toBe('run-a');
    const index = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8'));
    expect(index.currentRunId).toBe('run-a');
    expect(index.state).toBe('starting');
  });

  it('rejects a second live holder for the same canonical project (project-keyed admission)', async () => {
    await acquireProjectLock(projectDir, liveLock('run-a', join(tmp, 'run-a')));

    // Distinct runId, same project dir → must contend on the same project.lock.
    await expect(
      acquireProjectLock(projectDir, liveLock('run-b', join(tmp, 'run-b')))
    ).rejects.toThrow(/live run owns/);
  });

  it('reclaims a stale (dead-holder) lock and records the new runId via O_EXCL', async () => {
    // Seed a lock whose holder is provably dead (nonexistent PID).
    seedLock(projectDir, {
      schemaVersion: 1,
      runId: 'dead-run',
      pid: 999_999,
      startMs: 0,
      runDir: join(tmp, 'nonexistent-run'),
      command: 'orc'
    });

    const before = readFileSync(join(projectDir, 'project.lock'), 'utf-8');
    expect(JSON.parse(before).runId).toBe('dead-run');

    const newRecord = liveLock('reclaimed-run', join(tmp, 'reclaimed-run'));
    await acquireProjectLock(projectDir, newRecord);

    const after = JSON.parse(readFileSync(join(projectDir, 'project.lock'), 'utf-8'));
    // Reclaim replaced the dead holder with the new run, not overwrote it blindly.
    expect(after.runId).toBe('reclaimed-run');
  });

  it('after reclaiming a dead holder, still rejects a further live holder (admission preserved)', async () => {
    seedLock(projectDir, {
      schemaVersion: 1,
      runId: 'dead-run',
      pid: 999_998,
      startMs: 0,
      runDir: join(tmp, 'nonexistent-run'),
      command: 'orc'
    });

    await acquireProjectLock(projectDir, liveLock('reclaimed-run', join(tmp, 'reclaimed-run')));

    // The reclaimed lock is held by the live current process → a new run is rejected.
    await expect(
      acquireProjectLock(projectDir, liveLock('run-c', join(tmp, 'run-c')))
    ).rejects.toThrow(/live run owns/);
  });

  it('rejects when stale-run reconciliation fails (terminal ownership-failure retains the lock)', async () => {
    // Seed a dead holder whose runDir contains a non-terminal active.json but is
    // unreadable as a group source. reconcileOnStart will attempt tokenless
    // reconcile and fail closed on this platform, so reclaim must
    // surface a terminal ownership-failure rather than admitting the new run.
    const deadRunDir = join(tmp, 'dead-with-active');
    mkdirSync(deadRunDir, { recursive: true });
    writeFileSync(
      join(deadRunDir, 'active.json'),
      JSON.stringify({
        schemaVersion: 1,
        cliIdentity: { pid: 999_997, startMs: 0, command: 'orc' },
        groups: [
          {
            pgid: 1,
            leaderPid: 1,
            sessionId: 1,
            leaderStartMs: 0,
            command: 'orc',
            bootstrapExecutablePath: process.execPath,
            executablePath: 'orc'
          }
        ],
        state: 'running',
        cliRevision: 1
      }),
      { mode: 0o600 }
    );

    seedLock(projectDir, {
      schemaVersion: 1,
      runId: 'dead-run',
      pid: 999_997,
      startMs: 0,
      runDir: deadRunDir,
      command: 'orc'
    });

    await expect(
      acquireProjectLock(projectDir, liveLock('new-run', join(tmp, 'new-run')))
    ).rejects.toThrow(/terminal ownership-failure/);
  });
});
