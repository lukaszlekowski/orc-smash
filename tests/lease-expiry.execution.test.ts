import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { executeLoopStep, type LoopExecutionDeps } from '../src/loops/execution.js';
import type { AgentAdapter, RunResult } from '../src/adapters/types.js';
import type { AgentRegistry } from '../src/adapters/registry.js';
import type { Runner } from '../src/loops/runtime.js';
import type { CliOutput } from '../src/cli-output.js';
import { clearInterruptState } from '../src/interrupted-artifact.js';
import { resetLeaseClock, type OwnershipContext, type ControlRecord } from '../src/run-ownership.js';
import { createTestConfig } from './helpers/test-config.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

/**
 * C2 integration coverage: when the lease expires mid-run, executeLoopStep's
 * Promise.race must resolve to `{ kind: 'ownership-lost' }` — never reject into
 * runLoop's generic 'unknown' error path. The normal (lease-valid) path still
 * returns `{ kind: 'ran' }`.
 */
describe('executeLoopStep — lease expiry resolves to an ownership outcome', () => {
  const tmp = join(process.cwd(), 'temp-lease-execution');
  let runDir: string;
  let prevInterval: string | undefined;

  beforeEach(() => {
    createTempDir('temp-lease-execution');
    runDir = join(tmp, 'runs', 'run-a');
    // Speed up the watcher so expiry is detected within a few ms.
    prevInterval = process.env['ORC_LEASE_WATCH_INTERVAL_MS'];
    process.env['ORC_LEASE_WATCH_INTERVAL_MS'] = '10';
    clearInterruptState();
    resetLeaseClock();
  });

  afterEach(() => {
    if (prevInterval === undefined) {
      delete process.env['ORC_LEASE_WATCH_INTERVAL_MS'];
    } else {
      process.env['ORC_LEASE_WATCH_INTERVAL_MS'] = prevInterval;
    }
    removeTempDir(tmp);
  });

  function controlRecord(leaseExpiresMs: number): ControlRecord {
    return {
      schemaVersion: 1,
      runId: 'run-a',
      ownerTokenHash: 'hash',
      projectRoot: tmp,
      hostInstanceId: 'host-1',
      leaseIssuedMs: 0,
      leaseTtlMs: 60_000,
      leaseExpiresMs,
      issuerRevision: 1
    };
  }

  function seedRunDir(leaseExpiresMs: number): OwnershipContext {
    mkdirSync(runDir, { recursive: true });
    const control = controlRecord(leaseExpiresMs);
    writeFileSync(join(runDir, 'control.json'), JSON.stringify(control), { mode: 0o600 });
    writeFileSync(
      join(runDir, 'active.json'),
      JSON.stringify({
        cliIdentity: { pid: process.pid, startMs: 0, command: 'orc' },
        groups: [],
        state: 'running',
        cliRevision: 1
      }),
      { mode: 0o600 }
    );
    return {
      token: 'tok',
      runId: 'run-a',
      stateDir: tmp,
      projectDir: join(tmp, 'projects', 'hash'),
      runDir,
      control,
      env: {},
      hasObservedExpired: false
    };
  }

  const mockOutput: CliOutput = {
    note: () => {},
    warn: () => {},
    error: () => {},
    iterationStarted: () => {},
    stepStarted: () => {},
    stepSucceeded: () => {},
    stepFailed: () => {},
    renderPanel: () => {},
    finalSummary: () => {},
    attachLiveRegion: () => {},
    detachLiveRegion: () => {}
  };

  function buildDeps(ownership: OwnershipContext | null): LoopExecutionDeps {
    const config = createTestConfig({ projectRoot: tmp });
    return {
      projectRoot: tmp,
      loopName: 'plan',
      loopSpec: config.manifest.loops['plan']!,
      config,
      registry: { adapters: new Map() } as AgentRegistry,
      output: mockOutput,
      steps: [],
      maxIterations: 5,
      ownership
    };
  }

  const runner: Runner = { agent: 'fake', model: 'fake-model' };

  it('returns ownership-lost (does not throw) when the lease expires mid-run', async () => {
    // Adapter that never resolves on its own — only the watcher can end the race.
    const hangAdapter: AgentAdapter = {
      name: 'fake',
      buildRun: () => ({ command: 'fake', args: [] }),
      run: () => new Promise<RunResult>(() => {})
    };
    const deps = buildDeps(seedRunDir(Date.now() + 30));
    deps.registry.adapters.set('fake', hangAdapter);

    const outcome = await executeLoopStep(deps, {
      runner,
      prompt: 'Write your output to: docs/dev/plan-audit-v1-fake.md',
      spawnLabel: 'spawning',
      kind: 'audit',
      skillId: 'plan-audit',
      version: 1,
      iteration: 1
    });

    // The decisive assertion: expiry resolves to an ownership outcome, not a
    // thrown generic failure caught by runLoop as 'unknown'.
    expect(outcome.kind).toBe('ownership-lost');
  });

  it('returns ran when the adapter completes while the lease is still valid', async () => {
    const fastAdapter: AgentAdapter = {
      name: 'fake',
      buildRun: () => ({ command: 'fake', args: [] }),
      run: async (): Promise<RunResult> => ({ stdout: 'ok', exitCode: 0 })
    };
    const deps = buildDeps(seedRunDir(Date.now() + 1_000_000));
    deps.registry.adapters.set('fake', fastAdapter);

    const outcome = await executeLoopStep(deps, {
      runner,
      prompt: 'Write your output to: docs/dev/plan-audit-v1-fake.md',
      spawnLabel: 'spawning',
      kind: 'audit',
      skillId: 'plan-audit',
      version: 1,
      iteration: 1
    });

    expect(outcome.kind).toBe('ran');
  });
});
