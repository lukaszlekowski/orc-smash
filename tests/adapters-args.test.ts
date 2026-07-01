import { describe, it, expect } from 'vitest';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { agyAdapter } from '../src/adapters/agy.js';

describe('Adapter arguments builders', () => {
  const input = {
    prompt: 'My test prompt',
    model: 'my-model-123',
    cwd: '/path/to/cwd'
  };

  it('builds correct arguments for opencode', () => {
    const build = opencodeAdapter.buildRun(input);
    expect(build.command).toBe('opencode');
    expect(build.args).toEqual([
      'run',
      '-m',
      'my-model-123',
      '--dir',
      '/path/to/cwd',
      '--dangerously-skip-permissions',
      '--format',
      'json',
      'My test prompt'
    ]);
  });

  it('builds correct arguments for codex', () => {
    const build = codexAdapter.buildRun(input);
    expect(build.command).toBe('codex');
    expect(build.args).toEqual([
      'exec',
      '-m',
      'my-model-123',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      'My test prompt'
    ]);
  });

  it('builds correct arguments for claude', () => {
    const build = claudeAdapter.buildRun(input);
    expect(build.command).toBe('claude');
    expect(build.args).toEqual([
      '-p',
      'My test prompt',
      '--model',
      'my-model-123',
      '--output-format',
      'json',
      '--permission-mode',
      'bypassPermissions'
    ]);
  });

  it('builds correct arguments for agy and never includes a CLI timeout flag', () => {
    const build = agyAdapter.buildRun(input);
    expect(build.command).toBe('agy');
    expect(build.args).toEqual([
      '-p',
      'My test prompt',
      '--model',
      'my-model-123',
      '--dangerously-skip-permissions'
    ]);
    // Timeout is harness-owned via spawnAgentProcess lifecycle options; no CLI flag.
    expect(build.args.some((a) => /timeout/i.test(a))).toBe(false);
  });
});
