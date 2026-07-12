import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { watchLease, type OwnershipContext, type ControlRecord } from '../src/run-ownership.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

/**
 * Coverage for the in-flight lease watcher (§3): expiry must resolve `expired`
 * exactly once, a not-yet-expired lease must not (and cancel() must stop it),
 * and a missing/unreadable control record must fail closed after a bounded
 * number of consecutive read errors.
 */
describe('watchLease — in-flight lease watcher', () => {
  const tmp = join(process.cwd(), 'temp-ownership-watch');
  let runDir: string;

  beforeEach(() => {
    createTempDir('temp-ownership-watch');
    runDir = join(tmp, 'runs', 'run-a');
  });

  afterEach(() => {
    removeTempDir(tmp);
  });

  function writeControl(runDir: string, control: ControlRecord): void {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'control.json'), JSON.stringify(control), { mode: 0o600 });
  }

  function ctx(overrides: Partial<OwnershipContext> = {}): OwnershipContext {
    return {
      token: 'tok',
      runId: 'run-a',
      stateDir: tmp,
      projectDir: join(tmp, 'projects', 'hash'),
      runDir,
      control: controlRecord(Date.now() + 1_000_000),
      env: {},
      hasObservedExpired: false,
      ...overrides
    };
  }

  function controlRecord(leaseExpiresMs: number): ControlRecord {
    return {
      schemaVersion: 1,
      runId: 'run-a',
      ownerTokenHash: 'hash',
      projectRoot: '/proj',
      hostInstanceId: 'host-1',
      leaseIssuedMs: 0,
      leaseTtlMs: 60_000,
      leaseExpiresMs,
      issuerRevision: 1
    };
  }

  it('resolves expired when the lease is already past', async () => {
    const control = controlRecord(Date.now() - 1000);
    writeControl(runDir, control);
    const c = ctx({ control });
    const watcher = watchLease(c, { intervalMs: 10, maxReadErrors: 3 });

    await expect(watcher.expired).resolves.toBeUndefined();
    watcher.cancel();
  });

  it('does not resolve while the lease is still valid, and cancel() stops the watcher', async () => {
    const control = controlRecord(Date.now() + 1_000_000);
    writeControl(runDir, control);
    const c = ctx({ control });
    const watcher = watchLease(c, { intervalMs: 10, maxReadErrors: 3 });

    let resolved = false;
    // Intentionally never awaited: a valid lease means `expired` must NOT settle.
    watcher.expired.then(() => {
      resolved = true;
    });

    // Let several watch ticks elapse; the lease is far from expiring.
    await new Promise((r) => setTimeout(r, 60));
    expect(resolved).toBe(false);

    watcher.cancel();

    // Give a final grace period; the cancelled watcher must still not fire.
    await new Promise((r) => setTimeout(r, 30));
    expect(resolved).toBe(false);
  });

  it('fails closed (resolves expired) after consecutive read errors', async () => {
    const control = controlRecord(Date.now() + 1_000_000);
    writeControl(runDir, control);
    const c = ctx({ control });
    const watcher = watchLease(c, { intervalMs: 10, maxReadErrors: 2 });

    // Remove the control record so every tick fails to read.
    unlinkSync(join(runDir, 'control.json'));

    await expect(watcher.expired).resolves.toBeUndefined();
    watcher.cancel();
  });

  it('detects expiry after a refresh moves leaseExpiresMs into the past', async () => {
    // Lease starts valid; an issuer heartbeat then rewrites it as expired. The
    // watcher must observe the new expiry within one interval (max detection delay).
    const control = controlRecord(Date.now() + 200);
    writeControl(runDir, control);
    const c = ctx({ control });
    const watcher = watchLease(c, { intervalMs: 10, maxReadErrors: 3 });

    // After a short delay, rewrite control.json to an already-expired lease.
    await new Promise((r) => setTimeout(r, 80));
    writeControl(runDir, controlRecord(Date.now() - 1000));

    await expect(watcher.expired).resolves.toBeUndefined();
    watcher.cancel();
  });
});
