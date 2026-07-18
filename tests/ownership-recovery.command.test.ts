import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  getProjectDir,
  getRunDir,
  type ActiveRecord,
  type LockRecord,
  type ProjectRecord
} from '../src/run-ownership.js';
import { ownershipReleaseAction, ownershipStatusAction } from '../src/commands/ownership-recovery.js';
import * as processIdentity from '../src/process-identity.js';
import type { CliOutput } from '../src/cli-output.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';

function output(): CliOutput {
  return createMockOutput({
    note: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    iterationStarted: vi.fn(),
    stepSucceeded: vi.fn(),
    stepFailed: vi.fn(),
    renderPanel: vi.fn(),
    finalSummary: vi.fn()
  });
}

describe('ownership recovery commands', () => {
  const projectRoot = join(process.cwd(), 'temp-ownership-recovery');
  let stateDir: string;
  let projectDir: string;
  let runDir: string;
  const runId = 'recovery-run';

  beforeEach(() => {
    createTempDir('temp-ownership-recovery');
    stateDir = join(projectRoot, 'state');
    projectDir = getProjectDir(projectRoot, stateDir);
    runDir = getRunDir(runId, stateDir);
    mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    chmodSync(projectDir, 0o700);
    chmodSync(runDir, 0o700);
  });

  afterEach(() => removeTempDir(projectRoot));

  function seed(holderPid = 999999): void {
    const active: ActiveRecord = {
      schemaVersion: 1,
      cliIdentity: { pid: holderPid, startMs: 0, command: process.execPath },
      groups: [],
      state: 'running',
      cliRevision: 1
    };
    const lock: LockRecord = {
      schemaVersion: 1,
      runId,
      pid: holderPid,
      startMs: 0,
      runDir,
      command: process.execPath,
      projectRoot
    };
    const project: ProjectRecord = {
      schemaVersion: 1,
      currentRunId: runId,
      runDir,
      pid: holderPid,
      startMs: 0,
      state: 'running'
    };
    writeFileSync(join(runDir, 'active.json'), JSON.stringify(active), { mode: 0o600 });
    writeFileSync(join(projectDir, 'project.lock'), JSON.stringify(lock), { mode: 0o600 });
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project), { mode: 0o600 });
  }

  it('status is diagnostic-only and reports a retained dead-holder run', async () => {
    seed();
    const activeBefore = readFileSync(join(runDir, 'active.json'), 'utf8');
    const result = await ownershipStatusAction({ project: projectRoot, stateDir, output: output() });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(projectDir, 'project.lock'))).toBe(true);
    expect(readFileSync(join(runDir, 'active.json'), 'utf8')).toBe(activeBefore);
  });

  it('release marks evidence before removing only the matching admission', async () => {
    seed();
    const result = await ownershipReleaseAction({ project: projectRoot, stateDir, yes: true, output: output() });
    expect(result.exitCode).toBe(0);
    expect(existsSync(join(projectDir, 'project.lock'))).toBe(false);
    expect(existsSync(join(projectDir, 'project.json'))).toBe(false);
    const active = JSON.parse(readFileSync(join(runDir, 'active.json'), 'utf8')) as ActiveRecord;
    expect(active.state).toBe('failed');
    expect(active.reason).toBe('operator-released');
    expect(active.recoveryAtMs).toEqual(expect.any(Number));
  });

  it('refuses release when the recorded CLI holder is live and does not mutate state', async () => {
    const resolveIdentity = vi.spyOn(processIdentity, 'resolveProcessIdentity').mockReturnValue({
      status: 'verified',
      pid: 4242,
      pgid: 4242,
      sessionId: 4242,
      executablePath: process.execPath,
      startEvidence: { value: 1, resolution: 'tick' },
      collisionResistant: true
    });
    try {
      seed(4242);
      const before = readFileSync(join(runDir, 'active.json'), 'utf8');
      const result = await ownershipReleaseAction({ project: projectRoot, stateDir, yes: true, output: output() });
      expect(result.exitCode).toBe(1);
      expect(readFileSync(join(runDir, 'active.json'), 'utf8')).toBe(before);
      expect(existsSync(join(projectDir, 'project.lock'))).toBe(true);
    } finally {
      resolveIdentity.mockRestore();
    }
  });
});
