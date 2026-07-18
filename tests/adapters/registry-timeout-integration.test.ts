import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createTempDir, removeTempDir } from '../helpers/fs.js';
import { createTestConfig } from '../helpers/test-config.js';
import { createProductionAdapterRegistry } from '../../src/adapters/registry.js';
import { resolveOpencodeTimeoutMs } from '../../src/adapters/utils.js';
import type { ProcessRunner, ProcessRunOptions, RawProcessResult } from '../../src/adapters/utils.js';
import type { RunResult, RunInput } from '../../src/adapters/types.js';
import type { OpencodeSpawn } from '../../src/adapters/opencode.js';

describe('config-driven opencode timeout reaches the spawn call site through the production registry', () => {
  const tempDir = join(process.cwd(), 'temp-registry-timeout-integration');
  let savedEnv: string | undefined;

  beforeEach(() => {
    createTempDir('temp-registry-timeout-integration');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    savedEnv = process.env['OPENCODE_RUN_TIMEOUT_MS'];
    delete process.env['OPENCODE_RUN_TIMEOUT_MS'];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['OPENCODE_RUN_TIMEOUT_MS'];
    else process.env['OPENCODE_RUN_TIMEOUT_MS'] = savedEnv;
    removeTempDir(tempDir);
  });

  it('project-local timeouts.opencode is forwarded as defaultTimeoutMs to the opencode spawn via the production registry', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));

    // Capture the defaultTimeoutMs that the opencode adapter forwards to spawn.
    const captures: { defaultTimeoutMs?: number; resolved: number }[] = [];
    const spawnSpy: OpencodeSpawn = async (
      _input: RunInput,
      _args: string[],
      options?: { defaultTimeoutMs?: number }
    ): Promise<RunResult> => {
      captures.push({
        defaultTimeoutMs: options?.defaultTimeoutMs,
        resolved: resolveOpencodeTimeoutMs(options)
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    // Same load sequence as src/commands/smash.ts but using createTestConfig directly
    const config = createTestConfig({ timeouts: { opencode: 12345 } });
    const registry = createProductionAdapterRegistry(config.registry, { opencodeSpawn: spawnSpy });
    const adapter = registry.adapters.get('opencode')!;
    expect(adapter).toBeDefined();

    await adapter.run({ prompt: 'hi', model: 'opencode-go/deepseek-v4-flash', cwd: tempDir });

    expect(captures).toHaveLength(1);
    expect(captures[0]!.defaultTimeoutMs).toBe(12345);
    expect(captures[0]!.resolved).toBe(12345);
  });

  it('built-in default (600000) is the fallback when project config has no timeouts block', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));

    const captures: { defaultTimeoutMs?: number; resolved: number }[] = [];
    const spawnSpy: OpencodeSpawn = async (
      _input: RunInput,
      _args: string[],
      options?: { defaultTimeoutMs?: number }
    ): Promise<RunResult> => {
      captures.push({
        defaultTimeoutMs: options?.defaultTimeoutMs,
        resolved: resolveOpencodeTimeoutMs(options)
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const config = createTestConfig({ timeouts: {} });
    const registry = createProductionAdapterRegistry(config.registry, { opencodeSpawn: spawnSpy });
    const adapter = registry.adapters.get('opencode')!;

    await adapter.run({ prompt: 'hi', model: 'opencode-go/deepseek-v4-flash', cwd: tempDir });

    expect(captures).toHaveLength(1);
    expect(captures[0]!.defaultTimeoutMs).toBeUndefined();
    expect(captures[0]!.resolved).toBe(900000);
  });

  it('env OPENCODE_RUN_TIMEOUT_MS overrides the configured defaultTimeoutMs at the spawn call site', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    process.env['OPENCODE_RUN_TIMEOUT_MS'] = '777';

    const captures: { defaultTimeoutMs?: number; resolved: number }[] = [];
    const spawnSpy: OpencodeSpawn = async (
      _input: RunInput,
      _args: string[],
      options?: { defaultTimeoutMs?: number }
    ): Promise<RunResult> => {
      captures.push({
        defaultTimeoutMs: options?.defaultTimeoutMs,
        resolved: resolveOpencodeTimeoutMs(options)
      });
      return { stdout: '', stderr: '', exitCode: 0 };
    };

    const config = createTestConfig({ timeouts: { opencode: 12345 } });
    const registry = createProductionAdapterRegistry(config.registry, { opencodeSpawn: spawnSpy });
    const adapter = registry.adapters.get('opencode')!;

    await adapter.run({ prompt: 'hi', model: 'opencode-go/deepseek-v4-flash', cwd: tempDir });

    expect(captures).toHaveLength(1);
    // Factory still passes 12345; resolver (env) returns 777.
    expect(captures[0]!.defaultTimeoutMs).toBe(12345);
    expect(captures[0]!.resolved).toBe(777);
  });
});

