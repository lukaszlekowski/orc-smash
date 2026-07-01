import { describe, it, expect } from 'vitest';
import {
  createAgyAdapter,
  isAgyAuthFailure,
  AGY_AUTH_FAILURE_PATTERNS
} from '../../src/adapters/agy.js';
import type { ProcessRunner, ProcessRunOptions, RawProcessResult } from '../../src/adapters/utils.js';

/** Build a ProcessRunner seam returning a canned RawProcessResult. */
function runnerOf(raw: Partial<RawProcessResult>): ProcessRunner {
  return async (_options: ProcessRunOptions): Promise<RawProcessResult> => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
    timedOut: false,
    signal: null,
    durationMs: 1,
    ...raw
  });
}

const baseInput = {
  prompt: 'Write your output to: docs/dev/plan-audit-v1-agy.md',
  model: 'Gemini 3.5 Flash (Medium)',
  cwd: '/tmp'
};

describe('agy adapter — command construction (no CLI timeout flag)', () => {
  it('builds `agy -p <prompt> --model <model> --dangerously-skip-permissions`', () => {
    const adapter = createAgyAdapter();
    const build = adapter.buildRun({ prompt: 'do thing', model: 'Gemini 3.5 Flash (Medium)', cwd: '/tmp' });
    expect(build.command).toBe('agy');
    expect(build.args).toEqual([
      '-p', 'do thing',
      '--model', 'Gemini 3.5 Flash (Medium)',
      '--dangerously-skip-permissions'
    ]);
    // No CLI timeout flag is ever injected; the deadline is harness-owned.
    expect(build.args.some((a) => /timeout/i.test(a))).toBe(false);
  });
});

describe('agy auth-failure detection (bounded, provider-specific)', () => {
  it('detects each bounded auth-failure phrase over combined stdout+stderr', () => {
    expect(isAgyAuthFailure('Error: 401 Unauthorized')).toBe(true);
    expect(isAgyAuthFailure('response status: 401')).toBe(true);
    expect(isAgyAuthFailure('unauthorised access')).toBe(true);
    expect(isAgyAuthFailure('unauthorized: token expired')).toBe(true);
    expect(isAgyAuthFailure('Authentication required')).toBe(true);
    expect(isAgyAuthFailure('invalid api key')).toBe(true);
    expect(isAgyAuthFailure('invalid api-key')).toBe(true);
    expect(isAgyAuthFailure('invalid api_key')).toBe(true);
    expect(isAgyAuthFailure('missing credential')).toBe(true);
    expect(isAgyAuthFailure('missing credentials')).toBe(true);
  });

  it('does NOT classify benign auth-substring output as auth failure (no false positives)', () => {
    expect(isAgyAuthFailure('The author of this module')).toBe(false);
    expect(isAgyAuthFailure('certificate authority verified')).toBe(false);
    expect(isAgyAuthFailure('authentication succeeded')).toBe(false);
    expect(isAgyAuthFailure('')).toBe(false);
  });

  it('the pattern list is case-insensitive and whole-token bounded', () => {
    // Whole-token: "4012" must NOT match \b401\b.
    expect(isAgyAuthFailure('status 4012 ok')).toBe(false);
    expect(AGY_AUTH_FAILURE_PATTERNS.length).toBeGreaterThanOrEqual(5);
  });
});

describe('agy adapter — auth detection owns detection only (no filesystem mutation)', () => {
  it('returns error.kind "auth" when specific non-generic unauthenticated phrases appear in stdout', async () => {
    const adapter = createAgyAdapter({ processRunner: runnerOf({ stdout: 'ERROR missing credentials' }) });
    const result = await adapter.run({ ...baseInput, skillId: 'plan-audit', version: 1 });
    expect(result.error?.kind).toBe('auth');
    expect(result.error?.message).toMatch(/authentication failed/i);
  });

  it('does NOT return error.kind "auth" when generic phrases like "401" or "unauthorized" appear only in stdout', async () => {
    const adapter = createAgyAdapter({ processRunner: runnerOf({ stdout: 'The generated code returns 401 or handles unauthorized requests.' }) });
    const result = await adapter.run({ ...baseInput, skillId: 'plan-audit', version: 1 });
    expect(result.error).toBeUndefined();
  });

  it('returns error.kind "auth" when generic unauthenticated phrases appear in stderr', async () => {
    const adapter = createAgyAdapter({ processRunner: runnerOf({ stderr: 'ERROR 401 Unauthorized' }) });
    const result = await adapter.run({ ...baseInput, skillId: 'plan-audit', version: 1 });
    expect(result.error?.kind).toBe('auth');
  });

  it('returns error.kind "auth" when unauthenticated phrases appear in stderr', async () => {
    const adapter = createAgyAdapter({ processRunner: runnerOf({ stderr: 'invalid api key supplied' }) });
    const result = await adapter.run({ ...baseInput, skillId: 'plan-audit', version: 1 });
    expect(result.error?.kind).toBe('auth');
  });

  it('succeeds (no auth error) on authenticated output containing benign auth substrings', async () => {
    const adapter = createAgyAdapter({
      processRunner: runnerOf({ stdout: 'Authentication succeeded. The author is verified by the certificate authority.' })
    });
    const result = await adapter.run({ ...baseInput, skillId: 'plan-audit', version: 1 });
    expect(result.error).toBeUndefined();
  });

  it('does not override a pre-existing error (spawn/timeout) with an auth classification', async () => {
    // A timeout raw result: spawnAgentProcess already classified error.kind 'timeout'.
    const adapter = createAgyAdapter({
      processRunner: runnerOf({ stdout: '401 Unauthorized', timedOut: true, exitCode: 0 })
    });
    const result = await adapter.run({ ...baseInput, skillId: 'plan-audit', version: 1 });
    // Timeout wins; auth detection only runs when no other error is present.
    expect(result.error?.kind).toBe('timeout');
  });

  it('performs NO filesystem mutation: RunInput carries no output path, so the adapter cannot resolve/delete one', async () => {
    // The adapter never receives a resolved output path (RunInput has none).
    // On a clean authenticated success it returns the captured result unchanged
    // — proving it neither writes nor quarantines artifacts (that is loop-owned).
    const adapter = createAgyAdapter({ processRunner: runnerOf({ stdout: 'all good' }) });
    const result = await adapter.run({ ...baseInput, skillId: 'plan-audit', version: 1 });
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe('all good');
    expect(result.exitCode).toBe(0);
  });
});
