import { afterEach, describe, expect, it } from 'vitest';
import {
  AGY_AUTH_FAILURE_PATTERNS,
  createAgyAdapter,
  isAgyAuthFailure,
  sweepOrphanedAgyCaptureLogs,
} from '../../src/adapters/agy.js';
import type { ProcessRunner, ProcessRunOptions, RawProcessResult } from '../../src/adapters/utils.js';
import { encodeAgySession } from '../../src/adapters/agy-session.js';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const projectId = '11111111-1111-4111-8111-111111111111';
const conversationId = '22222222-2222-4222-8222-222222222222';
const otherProjectId = '33333333-3333-4333-8333-333333333333';
const otherConversationId = '44444444-4444-4444-8444-444444444444';
const sessionId = encodeAgySession({ projectId, conversationId });

const sessionLog = (project = projectId, conversation = conversationId): string => [
  `Backend project ID updated dynamically to: ${project}`,
  `Print mode: conversation=${conversation}, sending message`,
].join('\n');

const baseInput = {
  prompt: 'Write your output to: docs/dev/plan-audit-v1-agy.md',
  model: 'gemini-3.6-flash',
  cwd: '/tmp',
};

let captureDirectory: string;

afterEach(() => {
  if (captureDirectory) rmSync(captureDirectory, { recursive: true, force: true });
});

/** Build a ProcessRunner seam returning a canned RawProcessResult and, when
 * requested, writing the invocation-specific capture log named by the argv. */
function runnerOf(
  raw: Partial<RawProcessResult>,
  log?: string,
  onOptions?: (options: ProcessRunOptions) => void,
): ProcessRunner {
  return async (options: ProcessRunOptions): Promise<RawProcessResult> => {
    onOptions?.(options);
    if (log !== undefined) {
      const logIndex = options.args.indexOf('--log-file');
      const logPath = options.args[logIndex + 1];
      if (!logPath) throw new Error('test runner did not receive --log-file');
      writeFileSync(logPath, log);
    }
    return {
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      signal: null,
      durationMs: 1,
      ...raw,
    };
  };
}

