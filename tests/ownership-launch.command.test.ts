import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as crypto from 'node:crypto';
import { openOwnedRun, type OwnershipLaunchInput } from '../src/commands/ownership-launch.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

/**
 * v5-M1 plan-mandated coverage (§1 verification: `tests/ownership-launch.command.test.ts`).
 * Exercises the `openOwnedRun()` command boundary: app-owned activation, child-env
 * scrubbing, plaintext-token retention, and fail-closed partial / mismatched /
 * missing-control launches. `checkCgroupV2Capability` is mocked so the app-owned
 * happy path is deterministic on non-Linux (the capability gate is exercised
 * separately by the process-group tests); the admission lock + control-record
 * validation are the real implementations.
 */

let tmpBase = '';
let savedEnv: NodeJS.ProcessEnv;

vi.mock('../src/adapters/process-group.js', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    // Pretend cgroup-v2 is available + delegated so openOwnedRun proceeds past
    // the capability gate. (No cgroup is actually created on the happy path.)
    checkCgroupV2Capability: () => ({ supported: true, delegatedRoot: tmpBase || '/tmp' })
  };
});

describe('openOwnedRun — command-level activation + env scrubbing', () => {
  const projectRoot = join(process.cwd(), 'temp-ownership-launch');
  const runId = 'run-test-1';
  const token = 'secret-token-xyz';
  let runDir: string;

  beforeEach(() => {
    createTempDir('temp-ownership-launch');
    tmpBase = join(projectRoot, 'runstate');
    runDir = join(tmpBase, 'orc-smash', 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    savedEnv = { ...process.env };
    delete process.env.ORC_RUN_ID;
    delete process.env.ORC_RUN_TOKEN;
    delete process.env.ORC_RUN_STATE_DIR;
  });

  afterEach(() => {
    for (const k of ['ORC_RUN_ID', 'ORC_RUN_TOKEN', 'ORC_RUN_STATE_DIR']) delete process.env[k];
    Object.assign(process.env, savedEnv);
    removeTempDir(projectRoot);
  });

  function writeControl(overrides: Partial<ReturnType<typeof baseControl>> = {}): void {
    writeFileSync(join(runDir, 'control.json'), JSON.stringify({ ...baseControl(), ...overrides }), { mode: 0o600 });
  }
  function baseControl() {
    return {
      schemaVersion: 1,
      runId,
      ownerTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      projectRoot,
      hostInstanceId: 'host-1',
      leaseIssuedMs: 0,
      leaseTtlMs: 60_000,
      leaseExpiresMs: Date.now() + 60_000,
      issuerRevision: 1
    };
  }

  function launchInput(): OwnershipLaunchInput {
    return {
      runId: process.env['ORC_RUN_ID'],
      token: process.env['ORC_RUN_TOKEN'],
      stateDir: process.env['ORC_RUN_STATE_DIR']
    };
  }

  it('both env absent → null (terminal mode, mutually exclusive)', async () => {
    const ctx = await openOwnedRun(launchInput(), projectRoot);
    expect(ctx).toBeNull();
  });

  it('app-owned mode: scrubs ORC_RUN_* from the child env and retains the plaintext token only in context', async () => {
    process.env['ORC_RUN_ID'] = runId;
    process.env['ORC_RUN_TOKEN'] = token;
    process.env['ORC_RUN_STATE_DIR'] = tmpBase;
    writeControl();

    const ctx = await openOwnedRun(launchInput(), projectRoot);

    expect(ctx).not.toBeNull();
    // Plaintext token lives only in the in-memory context.
    expect(ctx!.token).toBe(token);
    expect(ctx!.runId).toBe(runId);
    // The owned child environment must NOT carry ownership-control inputs.
    expect(ctx!.env).not.toHaveProperty('ORC_RUN_TOKEN');
    expect(ctx!.env).not.toHaveProperty('ORC_RUN_ID');
    expect(ctx!.env).not.toHaveProperty('ORC_RUN_STATE_DIR');
    // Regular environment is otherwise inherited.
    expect(ctx!.env['PATH']).toBe(process.env['PATH']);
  });

  it('partial (ID without TOKEN) → fail closed (no silent terminal fallback)', async () => {
    process.env['ORC_RUN_ID'] = runId;
    // ORC_RUN_TOKEN intentionally unset
    writeControl();
    await expect(openOwnedRun(launchInput(), projectRoot)).rejects.toThrow(/Ambiguous mode/);
  });

  it('partial (TOKEN without ID) → fail closed', async () => {
    process.env['ORC_RUN_TOKEN'] = token;
    // ORC_RUN_ID intentionally unset
    writeControl();
    await expect(openOwnedRun(launchInput(), projectRoot)).rejects.toThrow(/Ambiguous mode/);
  });

  it('owner-token mismatch → fail closed, no admission acquired', async () => {
    process.env['ORC_RUN_ID'] = runId;
    process.env['ORC_RUN_TOKEN'] = token;
    process.env['ORC_RUN_STATE_DIR'] = tmpBase;
    writeControl({ ownerTokenHash: crypto.createHash('sha256').update('wrong-token').digest('hex') });
    await expect(openOwnedRun(launchInput(), projectRoot)).rejects.toThrow(/Owner token mismatch/);
  });

  it('missing control record → fail closed', async () => {
    process.env['ORC_RUN_ID'] = runId;
    process.env['ORC_RUN_TOKEN'] = token;
    process.env['ORC_RUN_STATE_DIR'] = tmpBase;
    // No control.json written.
    expect(existsSync(join(runDir, 'control.json'))).toBe(false);
    await expect(openOwnedRun(launchInput(), projectRoot)).rejects.toThrow(/control.json not found/);
  });

  it('project-root mismatch → fail closed', async () => {
    process.env['ORC_RUN_ID'] = runId;
    process.env['ORC_RUN_TOKEN'] = token;
    process.env['ORC_RUN_STATE_DIR'] = tmpBase;
    // A real, different canonical root (realpath-able) → mismatch detected.
    const otherRoot = join(projectRoot, 'other-root');
    mkdirSync(otherRoot, { recursive: true });
    writeControl({ projectRoot: otherRoot });
    await expect(openOwnedRun(launchInput(), projectRoot)).rejects.toThrow(/Project root mismatch/);
  });
});
