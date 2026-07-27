import { describe, it, expect } from 'vitest';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { createAgyAdapter } from '../src/adapters/agy.js';
import { encodeAgySession } from '../src/adapters/agy-session.js';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

  it('builds correct arguments for opencode in fresh continuity mode', () => {
    const build = opencodeAdapter.buildRun({
      ...input,
      continuity: { mode: 'fresh' }
    });
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

  it('builds correct arguments for opencode in resumed continuity mode', () => {
    const build = opencodeAdapter.buildRun({
      ...input,
      continuity: { mode: 'resumed', sessionId: 'ses_abc123' }
    });
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
      '-s',
      'ses_abc123',
      'My test prompt'
    ]);
  });

  it('builds correct arguments for codex (default, non-continuity)', () => {
    const build = codexAdapter.buildRun(input);
    expect(build.command).toBe('codex');
    expect(build.args).toEqual([
      'exec',
      '-m',
      'my-model-123',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      'My test prompt'
    ]);
    expect(build.args.includes('--json')).toBe(true);
    expect(build.args.includes('--last')).toBe(false);
  });

  it('builds correct arguments for codex in fresh continuity mode', () => {
    const build = codexAdapter.buildRun({
      ...input,
      continuity: { mode: 'fresh' }
    });
    expect(build.command).toBe('codex');
    expect(build.args).toEqual([
      'exec',
      '-m',
      'my-model-123',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      'My test prompt'
    ]);
    expect(build.args.includes('--last')).toBe(false);
  });

  it('builds correct arguments for codex in resumed continuity mode', () => {
    const build = codexAdapter.buildRun({
      ...input,
      continuity: { mode: 'resumed', sessionId: 'sess_999' }
    });
    expect(build.command).toBe('codex');
    expect(build.args).toEqual([
      'exec',
      'resume',
      'sess_999',
      '-m',
      'my-model-123',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--json',
      'My test prompt'
    ]);
    expect(build.args.includes('--last')).toBe(false);
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
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions'
    ]);
  });

  it('builds correct arguments for claude in fresh continuity mode', () => {
    const build = claudeAdapter.buildRun({
      ...input,
      continuity: { mode: 'fresh' }
    });
    expect(build.command).toBe('claude');
    expect(build.args).toEqual([
      '-p',
      'My test prompt',
      '--model',
      'my-model-123',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions'
    ]);
  });

  it('builds correct arguments for claude in resumed continuity mode', () => {
    const build = claudeAdapter.buildRun({
      ...input,
      continuity: { mode: 'resumed', sessionId: 'sess_claude123' }
    });
    expect(build.command).toBe('claude');
    expect(build.args).toEqual([
      '-p',
      'My test prompt',
      '--model',
      'my-model-123',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--resume',
      'sess_claude123'
    ]);
  });

  it('builds correct fresh arguments for agy and never includes a CLI timeout flag', () => {
    const captureDirectory = join(tmpdir(), `orc-agy-args-${Date.now()}`);
    mkdirSync(captureDirectory, { recursive: true });
    const build = createAgyAdapter({ captureDirectory }).buildRun({ ...input, model: 'gemini-3.6-flash', effort: 'low' });
    expect(build.command).toBe('agy');
    expect(build.args.slice(0, 7)).toEqual([
      '-p', 'My test prompt',
      '--model', 'gemini-3.6-flash',
      '--effort', 'low',
      '--new-project',
    ]);
    expect(build.args).toContain('--log-file');
    expect(build.args).toContain('--dangerously-skip-permissions');
    // Timeout is harness-owned via spawnAgentProcess lifecycle options; no CLI flag.
    expect(build.args.some((a) => /timeout/i.test(a))).toBe(false);
    rmSync(captureDirectory, { recursive: true, force: true });
  });

  it('builds correct resumed arguments for agy with explicit effort and no --continue', () => {
    const captureDirectory = join(tmpdir(), `orc-agy-args-resumed-${Date.now()}`);
    mkdirSync(captureDirectory, { recursive: true });
    const sessionId = encodeAgySession({
      projectId: '11111111-1111-4111-8111-111111111111',
      conversationId: '22222222-2222-4222-8222-222222222222',
    });
    const build = createAgyAdapter({ captureDirectory }).buildRun({
      ...input,
      model: 'gemini-3.6-flash',
      effort: 'high',
      continuity: { mode: 'resumed', sessionId },
    });
    expect(build.args).toContain('--project');
    expect(build.args).toContain('11111111-1111-4111-8111-111111111111');
    expect(build.args).toContain('--conversation');
    expect(build.args).toContain('22222222-2222-4222-8222-222222222222');
    expect(build.args).not.toContain('--new-project');
    expect(build.args).not.toContain('--continue');
    expect(build.args.filter((arg) => arg === '--effort')).toHaveLength(1);
    rmSync(captureDirectory, { recursive: true, force: true });
  });
});
