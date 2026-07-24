import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readdirSync,
  statSync,
  unlinkSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, RunInput, RunResult, RunError } from './types.js';
import { spawnAgentProcess, resolveAgyTimeoutMs, type ProcessRunner } from './utils.js';
import type { SpawnRuntime } from './process-group.js';
import {
  assertAgyResumedIdentity,
  decodeAgySession,
  encodeAgySession,
  parseAgyInvocationLog,
  type AgySessionIdentity,
} from './agy-session.js';

export const AGY_CAPTURE_LOG_PREFIX = 'agy-capture-';
const AGY_CAPTURE_LOG_PATTERN = /^agy-capture-[^/]+\.log$/;

/**
 * Bounded auth-failure detection for the Antigravity `agy` CLI.
 *
 * When unauthenticated, `agy` can ignore `--model` and fall back to CCPA while
 * still exiting 0 — which would otherwise look like success. These patterns
 * match whole tokens / whole phrases over the COMBINED stdout+stderr, so benign
 * substrings such as "author", "authority", or "authentication succeeded" do
 * NOT classify a successful run as an auth failure. (A bare `/auth/` substring
 * would misclassify that benign output.)
 *
 * The adapter owns DETECTION ONLY. It never resolves, reads, deletes, or
 * quarantines artifact paths: `RunInput` carries no output path, and the resolved
 * path is computed by `src/loop.ts` after `adapter.run` returns. The loop owns
 * the auth-failure artifact cleanup (quarantine of the resolved `absOutputPath`).
 */
export const AGY_AUTH_FAILURE_PATTERNS: RegExp[] = [
  /\bauthentication failed\b/i,
  /\b401\b/i,
  /\bunauthori[sz]ed\b/i,
  /\bauthentication required\b/i,
  /\binvalid api[_ -]?key\b/i,
  /\bmissing credentials?\b/i
];

const AGY_AUTH_BANNER = /^\s*(?:WARNING:\s*)?Error:\s*authentication failed\b/i;

const STRONG_AUTH_PATTERNS = [
  /\bauthentication required\b/i,
  /\binvalid api[_ -]?key\b/i,
  /\bmissing credentials?\b/i
];

const GENERIC_AUTH_PATTERNS = [
  /\b401\b/i,
  /\bunauthori[sz]ed\b/i
];

function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

/**
 * Returns true when the agy output matches a bounded auth-failure phrase.
 *
 * Checks for the real unauthenticated banner shape on stdout/stderr, and keeps
 * generic-token (401/unauthorized) handling stderr-only so stdout prose/code
 * cannot trip auth cleanup.
 */
export function isAgyAuthFailure(stdout: string, stderr: string): boolean {
  const cleanStdout = stripFencedCode(stdout);
  const cleanStderr = stripFencedCode(stderr);

  // 1. Check for the real banner shape on stdout or stderr.
  if (AGY_AUTH_BANNER.test(cleanStdout) || AGY_AUTH_BANNER.test(cleanStderr)) {
    return true;
  }

  // 2. Check for strong non-generic auth patterns on stdout or stderr.
  if (STRONG_AUTH_PATTERNS.some((re) => re.test(cleanStdout) || re.test(cleanStderr))) {
    return true;
  }

  // 3. Generic tokens stay stderr-only.
  if (GENERIC_AUTH_PATTERNS.some((re) => re.test(cleanStderr))) {
    return true;
  }

  return false;
}

export interface CreateAgyAdapterOptions {
  /** Config-tier watchdog deadline in ms (0 / unset disables). */
  defaultTimeoutMs?: number;
  /**
   * Test seam: replaces the inner process runner for lifecycle/timeout tests,
   * independent of real-binary runs. Production code never passes this.
   */
  processRunner?: ProcessRunner;
  groupRuntime?: SpawnRuntime;
  /** Test seam for keeping capture logs in an isolated temporary directory. */
  captureDirectory?: string;
}

export interface SweepAgyCaptureLogsOptions {
  directory?: string;
  timeoutMs: number;
  nowMs?: number;
}

/**
 * Reclaim only stale AGY capture logs. The watchdog-conditional horizon means a
 * live run bounded by W cannot reach the 2W cutoff, while disabled watchdogs
 * leave OS-managed temporary cleanup as the benign fallback.
 */
export function sweepOrphanedAgyCaptureLogs(options: SweepAgyCaptureLogsOptions): void {
  if (options.timeoutMs <= 0) return;

  const directory = options.directory ?? tmpdir();
  const cutoffMs = (options.nowMs ?? Date.now()) - (2 * options.timeoutMs);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }

  for (const name of names) {
    if (!AGY_CAPTURE_LOG_PATTERN.test(name)) continue;
    const path = join(directory, name);
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.mtimeMs >= cutoffMs) continue;
      unlinkSync(path);
    } catch {
      // A concurrent run may remove or rotate a file between the checks. The
      // sweep is best-effort and must never turn cleanup into a run failure.
    }
  }
}

