import type { AgentAdapter, RunInput, RunResult, RunError } from './types.js';
import { spawnAgentProcess, resolveAgyTimeoutMs, type ProcessRunner } from './utils.js';
import type { SpawnRuntime } from './process-group.js';

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
}

export function createAgyAdapter(opts: CreateAgyAdapterOptions = {}): AgentAdapter {
  const defaultTimeoutMs = opts.defaultTimeoutMs;
  const processRunner = opts.processRunner;
  const groupRuntime = opts.groupRuntime;
  return {
    name: 'agy',
    capabilities: { resumeSession: false, effort: true },

    buildRun(input: RunInput): { command: string; args: string[] } {
      return {
        command: 'agy',
        args: [
          '-p',
          input.prompt,
          '--model',
          input.model,
          '--dangerously-skip-permissions'
        ].concat(input.effort ? ['--effort', input.effort] : [])
      };
    },

    async run(input: RunInput): Promise<RunResult> {
      const { command, args } = this.buildRun(input);
      // agy is config-only: timeouts.agy > built-in 0; no env var. No CLI timeout
      // flag — the deadline is enforced by spawnAgentProcess lifecycle options.
      const result = await spawnAgentProcess(command, args, input.cwd, {
        agent: this.name,
        model: input.model,
        skillId: input.skillId,
        version: input.version,
        onLifecycle: input.onLifecycle,
        timeoutMs: resolveAgyTimeoutMs({ defaultTimeoutMs }),
        spawnRuntime: groupRuntime ?? input.spawnRuntime,
        ownership: input.ownership
      }, processRunner);

      // Post-process auth-fallback detection. This runs only when no other error
      // (spawn/timeout/nonzero-exit) already classified the run; it sets a
      // structured `auth` error so the loop can quarantine any resolved artifact.
      // Detection only — no path resolution or filesystem mutation here.
      if (!result.error) {
        if (isAgyAuthFailure(result.stdout, result.stderr ?? '')) {
          const err: RunError = {
            kind: 'auth',
            message:
              'Authentication failed: re-authenticate (e.g. `agy login`) and retry. agy may otherwise fall back to an unconfigured provider while exiting successfully.'
          };
          return { ...result, error: err };
        }
      }
      return result;
    }
  };
}

/** Registry-facing default (no configured timeout). */
export const agyAdapter = createAgyAdapter();
