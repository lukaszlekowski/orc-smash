import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createTempDir, removeTempDir } from '../helpers/fs.js';
import { loadConfig } from '../../src/config.js';
import { createProductionAdapterRegistry } from '../../src/adapters/registry.js';
import { resolveOpencodeTimeoutMs } from '../../src/adapters/utils.js';
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
    writeFileSync(
      join(tempDir, 'orc.config.yaml'),
      `providers:\n  opencode: [opencode-go/deepseek-v4-flash]\ndefaults:\n  agent: opencode\n  model: opencode-go/deepseek-v4-flash\ntimeouts:\n  opencode: 12345\n`
    );

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

    // Same load sequence as src/commands/smash.ts
    // (loadConfig → createProductionAdapterRegistry(config.registry, { opencodeSpawn })).
    const config = loadConfig(tempDir);
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
    writeFileSync(
      join(tempDir, 'orc.config.yaml'),
      `providers:\n  opencode: [opencode-go/deepseek-v4-flash]\ndefaults:\n  agent: opencode\n  model: opencode-go/deepseek-v4-flash\n`
    );

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

    const config = loadConfig(tempDir);
    const registry = createProductionAdapterRegistry(config.registry, { opencodeSpawn: spawnSpy });
    const adapter = registry.adapters.get('opencode')!;

    await adapter.run({ prompt: 'hi', model: 'opencode-go/deepseek-v4-flash', cwd: tempDir });

    expect(captures).toHaveLength(1);
    expect(captures[0]!.defaultTimeoutMs).toBeUndefined();
    expect(captures[0]!.resolved).toBe(600000);
  });

  it('env OPENCODE_RUN_TIMEOUT_MS overrides the configured defaultTimeoutMs at the spawn call site', async () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    writeFileSync(
      join(tempDir, 'orc.config.yaml'),
      `providers:\n  opencode: [opencode-go/deepseek-v4-flash]\ndefaults:\n  agent: opencode\n  model: opencode-go/deepseek-v4-flash\ntimeouts:\n  opencode: 12345\n`
    );
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

    const config = loadConfig(tempDir);
    const registry = createProductionAdapterRegistry(config.registry, { opencodeSpawn: spawnSpy });
    const adapter = registry.adapters.get('opencode')!;

    await adapter.run({ prompt: 'hi', model: 'opencode-go/deepseek-v4-flash', cwd: tempDir });

    expect(captures).toHaveLength(1);
    // Factory still passes 12345; resolver (env) returns 777.
    expect(captures[0]!.defaultTimeoutMs).toBe(12345);
    expect(captures[0]!.resolved).toBe(777);
  });
});
