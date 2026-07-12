import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleOwnershipLoss, clearInterruptState } from '../src/interrupted-artifact.js';
import type { OwnershipContext, ControlRecord } from '../src/run-ownership.js';
import type { LoopSpec } from '../src/manifest.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

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
    kind: 'doc-audit',
    target: 'docs/dev/plan.md',
    targetKind: 'file',
    audit: 'plan-audit',
    'follow-up': 'plan-followup',
    auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
    followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md',
    inputs: []
  } as LoopSpec;

  beforeEach(() => {
    createTempDir('temp-ownership-loss');
    runDir = join(tmp, 'runs', 'run-a');
    projectDir = join(tmp, 'projects', 'hash');
    clearInterruptState();
  });

  afterEach(() => {
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
    writeFileSync(
      join(runDir, 'active.json'),
      JSON.stringify({
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
    // A registered group whose cgroup cannot be validated (cgroup-v2 is
    // unavailable on non-Linux) makes live-run authorization fail. The previous
    // implementation threw here; the fix records a terminal ownership-failure
    // and resolves as blocked so the race never escapes.
    writeActive([
      {
        cgroupPath: '/sys/fs/cgroup/orc-smash/run-a',
        pgid: 1,
        leaderPid: 1,
        leaderStartMs: 0,
        command: 'orc'
      }
    ]);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ currentRunId: 'run-a', runDir, pid: process.pid, startMs: 0, state: 'starting' }),
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
});
