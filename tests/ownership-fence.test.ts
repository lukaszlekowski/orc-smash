import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { ownershipFence, type OwnershipContext, type ControlRecord } from '../src/run-ownership.js';
import { clearInterruptState } from '../src/interrupted-artifact.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import type { LoopSpec } from '../src/manifest.js';

/**
 * Coverage for the completion-side ownership fence (§3): after the provider run
 * resolves, the fence re-reads control.json. A valid lease lets the step
 * advance; an expired (or drifted) lease routes through handleOwnershipLoss and
 * returns false so runLoop performs no provenance/state advancement.
 */
describe('ownershipFence — completion-side gate', () => {
  const tmp = join(process.cwd(), 'temp-ownership-fence');
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
    createTempDir('temp-ownership-fence');
    runDir = join(tmp, 'runs', 'run-a');
    projectDir = join(tmp, 'projects', 'hash');
    clearInterruptState();
  });

  afterEach(() => {
    removeTempDir(tmp);
  });

  function controlRecord(leaseExpiresMs: number): ControlRecord {
    const leaseIssuedMs = leaseExpiresMs - 60_000;
    return {
      schemaVersion: 1,
      runId: 'run-a',
      ownerTokenHash: 'hash',
      projectRoot: '/proj',
      hostInstanceId: 'host-1',
      leaseIssuedMs,
      leaseTtlMs: 60_000,
      leaseExpiresMs,
      issuerRevision: 1
    };
  }

  function writeControl(record: ControlRecord): void {
    mkdirSync(runDir, { recursive: true });
    chmodSync(runDir, 0o700);
    writeFileSync(join(runDir, 'control.json'), JSON.stringify(record), { mode: 0o600 });
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

  function ctx(control: ControlRecord): OwnershipContext {
    return {
      token: 'tok',
      runId: 'run-a',
      stateDir: tmp,
      projectDir,
      runDir,
      control,
      env: {},
      hasObservedExpired: false
    };
  }

  it('passes when the lease is still valid', async () => {
    const control = controlRecord(Date.now() + 1_000_000);
    writeControl(control);
    const passed = await ownershipFence(ctx(control), loopSpec);
    expect(passed).toBe(true);
  });

  it('fails (routes to ownership loss) when the lease expired before completion', async () => {
    const control = controlRecord(Date.now() - 1000);
    writeControl(control);
    // handleOwnershipLoss reads active.json; empty groups → clean stop.
    writeActive([]);

    const passed = await ownershipFence(ctx(control), loopSpec);
    expect(passed).toBe(false);

    // The fence routed through handleOwnershipLoss which wrote a terminal-ish state.
    const active = JSON.parse(readFileSync(join(runDir, 'active.json'), 'utf-8'));
    expect(['stopped', 'failed']).toContain(active.state);
  });

  it('fails on issuer identity drift even with time left on the lease', async () => {
    const control = controlRecord(Date.now() + 1_000_000);
    writeControl(control);
    writeActive([]);

    // ctx.control disagrees with the on-disk hostInstanceId → drift → fail.
    const drifted: ControlRecord = { ...control, hostInstanceId: 'host-OTHER' };
    const passed = await ownershipFence(ctx(drifted), loopSpec);
    expect(passed).toBe(false);
  });
});
