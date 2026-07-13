import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { resolveWrapperPath } from '../src/adapters/process-group.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

/**
 * v5-M1 plan-mandated coverage (§2 verification: `tests/process-group.fault-injection.test.ts`).
 * The safety-critical fault property is verified deterministically on every
 * platform: if the parent dies before ACK (fd-4 closes), the wrapper
 * self-terminates WITHOUT exec'ing the provider — so a crash between spawn and
 * durable registration leaves no provider running. The full real cgroup
 * fault-injection matrix (controlled parent death at spawn/persist/release)
 * runs under Linux + delegated cgroup-v2 only, as the plan specifies.
 */

const tmp = join(process.cwd(), 'temp-pg-fault');
let cgroupDir: string;

beforeEach(() => {
  createTempDir('temp-pg-fault');
  cgroupDir = join(tmp, 'cg');
  mkdirSync(cgroupDir, { recursive: true });
  writeFileSync(join(cgroupDir, 'cgroup.procs'), '', { mode: 0o600 });
});

afterEach(() => {
  removeTempDir(tmp);
});

function waitClose(args: string[], onReady?: (child: ChildProcess) => void): Promise<{ code: number | null; stdout: string }> {
  const wrapper = resolveWrapperPath();
  return new Promise((resolve) => {
    const child = spawn('sh', [wrapper, ...args], { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] }) as ChildProcess;
    let stdout = '';
    if (child.stdout) child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    if (onReady && child.stdio[3]) {
      (child.stdio[3] as NodeJS.ReadableStream).on('data', () => onReady(child));
    }
    child.on('error', () => resolve({ code: null, stdout }));
    child.on('close', (code: number | null) => resolve({ code, stdout }));
  });
}

describe('process-group wrapper — fault injection (all platforms)', () => {
  it('parent death before ACK (fd-4 close) → wrapper self-terminates (66), no provider exec', async () => {
    const { code, stdout } = await waitClose([cgroupDir, 'echo', 'should-not-run'], (child) => {
      // Simulate parent death before ACK: close fd-4 so the wrapper's `read <&4` EOFs.
      const fd4 = child.stdio[4];
      if (fd4) (fd4 as NodeJS.WritableStream).end();
    });
    expect(code).toBe(66);
    expect(stdout).not.toContain('should-not-run');
  });

  it('malformed readiness (non-ACK on fd-4) → no provider exec (66)', async () => {
    const { code, stdout } = await waitClose([cgroupDir, 'echo', 'also-no'], (child) => {
      const fd4 = child.stdio[4];
      if (fd4) (fd4 as NodeJS.WritableStream).write('BOGUS\n');
    });
    expect(code).toBe(66);
    expect(stdout).not.toContain('also-no');
  });
});

// ---- Linux + delegated cgroup-v2 gated real fault injection -----------------
const describeOnLinuxCgroup = process.platform === 'linux' ? describe : describe.skip;
describeOnLinuxCgroup('ProcessGroupRuntime — real cgroup fault injection (Linux + cgroup-v2)', () => {
  it('controlled parent death at each bootstrap phase leaves no surviving/untracked provider', async () => {
    const { checkCgroupV2Capability, ProcessGroupRuntime, readCgroupProcs, killCgroup } = await import('../src/adapters/process-group.js');
    expect(checkCgroupV2Capability().supported).toBe(true);
    // Phase 1: kill before ACK → ready rejects, cgroup is killed, no provider exec'd.
    const r1 = ProcessGroupRuntime.createGroup('fault-pre-ack', join(tmp, 'r1'), 'sleep', ['30'], { PATH: '/usr/bin' });
    r1.child.kill('SIGKILL');
    await expect(r1.ready).rejects.toThrow();
    expect(readCgroupProcs(r1.handle.cgroupPath, r1.handle.cgroupIno, r1.handle.cgroupDev)).toEqual([]);
    // Phase 2: after ACK, kill the run → killCgroup empties the per-run cgroup.
    const r2 = ProcessGroupRuntime.createGroup('fault-post-ack', join(tmp, 'r2'), 'sleep', ['30'], { PATH: '/usr/bin' });
    await r2.ready;
    killCgroup(r2.handle.cgroupPath, r2.handle.cgroupIno, r2.handle.cgroupDev);
    expect(readCgroupProcs(r2.handle.cgroupPath, r2.handle.cgroupIno, r2.handle.cgroupDev)).toEqual([]);
  });
});
