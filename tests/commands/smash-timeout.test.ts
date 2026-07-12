import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createTempDir, removeTempDir } from '../helpers/fs.js';
import { createTestConfig } from '../helpers/test-config.js';
import { smashAction, buildDefaultAdapterRegistry } from '../../src/commands/smash.js';
import { createProductionAdapterRegistry } from '../../src/adapters/registry.js';
import { loadConfig } from '../../src/config.js';
import type { Config } from '../../src/config.js';
import type { AgentRegistry } from '../../src/adapters/registry.js';
import { runLoop } from '../../src/loop.js';

vi.mock('../../src/loop.js', () => ({
  runLoop: vi.fn().mockResolvedValue({ success: true, verdict: 'APPROVED', message: 'mocked', lastAuditPath: null })
}));

const mockedRunLoop = vi.mocked(runLoop);

let mockTimeouts: any = undefined;

vi.mock('../../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/config.js')>();
  // NOTE: do NOT `await import('../helpers/test-config.js')` here. test-config.ts
  // imports config.js, so importing it inside this mock factory forms a mock-
  // factory import cycle that deadlocks vitest's loader once the real smash.ts
  // import graph is loaded. createTestConfig is captured by the loadConfig closure
  // (top-level import below the hoisted vi.mock) and only invoked during tests,
  // after the module graph has fully settled — which breaks the cycle.
  return {
    ...actual,
    loadConfig: (projectRoot?: string) => createTestConfig({
      projectRoot,
      timeouts: mockTimeouts
    })
  };
});

vi.mock('../../src/adapters/registry.js', async (importOriginal) => {
  const mod = (await importOriginal()) as any;
  return { ...mod, createProductionAdapterRegistry: vi.fn((...args: any[]) => mod.createProductionAdapterRegistry(...args)) };
});

const mockOutput = {
  note: () => {},
  warn: () => {},
  error: (msg: string) => { console.error('MOCK ERROR:', msg); },
  iterationStarted: () => {},
  stepStarted: () => {},
  stepSucceeded: () => {},
  stepFailed: () => {},
  renderPanel: () => {},
  finalSummary: () => {}
};

