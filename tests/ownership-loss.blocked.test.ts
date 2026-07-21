import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { handleOwnershipLoss, clearInterruptState } from '../src/interrupted-artifact.js';
import type { OwnershipContext, ControlRecord } from '../src/run-ownership.js';
import type { LoopSpec } from '../src/manifest.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { registerOwnedRuntime, resetOwnedRuntimeRegistryForTests } from '../src/owned-runtime-registry.js';

/**
 * C2 core coverage: handleOwnershipLoss must NEVER throw out of the lease-expiry
 * race. It returns a discriminated result — `ownership-stopped` when cleanup
 * completes (admission released) and `ownership-blocked` for a terminal
 * ownership-failure (admission retained, operator recovery). The previous code
 * threw on terminal conditions, so Promise.race rejected and runLoop reported a
 * generic 'unknown' failure instead of an ownership outcome.
 */
describe('handleOwnershipLoss — structured result, no escape', () => {
  const tmp = join(process.cwd(), 'temp-ownership-loss');
  let runDir: string;
  let projectDir: string;
  const loopSpec: LoopSpec = {
    type: 'approval-loop',
    target: { path: 'docs/dev/plan.md', kind: 'file' },
    inputs: [],
    evaluate: { skill: 'plan-audit', output: { pattern: 'docs/dev/plan-audit-v{version}-{provider}.md', contract: 'decision-artifact', decision: { heading: 'Verdict', accepted: 'APPROVED', retry: 'REJECTED' } } },
    repair: { skill: 'plan-followup', output: { pattern: 'docs/dev/plan-followup-v{version}-{provider}.md', contract: 'completion-artifact' } }
  } as LoopSpec;

  beforeEach(() => {
    createTempDir('temp-ownership-loss');
    runDir = join(tmp, 'runs', 'run-a');
    projectDir = join(tmp, 'projects', 'hash');
    clearInterruptState();
    resetOwnedRuntimeRegistryForTests();
  });

  afterEach(() => {
    resetOwnedRuntimeRegistryForTests();
    removeTempDir(tmp);
  });

  const control: ControlRecord = {
    schemaVersion: 1,
    runId: 'run-a',
    ownerTokenHash: 'hash',
    projectRoot: '/proj',
    hostInstanceId: 'host-1',
    leaseIssuedMs: 0,
    leaseTtlMs: 60_000,
    leaseExpiresMs: 0,
    issuerRevision: 1
  };

  function ctx(): OwnershipContext {
    return {
      token: 'tok',
      runId: 'run-a',
      stateDir: tmp,
      projectDir,
      runDir,
      control,
      env: {},
      hasObservedExpired: true
    };
  }

  function writeActive(groups: unknown[], state = 'running'): void {
    mkdirSync(runDir, { recursive: true });
    chmodSync(runDir, 0o700);
    writeFileSync(
      join(runDir, 'active.json'),
      JSON.stringify({
        schemaVersion: 1,
        cliIdentity: { pid: process.pid, startMs: 0, command: 'orc' },
        groups,
        state,
        cliRevision: 1
      }),
      { mode: 0o600 }
    );
  }

  it('resolves ownership-stopped when there are no registered groups (clean release)', async () => {
    writeActive([]);
    const result = await handleOwnershipLoss(loopSpec, ctx());

    expect(result.kind).toBe('ownership-stopped');
    const active = JSON.parse(readFileSync(join(runDir, 'active.json'), 'utf-8'));
    expect(active.state).toBe('stopped');
    expect(active.reason).toBe('ownership-lost');
    expect(active.groups).toEqual([]);
  });

  it('resolves ownership-blocked (does NOT throw) when a registered group cannot be terminated', async () => {
    // A registered group whose leader is gone cannot be verified-owned, so the
    // kill gate refuses to signal it (a recycled PGID must never be signalled).
    // The previous implementation threw here; the fix records a terminal
    // ownership-failure and resolves as blocked so the race never escapes.
    // pgid 1 is also structurally forbidden, so no real signal is ever sent.
    writeActive([
      {
        pgid: 1,
        leaderPid: 1,
        sessionId: 1,
        leaderStartMs: 0,
        command: 'orc',
        bootstrapExecutablePath: process.execPath,
        executablePath: 'orc'
      }
    ]);
    mkdirSync(projectDir, { recursive: true });
    chmodSync(projectDir, 0o700);
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ schemaVersion: 1, currentRunId: 'run-a', runDir, pid: process.pid, startMs: 0, state: 'starting' }),
      { mode: 0o600 }
    );

    const result = await handleOwnershipLoss(loopSpec, ctx());

    expect(result.kind).toBe('ownership-blocked');
    // Admission retained: active.json is in a terminal ownership-failure state.
    const active = JSON.parse(readFileSync(join(runDir, 'active.json'), 'utf-8'));
    expect(active.state).toBe('failed');
  });

  it('is idempotent: a concurrent re-entry returns ownership-stopped without re-running cleanup', async () => {
    writeActive([]);
    const [a, b] = await Promise.all([
      handleOwnershipLoss(loopSpec, ctx()),
      handleOwnershipLoss(loopSpec, ctx())
    ]);
    expect(a.kind).toBe('ownership-stopped');
    // Second entry hit the once-flag and short-circuited.
    expect(b.kind).toBe('ownership-stopped');
  });

  it('uses the registered fresh capability instead of reconstructing durable authority', async () => {
    const group = {
      pgid: 4242,
      leaderPid: 4242,
      sessionId: 4242,
      leaderStartMs: 1,
      command: 'provider',
      bootstrapExecutablePath: process.execPath,
      executablePath: process.execPath
    };
    writeActive([group]);
    const projectRecordPath = join(projectDir, 'project.json');
    mkdirSync(projectDir, { recursive: true });
    chmodSync(projectDir, 0o700);
    writeFileSync(projectRecordPath, JSON.stringify({
      schemaVersion: 1,
      currentRunId: 'run-a',
      runDir,
      pid: process.pid,
      startMs: 0,
      state: 'running'
    }), { mode: 0o600 });

    const terminate = vi.fn(async () => ({
      outcome: 'already-gone' as const,
      sent: false as const,
      signal: 'SIGTERM' as const,
      target: { pgid: 4242, leaderPid: 4242, source: 'fresh' as const },
      reason: 'fixture capability terminated the group'
    }));
    const retireIfClosed = vi.fn(async () => {
      const activePath = join(runDir, 'active.json');
      const active = JSON.parse(readFileSync(activePath, 'utf8'));
      active.groups = [];
      writeFileSync(activePath, JSON.stringify(active), { mode: 0o600 });
      return true;
    });
    registerOwnedRuntime({
      epoch: Symbol('fresh-test'),
      runId: 'run-a',
      runDir,
      bootstrap: { pid: 4242 } as any,
      handle: group,
      terminate,
      retireIfClosed
    });

    const result = await handleOwnershipLoss(loopSpec, ctx());
    expect(result.kind).toBe('ownership-stopped');
    expect(terminate).toHaveBeenCalledWith(2000);
    expect(retireIfClosed).toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(runDir, 'active.json'), 'utf8')).state).toBe('stopped');
  });
});