function allocateCaptureLogPath(directory: string): string {
  return join(directory, `${AGY_CAPTURE_LOG_PREFIX}${randomUUID()}.log`);
}

function cleanupCaptureLog(path: string | undefined): void {
  if (!path || !existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // Cleanup is best effort; the bounded orphan sweep handles interrupted runs.
  }
}

function captureLogArg(args: string[]): string {
  const index = args.indexOf('--log-file');
  const path = index >= 0 ? args[index + 1] : undefined;
  if (!path) throw new Error('AGY command did not allocate a capture log path.');
  return path;
}

function sessionError(result: RunResult, message: string): RunResult {
  const error: RunError = { kind: 'config', message };
  return { ...result, error };
}

export function createAgyAdapter(opts: CreateAgyAdapterOptions = {}): AgentAdapter {
  const defaultTimeoutMs = opts.defaultTimeoutMs;
  const processRunner = opts.processRunner;
  const groupRuntime = opts.groupRuntime;
  const captureDirectory = opts.captureDirectory ?? tmpdir();

  const buildRun = (input: RunInput): { command: string; args: string[] } => {
    const captureLogPath = allocateCaptureLogPath(captureDirectory);
    const args = [
      '-p',
      input.prompt,
      '--model',
      input.model,
    ];

    if (input.effort) {
      args.push('--effort', input.effort);
    }

    if (input.continuity?.mode === 'resumed') {
      const identity = decodeAgySession(input.continuity.sessionId ?? '');
      args.push('--project', identity.projectId, '--conversation', identity.conversationId);
    } else {
      args.push('--new-project');
    }

    args.push('--log-file', captureLogPath, '--dangerously-skip-permissions');
    return { command: 'agy', args };
  };

  return {
    name: 'agy',
    capabilities: { resumeSession: true, effort: true },

    buildRun,

    async run(input: RunInput): Promise<RunResult> {
      const timeoutMs = resolveAgyTimeoutMs({ defaultTimeoutMs });
      sweepOrphanedAgyCaptureLogs({ directory: captureDirectory, timeoutMs });

      let command: string;
      let args: string[];
      try {
        ({ command, args } = buildRun(input));
      } catch (error) {
        return {
          stdout: '',
          stderr: '',
          exitCode: 1,
          error: {
            kind: 'config',
            message: `AGY session configuration is invalid; no provider was spawned: ${error instanceof Error ? error.message : String(error)}`,
          },
        };
      }

      const captureLogPath = captureLogArg(args);
      try {
        // agy is config-only: timeouts.agy > built-in 0; no env var. No CLI timeout
        // flag — the deadline is enforced by spawnAgentProcess lifecycle options.
        const result = await spawnAgentProcess(command, args, input.cwd, {
          agent: 'agy',
          model: input.model,
          skillId: input.skillId,
          version: input.version,
          onLifecycle: input.onLifecycle,
          timeoutMs,
          spawnRuntime: groupRuntime ?? input.spawnRuntime,
          ownership: input.ownership
        }, processRunner);

        // Existing transport, watchdog, ownership, and nonzero-exit outcomes
        // retain precedence over auth and session parsing.
        if (result.error || result.exitCode !== 0) return result;

        // Detection only — the invocation log is intentionally not included in
        // this existing stdout/stderr-only auth contract.
        if (isAgyAuthFailure(result.stdout, result.stderr ?? '')) {
          const err: RunError = {
            kind: 'auth',
            message:
              'Authentication failed: re-authenticate (e.g. `agy login`) and retry. agy may otherwise fall back to an unconfigured provider while exiting successfully.'
          };
          return { ...result, error: err };
        }

        let actual: AgySessionIdentity;
        try {
          actual = parseAgyInvocationLog(readFileSync(captureLogPath, 'utf8'));
          if (input.continuity?.mode === 'resumed') {
            const expected = decodeAgySession(input.continuity.sessionId ?? '');
            assertAgyResumedIdentity(expected, actual);
          }
        } catch (error) {
          return sessionError(
            result,
            `AGY did not return a valid session identity; the successful response is not resumable: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        return { ...result, sessionId: encodeAgySession(actual) };
      } finally {
        cleanupCaptureLog(captureLogPath);
      }
    }
  };
}

/** Registry-facing default (no configured timeout). */
export const agyAdapter = createAgyAdapter();
