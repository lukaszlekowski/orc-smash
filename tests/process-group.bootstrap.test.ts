import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveWrapperPath } from '../src/adapters/process-group.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

/**
 * v5-M1 plan-mandated coverage (§2 verification: `tests/process-group.bootstrap.test.ts`).
 * The normative POSIX-shell wrapper contract is verified deterministically on
 * every platform: argv shape (`[wrapper, cgroupPath, provider, ...args]`), the
 * cgroup self-join, the framed fd-3 READY record, the fd-4 ACK gate, and that
 * the same pid then execs exactly the original provider argv. The full real
 * cgroup bootstrap (ProcessGroupRuntime.createGroup membership/ACK) runs under
 * Linux + delegated cgroup-v2 only, as the plan specifies.
 */

const tmp = join(process.cwd(), 'temp-pg-bootstrap');
let cgroupDir: string;

beforeEach(() => {
  createTempDir('temp-pg-bootstrap');
  cgroupDir = join(tmp, 'cg');
  mkdirSync(cgroupDir, { recursive: true });
  // The wrapper writes its pid here as `printf $$ > cgroup.procs`.
  writeFileSync(join(cgroupDir, 'cgroup.procs'), '', { mode: 0o600 });
});

afterEach(() => {
  removeTempDir(tmp);
});

function waitCode(args: string[], stdio: Array<'ignore' | 'pipe'>): Promise<{ code: number | null; stderr: string }> {
  const wrapper = resolveWrapperPath();
  return new Promise((resolve) => {
    const child = spawn('sh', [wrapper, ...args], { stdio });
    let stderr = '';
    if (child.stderr) child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', () => resolve({ code: null, stderr }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

describe('process-group wrapper — bootstrap contract (all platforms)', () => {
  it('resolveWrapperPath points at an existing, readable wrapper asset', () => {
    const p = resolveWrapperPath();
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf-8')).toContain('exec "$@"');
  });

  it('exits 64 when given fewer than two arguments', async () => {
    const { code } = await waitCode([], ['ignore', 'pipe', 'pipe']);
    expect(code).toBe(64);
  });

  it('exits 65 when the cgroup.procs self-join target is not writable', async () => {
    // A nonexistent cgroup dir → `printf $$ > <dir>/cgroup.procs` fails → exit 65
    // before any readiness/ACK handling. fd3/fd4 are ignored so worker-fd
    // inheritance cannot perturb the result.
    const { code } = await waitCode([join(tmp, 'does-not-exist'), 'echo', 'hi'], ['ignore', 'pipe', 'pipe', 'ignore', 'ignore']);
    expect(code).toBe(65);
  });

  it('self-joins the cgroup, emits a framed READY on fd-3, and execs the provider only after ACK on fd-4', async () => {
    const wrapper = resolveWrapperPath();
    const result = await new Promise<{ code: number | null; ready: string; providerStdout: string; stderr: string }>((resolve) => {
      const child = spawn('sh', [wrapper, cgroupDir, 'echo', 'from-provider'], {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
      });
      let ready = '';
      let providerStdout = '';
      let stderr = '';
      const fd3 = child.stdio[3] as NodeJS.ReadableStream | null;
      const fd4 = child.stdio[4] as NodeJS.WritableStream | null;
      if (fd3) {
        fd3.on('data', (d: Buffer) => {
          ready += d.toString();
          if (fd4) fd4.write('ACK\n');
        });
      }
      if (child.stdout) child.stdout.on('data', (d: Buffer) => { providerStdout += d.toString(); });
      if (child.stderr) child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', () => resolve({ code: null, ready, providerStdout, stderr }));
      child.on('close', (code: number | null) => resolve({ code, ready, providerStdout, stderr }));
    });

    expect(result.code).toBe(0);
    // Framed READY: READY\tpid\tpgid\tsid\tcgroupPath (wrapper reports $$ for all three).
    const match = result.ready.match(/^READY\t(\d+)\t(\d+)\t(\d+)\t(.+)\s*$/);
    expect(match).not.toBeNull();
    const reportedPid = match![1]!;
    expect(reportedPid).toBe(match![2]!); // pgid === pid
    expect(reportedPid).toBe(match![3]!); // sid === pid
    expect(match![4]!.trim()).toBe(cgroupDir);
    // The wrapper self-joined the cgroup before reporting readiness.
    expect(readFileSync(join(cgroupDir, 'cgroup.procs'), 'utf-8').trim()).toBe(reportedPid);
    // After ACK, the provider exec'd with EXACTLY the original argv (no cgroup arg).
    expect(result.providerStdout).toContain('from-provider');
  });

  it('does NOT exec the provider when ACK is not ACK (exit 66)', async () => {
    const wrapper = resolveWrapperPath();
    const result = await new Promise<{ code: number | null; providerStdout: string }>((resolve) => {
      const child = spawn('sh', [wrapper, cgroupDir, 'echo', 'should-not-run'], {
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
      });
      let providerStdout = '';
      const fd3 = child.stdio[3] as NodeJS.ReadableStream | null;
      const fd4 = child.stdio[4] as NodeJS.WritableStream | null;
      if (fd3) fd3.on('data', () => { if (fd4) fd4.write('NOTACK\n'); });
      if (child.stdout) child.stdout.on('data', (d: Buffer) => { providerStdout += d.toString(); });
      child.on('error', () => resolve({ code: null, providerStdout }));
      child.on('close', (code: number | null) => resolve({ code, providerStdout }));
    });
    expect(result.code).toBe(66);
    expect(result.providerStdout).not.toContain('should-not-run');
  });
});

// ---- Linux + delegated cgroup-v2 gated real bootstrap -----------------------
const describeOnLinuxCgroup = process.platform === 'linux' ? describe : describe.skip;
describeOnLinuxCgroup('ProcessGroupRuntime.createGroup — real cgroup bootstrap (Linux + cgroup-v2)', () => {
  it('creates the per-run cgroup, spawns the wrapper, validates readiness, and ACKs after registerGroup', async () => {
    const { checkCgroupV2Capability, ProcessGroupRuntime } = await import('../src/adapters/process-group.js');
    const cap = checkCgroupV2Capability();
    expect(cap.supported).toBe(true);
    const { getProcessStartTime } = await import('../src/run-ownership.js');
    const result = ProcessGroupRuntime.createGroup('bootstrap-test-run', join(tmp, 'run'), 'sleep', ['1'], { PATH: '/usr/bin' });
    expect(result.child.pid).toBeGreaterThan(0);
    await expect(result.ready).resolves.toBeUndefined();
    expect(getProcessStartTime(result.child.pid!)).toBeGreaterThan(0);
    result.child.kill('SIGKILL');
  });
});
