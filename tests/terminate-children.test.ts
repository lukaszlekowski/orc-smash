import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  runProcess,
  terminateActiveChildren,
  registerActiveChild,
  resetActiveChildren
} from '../src/adapters/utils.js';

/**
 * §3 interrupted child cleanup: a real long-lived child spawned through the
 * process runner is terminated by `terminateActiveChildren`, leaving no orphan.
 */
describe('terminateActiveChildren — real child termination', () => {
  let tracked: ChildProcess[] = [];

  beforeEach(() => {
    resetActiveChildren();
    tracked = [];
  });

  afterEach(async () => {
    // Defensive cleanup: ensure no tracked child outlives the test.
    for (const p of tracked) {
      try {
        if (!p.killed) p.kill('SIGKILL');
      } catch {
        // already gone
      }
    }
    resetActiveChildren();
  });

  it('is a no-op when no children are active', async () => {
    await expect(terminateActiveChildren(50)).resolves.toBeUndefined();
  });

  it('terminates a real long-lived child spawned via runProcess (SIGTERM)', async () => {
    // Start a 30s sleep through the shared runner (which registers the child).
    const procPromise = runProcess({ command: 'sleep', args: ['30'], cwd: '/tmp' });
    // Let the process actually spawn before terminating.
    await new Promise((r) => setTimeout(r, 150));

    await terminateActiveChildren(200);
    const result = await procPromise;

    // The child was terminated by signal, not allowed to run its full 30s.
    expect(result.signal).toBeTruthy();
    expect(result.durationMs).toBeLessThan(30_000);
  });

  it('terminates a child registered directly via registerActiveChild', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    tracked.push(child);
    registerActiveChild(child);
    // Wait for spawn.
    await new Promise((r) => setTimeout(r, 150));

    await terminateActiveChildren(200);
    // The child should now be killed.
    expect(child.killed).toBe(true);
  });
});