describe('config-driven codex/claude timeouts reach the adapter through the production registry', () => {
  const tempDir = join(process.cwd(), 'temp-registry-timeout-codex-claude');

  beforeEach(() => {
    createTempDir('temp-registry-timeout-codex-claude');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  /** Build a ProcessRunner seam that captures the resolved `timeoutMs` it is
   *  invoked with, then returns a clean zero-exit result. */
  function capturingRunner(): { runner: ProcessRunner; captures: ProcessRunOptions[] } {
    const captures: ProcessRunOptions[] = [];
    const runner: ProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      captures.push(options);
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 };
    };
    return { runner, captures };
  }

  it('configured timeouts.codex reaches the codex adapter as the runner timeoutMs', async () => {
    const { runner, captures } = capturingRunner();
    const config = createTestConfig({ timeouts: { codex: 4242 } });
    const registry = createProductionAdapterRegistry(config.registry, { codexProcessRunner: runner });
    const adapter = registry.adapters.get('codex')!;
    expect(adapter).toBeDefined();

    await adapter.run({ prompt: 'hi', model: 'gpt-5.4', cwd: tempDir });

    expect(captures).toHaveLength(1);
    // The configured timeouts.codex (4242) is resolved by the codex factory and
    // forwarded as the runner's timeoutMs — proving the production wiring.
    expect(captures[0]!.timeoutMs).toBe(4242);
  });

  it('configured timeouts.claude reaches the claude adapter as the runner timeoutMs', async () => {
    const { runner, captures } = capturingRunner();
    const config = createTestConfig({ timeouts: { claude: 9999 } });
    const registry = createProductionAdapterRegistry(config.registry, { claudeProcessRunner: runner });
    const adapter = registry.adapters.get('claude')!;

    await adapter.run({ prompt: 'hi', model: 'glm-5.2', cwd: tempDir });

    expect(captures).toHaveLength(1);
    expect(captures[0]!.timeoutMs).toBe(9999);
  });

  it('codex/claude resolve to disabled (timeoutMs 0) when no timeout is configured', async () => {
    const { runner, captures } = capturingRunner();
    const config = createTestConfig({ timeouts: undefined });
    const registry = createProductionAdapterRegistry(config.registry, {
      codexProcessRunner: runner,
      claudeProcessRunner: runner
    });

    await registry.adapters.get('codex')!.run({ prompt: 'hi', model: 'gpt-5.4', cwd: tempDir });
    await registry.adapters.get('claude')!.run({ prompt: 'hi', model: 'glm-5.2', cwd: tempDir });

    expect(captures).toHaveLength(2);
    // Built-in default for codex/claude is 0 (disabled) when config is unset.
    expect(captures[0]!.timeoutMs).toBe(0);
    expect(captures[1]!.timeoutMs).toBe(0);
  });

  it('configured timeouts.agy reaches the agy adapter as the runner timeoutMs', async () => {
    const { runner, captures } = capturingRunner();
    const config = createTestConfig({ timeouts: { agy: 7777 } });
    const registry = createProductionAdapterRegistry(config.registry, { agyProcessRunner: runner });
    // agy is registered as a fourth real provider.
    expect(registry.adapters.has('agy')).toBe(true);
    const adapter = registry.adapters.get('agy')!;

    await adapter.run({ prompt: 'hi', model: 'Gemini 3.5 Flash (Medium)', cwd: tempDir });

    expect(captures).toHaveLength(1);
    expect(captures[0]!.timeoutMs).toBe(7777);
  });
});
