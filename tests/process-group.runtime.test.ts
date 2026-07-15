import { describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';

interface RuntimeHelperReport {
  ok: boolean;
  error?: string;
  helperPid: number;
  bootstrapPid?: number;
  providerPid?: number;
  childPid?: number;
  allowedPgid?: number;
  signals?: Array<{ pid: number; signal: NodeJS.Signals | 0 }>;
  activeState?: string;
  activeGroups?: unknown[];
  pidsGone?: boolean;
  relaunchAdmitted?: boolean;
  leaseWasValidAtProviderReady?: boolean;
  cleanupSource?: string;
  signalsBeforeAllowlist?: number;
  senderRejections?: number;
  allowlistArmed?: boolean;
}

const helperPath = join(process.cwd(), 'tests/helpers/owned-runtime-lease-loss-helper.mjs');

function waitForExit(
  child: ChildProcess,
  timeoutMs: number,
  observedExit: { value?: { code: number | null; signal: NodeJS.Signals | null } }
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (observedExit.value) return Promise.resolve(observedExit.value);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runtime helper did not exit within ${timeoutMs}ms`)), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      observedExit.value = { code, signal };
      resolve(observedExit.value);
    });
  });
}

async function terminateDirectHelper(
  child: ChildProcess,
  observedExit: { value?: { code: number | null; signal: NodeJS.Signals | null } },
  graceMs = 250
): Promise<void> {
  if (observedExit.value) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // The direct child handle is the only parent-side cleanup authority.
  }
  await new Promise((resolve) => setTimeout(resolve, graceMs));
  if (observedExit.value) return;
  try {
    child.kill('SIGKILL');
  } catch {
    // The child may have exited between the observation and the escalation.
  }
}

async function runRuntimeHelper(root: string): Promise<RuntimeHelperReport> {
  const helper = fork(helperPath, [root], {
    execPath: process.execPath,
    execArgv: ['--import', 'tsx/esm'],
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  let stderr = '';
  let resultReceived = false;
  const observedExit: { value?: { code: number | null; signal: NodeJS.Signals | null } } = {};
  helper.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  helper.on('exit', (code, signal) => { observedExit.value = { code, signal }; });

  const message = new Promise<RuntimeHelperReport>((resolve, reject) => {
    helper.on('message', (value: RuntimeHelperReport & { type?: string }) => {
      if (value?.ok !== undefined) {
        resultReceived = true;
        resolve(value);
      }
    });
    helper.once('exit', (code, signal) => {
      if (!resultReceived) {
        reject(new Error(`runtime helper exited before result (code=${code}, signal=${signal}, stderr=${stderr})`));
      }
    });
  });

  try {
    const result = await Promise.race([
      message,
      new Promise<RuntimeHelperReport>((_, reject) => {
        setTimeout(() => reject(new Error(`runtime helper timed out (stderr=${stderr})`)), 30_000).unref();
      })
    ]);
    await waitForExit(helper, 5_000, observedExit).catch(async () => {
      await terminateDirectHelper(helper, observedExit);
      throw new Error(`runtime helper returned a result but did not exit (stderr=${stderr})`);
    });
    if (!result.ok) throw new Error(result.error ?? `runtime helper failed (stderr=${stderr})`);
    return result;
  } catch (error) {
    await terminateDirectHelper(helper, observedExit);
    throw error;
  }
}

describe('owned process-group runtime', () => {
  it('uses only the direct ChildProcess handle for parent timeout cleanup', async () => {
    const signals: NodeJS.Signals[] = [];
    const child = {
      kill(signal: NodeJS.Signals) {
        signals.push(signal);
        return true;
      }
    } as unknown as ChildProcess;

    await terminateDirectHelper(child, {}, 0);

    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('reaps a running provider and cooperative child through fresh lease-loss authority', async () => {
    const root = mkdtempSync(join(process.cwd(), 'temp-process-group-runtime-'));
    try {
      const result = await runRuntimeHelper(root);

      expect(result.allowedPgid).toBe(result.bootstrapPid);
      expect(result.signals?.length).toBeGreaterThan(0);
      expect(result.signals?.every(({ pid }) => pid === -(result.allowedPgid ?? 0))).toBe(true);
      expect(result.activeState).toBe('stopped');
      expect(result.activeGroups).toEqual([]);
      expect(result.pidsGone).toBe(true);
      expect(result.relaunchAdmitted).toBe(true);
      expect(result.leaseWasValidAtProviderReady).toBe(true);
      expect(result.cleanupSource).toBe('watchLease');
      expect(result.signalsBeforeAllowlist).toBe(0);
      expect(result.senderRejections).toBe(0);
      expect(result.allowlistArmed).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