function makeAdapter(
  raw: Partial<RawProcessResult>,
  log?: string,
  onOptions?: (options: ProcessRunOptions) => void,
  timeoutMs?: number,
) {
  captureDirectory = join(tmpdir(), `orc-agy-adapter-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(captureDirectory, { recursive: true });
  return createAgyAdapter({
    captureDirectory,
    defaultTimeoutMs: timeoutMs,
    processRunner: runnerOf(raw, log, onOptions),
  });
}

describe('agy adapter — command construction and capabilities', () => {
  it('builds a fresh write with explicit workspace binding, unique capture, and no CLI timeout', () => {
    captureDirectory = join(tmpdir(), `orc-agy-build-${Date.now()}`);
    mkdirSync(captureDirectory, { recursive: true });
    const adapter = createAgyAdapter({ captureDirectory });
    const first = adapter.buildRun({ ...baseInput, effort: 'low' });
    const second = adapter.buildRun({ ...baseInput, effort: 'low' });

    expect(first.command).toBe('agy');
    expect(first.args.slice(0, 7)).toEqual([
      '-p', baseInput.prompt,
      '--model', baseInput.model,
      '--effort', 'low',
      '--new-project',
    ]);
    expect(first.args).toContain('--dangerously-skip-permissions');
    expect(first.args.some((arg) => /timeout/i.test(arg))).toBe(false);
    expect(first.args).not.toContain('--project');
    expect(first.args).not.toContain('--conversation');
    expect(first.args[ first.args.indexOf('--log-file') + 1 ]).toMatch(/^\/.*agy-capture-.*\.log$/);
    expect(first.args[ first.args.indexOf('--log-file') + 1 ]).not.toBe(
      second.args[ second.args.indexOf('--log-file') + 1 ],
    );
  });

  it('builds a resumed write with the exact project/conversation pair and no --continue', () => {
    captureDirectory = join(tmpdir(), `orc-agy-build-resume-${Date.now()}`);
    mkdirSync(captureDirectory, { recursive: true });
    const adapter = createAgyAdapter({ captureDirectory });
    const build = adapter.buildRun({
      ...baseInput,
      continuity: { mode: 'resumed', sessionId },
      effort: 'high',
    });

    expect(build.args).toContain('--project');
    expect(build.args).toContain(projectId);
    expect(build.args).toContain('--conversation');
    expect(build.args).toContain(conversationId);
    expect(build.args).not.toContain('--new-project');
    expect(build.args).not.toContain('--continue');
    expect(build.args.filter((arg) => arg === '--effort')).toHaveLength(1);
    expect(build.args[build.args.indexOf('--effort') + 1]).toBe('high');
  });

  it('omits effort for the provider-default choice and advertises both capabilities', () => {
    captureDirectory = join(tmpdir(), `orc-agy-default-${Date.now()}`);
    mkdirSync(captureDirectory, { recursive: true });
    const adapter = createAgyAdapter({ captureDirectory });
    const build = adapter.buildRun(baseInput);
    expect(build.args).not.toContain('--effort');
    expect(adapter.capabilities).toEqual({ resumeSession: true, effort: true, progress: 'unavailable' });
  });
});

describe('agy auth-failure detection (bounded, provider-specific)', () => {
  it('detects the real auth-failure banner on either stream', () => {
    expect(isAgyAuthFailure('Error: authentication failed or timed out', '')).toBe(true);
    expect(isAgyAuthFailure('', 'Error: authentication failed or timed out')).toBe(true);
  });

  it('detects generic auth tokens only on stderr and strong phrases on either stream', () => {
    expect(isAgyAuthFailure('', 'Error: 401 Unauthorized')).toBe(true);
    expect(isAgyAuthFailure('', 'unauthorised access')).toBe(true);
    expect(isAgyAuthFailure('Authentication required', '')).toBe(true);
    expect(isAgyAuthFailure('invalid api-key', '')).toBe(true);
    expect(isAgyAuthFailure('', 'missing credentials')).toBe(true);
  });

  it('does not classify generic auth-looking stdout or benign substrings', () => {
    expect(isAgyAuthFailure('Error: 401 Unauthorized', '')).toBe(false);
    expect(isAgyAuthFailure('The author of this module', '')).toBe(false);
    expect(isAgyAuthFailure('certificate authority verified', '')).toBe(false);
    expect(isAgyAuthFailure('authentication succeeded', '')).toBe(false);
    expect(isAgyAuthFailure("if (resp.status === 401) throw new Error('unauthorized');", '')).toBe(false);
  });

  it('keeps the exported pattern catalogue bounded and case-insensitive', () => {
    expect(AGY_AUTH_FAILURE_PATTERNS.length).toBeGreaterThanOrEqual(5);
    expect(isAgyAuthFailure('status 4012 ok', '')).toBe(false);
  });
});

describe('agy adapter — result identity, precedence, and cleanup', () => {
  it('returns an encoded identity for fresh and resumed success', async () => {
    const fresh = makeAdapter({}, sessionLog());
    const freshResult = await fresh.run({ ...baseInput, skillId: 'plan-audit', version: 1 });
    expect(freshResult.error).toBeUndefined();
    expect(freshResult.sessionId).toBe(sessionId);

    const resumed = makeAdapter({}, sessionLog());
    const resumedResult = await resumed.run({
      ...baseInput,
      continuity: { mode: 'resumed', sessionId },
      skillId: 'plan-audit',
      version: 2,
    });
    expect(resumedResult.error).toBeUndefined();
    expect(resumedResult.sessionId).toBe(sessionId);
  });

  it('fails closed without spawning on a malformed supplied token', async () => {
    let spawned = false;
    captureDirectory = join(tmpdir(), `orc-agy-malformed-${Date.now()}`);
    mkdirSync(captureDirectory, { recursive: true });
    const adapter = createAgyAdapter({
      captureDirectory,
      processRunner: runnerOf({}, sessionLog(), () => { spawned = true; }),
    });
    const result = await adapter.run({
      ...baseInput,
      continuity: { mode: 'resumed', sessionId: 'agy:v1:not-a-uuid:not-a-uuid' },
    });
    expect(spawned).toBe(false);
    expect(result.error?.kind).toBe('config');
  });

  it('fails closed on missing, ambiguous, and mismatched capture evidence', async () => {
    const missing = makeAdapter({});
    expect((await missing.run(baseInput)).error?.kind).toBe('config');

    const malformed = makeAdapter({}, 'Print mode: conversation=not-a-uuid, sending message');
    expect((await malformed.run(baseInput)).error?.kind).toBe('config');

    const mismatch = makeAdapter({}, sessionLog(otherProjectId, otherConversationId));
    const mismatchResult = await mismatch.run({
      ...baseInput,
      continuity: { mode: 'resumed', sessionId },
    });
    expect(mismatchResult.error?.kind).toBe('config');
    expect(mismatchResult.sessionId).toBeUndefined();
  });

  it('preserves transport, timeout, and nonzero-exit precedence over parsing/auth', async () => {
    const timeout = makeAdapter({ stdout: '401 Unauthorized', timedOut: true }, sessionLog());
    expect((await timeout.run(baseInput)).error?.kind).toBe('timeout');

    const nonzero = makeAdapter({ stdout: 'Authentication required', exitCode: 2 }, sessionLog());
    const nonzeroResult = await nonzero.run(baseInput);
    expect(nonzeroResult.exitCode).toBe(2);
    expect(nonzeroResult.error).toBeUndefined();
    expect(nonzeroResult.sessionId).toBeUndefined();

    const auth = makeAdapter({ stdout: 'ERROR missing credentials' }, sessionLog());
    expect((await auth.run(baseInput)).error?.kind).toBe('auth');
  });

  it('never scans capture-log text for auth and cleans ordinary terminal results', async () => {
    const adapter = makeAdapter(
      { stdout: 'Authentication succeeded. The author is verified by the certificate authority.' },
      `authentication failed before keyring authentication succeeded\n${sessionLog()}`,
    );
    const result = await adapter.run(baseInput);
    expect(result.error).toBeUndefined();
    expect(result.sessionId).toBe(sessionId);
    expect(readdirSync(captureDirectory).filter((name) => name.startsWith('agy-capture-'))).toEqual([]);
  });

  it.each([
    ['auth failure', { stdout: 'ERROR missing credentials' }, sessionLog()],
    ['nonzero exit', { exitCode: 2 }, sessionLog()],
    ['timeout', { timedOut: true }, sessionLog()],
    ['parser failure', {}, 'not an AGY identity log'],
  ] as const)('cleans the capture path after %s', async (_label, raw, log) => {
    const adapter = makeAdapter(raw, log);
    await adapter.run(baseInput);
    expect(readdirSync(captureDirectory).filter((name) => name.startsWith('agy-capture-'))).toEqual([]);
  });
});

describe('agy orphan capture sweep', () => {
  it('removes only stale AGY logs, preserves newer/non-AGY files, and is disabled at timeout 0', () => {
    captureDirectory = join(tmpdir(), `orc-agy-sweep-${Date.now()}`);
    mkdirSync(captureDirectory, { recursive: true });
    const now = 1_000_000;
    const stale = join(captureDirectory, 'agy-capture-stale.log');
    const newer = join(captureDirectory, 'agy-capture-live.log');
    const other = join(captureDirectory, 'not-agy.log');
    writeFileSync(stale, 'stale');
    writeFileSync(newer, 'live');
    writeFileSync(other, 'other');
    utimesSync(stale, new Date(now - 201), new Date(now - 201));
    utimesSync(newer, new Date(now - 199), new Date(now - 199));
    utimesSync(other, new Date(now - 10_000), new Date(now - 10_000));

    sweepOrphanedAgyCaptureLogs({ directory: captureDirectory, timeoutMs: 100, nowMs: now });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(newer)).toBe(true);
    expect(existsSync(other)).toBe(true);

    sweepOrphanedAgyCaptureLogs({ directory: captureDirectory, timeoutMs: 0, nowMs: now + 10_000 });
    expect(existsSync(newer)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});