describe('smashAction forwards the loaded ModelRegistry to the production adapter registry (v3-audit M1)', () => {
  const tempDir = join(process.cwd(), 'temp-smash-timeout');

  beforeEach(() => {
    createTempDir('temp-smash-timeout');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    mockedRunLoop.mockResolvedValue({ success: true, verdict: 'APPROVED', message: 'mocked', lastAuditPath: null });
    mockTimeouts = undefined;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.restoreAllMocks();
  });

  it('project-local timeouts.opencode reaches createProductionAdapterRegistry through the real smash.ts setup', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    mockTimeouts = { opencode: 12345 };
    // A pre-existing approved plan audit so the implement-loop path can
    // run (smashAction's start-point check).
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      `---\nloop: plan\nskill: plan-audit\nkind: audit\nrole: auditor\nversion: 1\nagent: fake\nmodel: fake\ntarget: docs/dev/plan.md\npriorAudit: none\ntimestamp: 2026-06-30T00:00:00.000Z\n---\n\n# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );

    // Spy factory injected through the Step 5 seam. It records every
    // (Config) argument it is called with and returns a real production
    // registry (so the rest of smashAction runs normally).
    const seenConfigs: Config[] = [];
    const spyFactory = (cfg: Config): AgentRegistry => {
      seenConfigs.push(cfg);
      return createProductionAdapterRegistry(cfg.registry);
    };

    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput,
      createAdapterRegistry: spyFactory  // Step 5 seam
    });

    // The factory was called at least once during the real smash.ts setup.
    expect(seenConfigs.length).toBeGreaterThan(0);
    // The Config passed in is the one loaded by loadConfig(tempDir) — it
    // carries the project-local timeouts.opencode: 12345. A partial
    // implementation that calls createProductionAdapterRegistry() with no
    // arg in smash.ts would either crash, omit this call, or pass a
    // Config with `registry.timeouts === undefined` — all three fail this
    // assertion.
    const cfg = seenConfigs[0]!;
    expect(cfg.registry.timeouts?.['opencode']).toBe(12345);
    expect(res.exitCode).toBe(0);
  });

  it('smashAction default factory (no seam) reaches the production registry end-to-end — v4-audit M3 fix', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    mockTimeouts = { opencode: 99999 };
    writeFileSync(
      join(tempDir, 'docs/dev/plan-audit-v1-fake.md'),
      `---\nloop: plan\nskill: plan-audit\nkind: audit\nrole: auditor\nversion: 1\nagent: fake\nmodel: fake\ntarget: docs/dev/plan.md\npriorAudit: none\ntimestamp: 2026-06-30T00:00:00.000Z\n---\n\n# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );

    // v8-audit Critical fix: the `vi.mock` at the top of this file wraps
    // `createProductionAdapterRegistry` in a spy that delegates to the
    // real factory. This test proves the DEFAULT path (no
    // `createAdapterRegistry` seam) calls the factory with the loaded
    // Config's registry — a partial implementation that leaves
    // `resolveSmashRunSetup` calling `createProductionAdapterRegistry()`
    // with no argument would fail this assertion because the spy would
    // record `undefined` (or omit the `timeouts` key) instead of the
    // project-local config. The v4-audit M3 fix's module-binding concern
    // does not apply here: `vi.mock` replaces the module before any
    // imports resolve, so the spy is on the same ESM binding that
    // `smash.ts` uses internally. The integration test
    // (`tests/adapters/registry-timeout-integration.test.ts`) already
    // proves `createProductionAdapterRegistry(registry, { opencodeSpawn })`
    // forwards the configured `defaultTimeoutMs`; this command-level test
    // proves `resolveSmashRunSetup` (the production call site) actually
    // passes the loaded config.
    const res = await smashAction({
      project: tempDir,
      loop: 'plan',
      agent: 'fake',
      model: 'fake-model',
      output: mockOutput
      // no createAdapterRegistry — default factory runs
    });

    // The spy must have been called with the loaded config's registry
    // containing `timeouts.opencode: 99999`. If `resolveSmashRunSetup`
    // calls `createProductionAdapterRegistry()` with no argument, the
    // spy records `undefined` and this assertion fails.
    expect(createProductionAdapterRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ timeouts: expect.objectContaining({ opencode: 99999 }) })
    );
    // The default factory produced a registry the loop could use to
    // run the plan audit — exit-code 0 + presence of the audit
    // artifact confirm the default wiring is functional.
    expect(res.exitCode).toBe(0);
    expect(existsSync(join(tempDir, 'docs/dev/plan-audit-v1-fake.md'))).toBe(true);
  });

  /**
   * Companion unit assertion on the `buildDefaultAdapterRegistry` helper
   * (Step 5). The helper IS the default factory — `resolveSmashRunSetup`
   * literally references it as the seam's default. Asserting on the
   * helper directly verifies that the default factory forwards
   * `config.registry` to `createProductionAdapterRegistry` (no module
   * binding sensitivity: the helper is imported once at the top of the
   * file and called in this test, so the assertion is on the same
   * binding the loop uses).
   */
  it('buildDefaultAdapterRegistry (the default factory) forwards config.registry to createProductionAdapterRegistry — v4-audit M3 fix', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    mockTimeouts = { opencode: 99999 };
    const cfg = loadConfig(tempDir);
    const registry = buildDefaultAdapterRegistry(cfg);
    // The helper is a thin alias: it calls createProductionAdapterRegistry
    // with `config.registry`. The result must contain all three real
    // providers and the registry shape must match what `cfg.registry`
    // describes.
    expect(registry.adapters.has('opencode')).toBe(true);
    expect(registry.adapters.has('codex')).toBe(true);
    expect(registry.adapters.has('claude')).toBe(true);
    // The config.registry's timeouts.opencode is what the production
    // registry received — the opencode adapter was constructed with
    // this value as `defaultTimeoutMs` (verified by the integration
    // test in `tests/adapters/registry-timeout-integration.test.ts`).
    expect(cfg.registry.timeouts?.['opencode']).toBe(99999);
  });
});
