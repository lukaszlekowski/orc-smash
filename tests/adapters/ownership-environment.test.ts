import { describe, it, expect } from 'vitest';
import { createCodexAdapter } from '../../src/adapters/codex.js';
import { createClaudeAdapter } from '../../src/adapters/claude.js';
import { createAgyAdapter } from '../../src/adapters/agy.js';
import { createOpencodeAdapter } from '../../src/adapters/opencode.js';
import { fakeAdapter } from '../../src/adapters/fake.js';
import type { AgentAdapter, RunInput } from '../../src/adapters/types.js';
import type { SpawnRuntime } from '../../src/adapters/process-group.js';
import type { RawProcessResult, ProcessRunner } from '../../src/adapters/utils.js';
import type { OwnershipContext } from '../../src/run-ownership.js';

/**
 * v5-M1 plan-mandated coverage (§2 verification: per-adapter owned-mode tests).
 * In owned mode every adapter must spawn the provider with the single scrubbed
 * `OwnershipContext.env` (no ORC_RUN_TOKEN / ORC_RUN_ID / ORC_RUN_STATE_DIR); in
 * terminal mode the legacy runner is used and the owned runtime is bypassed.
 * Deterministic: a capturing SpawnRuntime replaces real process creation.
 */

function okRaw(): RawProcessResult {
  return { stdout: '', stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 };
}

/** A SpawnRuntime that captures the env it is asked to spawn with. */
function captureRuntime() {
  let capturedEnv: Record<string, string> | undefined;
  let spawnCalls = 0;
  const runtime: SpawnRuntime = {
    spawn: (req) => {
      spawnCalls++;
      capturedEnv = req.env;
      return { result: Promise.resolve(okRaw()), ready: Promise.resolve() };
    }
  };
  return {
    runtime,
    env: () => capturedEnv,
    calls: () => spawnCalls
  };
}

const scrubbedEnv: Record<string, string> = { PATH: '/usr/bin', HOME: '/tmp', SOME_TOOL_VAR: '1' };

function ownership(): OwnershipContext {
  return {
    token: 'secret-token',
    runId: 'run-1',
    stateDir: '/tmp',
    projectDir: '/tmp/p',
    runDir: '/tmp/r',
    control: {
      schemaVersion: 1, runId: 'run-1',
      ownerTokenHash: 'h', projectRoot: '/proj', hostInstanceId: 'h',
      leaseIssuedMs: 0, leaseTtlMs: 60_000, leaseExpiresMs: Date.now() + 60_000, issuerRevision: 1
    },
    env: scrubbedEnv
  };
}

const adapters: Array<{ name: string; adapter: AgentAdapter }> = [
  { name: 'codex', adapter: createCodexAdapter() },
  { name: 'claude', adapter: createClaudeAdapter() },
  { name: 'agy', adapter: createAgyAdapter() },
  { name: 'opencode', adapter: createOpencodeAdapter() },
  { name: 'fake', adapter: fakeAdapter }
];

describe('per-adapter owned-mode environment propagation', () => {
  for (const { name, adapter } of adapters) {
    it(`${name}: owned spawn receives the scrubbed OwnershipContext.env (no ORC_RUN_*)`, async () => {
      const { runtime, env, calls } = captureRuntime();
      const input: RunInput = {
        prompt: 'do work',
        model: 'm',
        cwd: '/tmp',
        skillId: 'plan-audit',
        version: 1,
        kind: 'audit',
        ownership: ownership(),
        spawnRuntime: runtime
      };
      await adapter.run(input);

      expect(calls()).toBe(1);
      // The provider is spawned with the exact scrubbed env object.
      expect(env()).toBe(scrubbedEnv);
      expect(env()).not.toHaveProperty('ORC_RUN_TOKEN');
      expect(env()).not.toHaveProperty('ORC_RUN_ID');
      expect(env()).not.toHaveProperty('ORC_RUN_STATE_DIR');
    });
  }

  it('terminal mode does NOT use the owned spawn runtime (legacy runner, inherited env)', async () => {
    const { calls } = captureRuntime();
    const legacyRunner: ProcessRunner = async () => okRaw();
    // codex with an injected legacy runner; no ownership, no spawnRuntime.
    const codex = createCodexAdapter({ processRunner: legacyRunner });
    await codex.run({ prompt: 'p', model: 'm', cwd: '/tmp', skillId: 's', version: 1, kind: 'audit' } as RunInput);
    expect(calls()).toBe(0);
  });

  it('opencode terminal mode does NOT use the owned spawn runtime', async () => {
    const { calls } = captureRuntime();
    const legacyRunner: ProcessRunner = async () => okRaw();
    const opencode = createOpencodeAdapter({ processRunner: legacyRunner });
    await opencode.run({ prompt: 'p', model: 'm', cwd: '/tmp', skillId: 's', version: 1, kind: 'audit' } as RunInput);
    expect(calls()).toBe(0);
  });
});
