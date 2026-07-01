import { spawn, type ChildProcess } from 'node:child_process';
import type { RunInput, RunResult, RunError } from './types.js';
import type { LifecycleEvent } from '../adapter-lifecycle.js';
import { parseOpencodeStream, classifyOpencodeError, diffOpencodeProgress, type OpencodeStreamError } from './opencode-stream.js';
import { classifyCompletion } from './completion.js';
import { debugProcessLifecycle } from '../debug-spawn.js';

/** Built-in opencode execution timeout (ms) when neither env nor config supplies one. */
export const OPENCODE_BUILT_IN_TIMEOUT_MS = 600000;

/**
 * Resolve the opencode execution timeout with explicit precedence:
 *   `OPENCODE_RUN_TIMEOUT_MS` env > `options.defaultTimeoutMs` (config tier) > built-in 600000.
 * `0` (or env `"0"`) disables the watchdog — the function returns `0` so the
 * caller passes `0` to `runProcess` and the internal `setTimeout` is skipped.
 * Negative or non-numeric env values fall through to the next tier (defensive).
 * Partial numerics such as `123abc` are treated as invalid and also fall
 * through — operator typos must not silently become a live timeout.
 *
 * This is a pure function so tests can assert the precedence without mocking
 * `runProcess` or `spawnOpencode`. It is the single source of truth for the
 * opencode timeout policy.
 */
export function resolveOpencodeTimeoutMs(opts?: { defaultTimeoutMs?: number }): number {
  const envRaw = process.env['OPENCODE_RUN_TIMEOUT_MS'];
  let resolved: number;
  if (envRaw !== undefined && envRaw !== '') {
    const parsed = /^\d+$/.test(envRaw) ? Number.parseInt(envRaw, 10) : Number.NaN;
    resolved = Number.isFinite(parsed) ? parsed : opts?.defaultTimeoutMs ?? OPENCODE_BUILT_IN_TIMEOUT_MS;
  } else {
    resolved = opts?.defaultTimeoutMs ?? OPENCODE_BUILT_IN_TIMEOUT_MS;
  }
  return resolved > 0 ? resolved : 0;
}

/**
 * Built-in default for config-only agents (codex / claude / agy). `0` means the
 * watchdog is disabled unless the operator configures `timeouts.<agent>`.
 */
export const CONFIG_ONLY_BUILT_IN_TIMEOUT_MS = 0;

/**
 * Config-only timeout resolver shared by `claude`, `codex`, and `agy`.
 *
 * Precedence: `options.defaultTimeoutMs` (config tier) > built-in `0`.
 * There is intentionally **no env var** for these agents (unlike opencode) —
 * `0` (or unset) disables the watchdog. A non-positive configured value also
 * disables. Pure function so tests can assert precedence without mocking.
 *
 * This is the single source of truth for the config-only timeout policy; the
 * per-agent aliases below name the same rule for the agents that use it.
 */
export function resolveConfigOnlyTimeoutMs(opts?: { defaultTimeoutMs?: number }): number {
  const t = opts?.defaultTimeoutMs ?? CONFIG_ONLY_BUILT_IN_TIMEOUT_MS;
  return t > 0 ? t : 0;
}

/** claude watchdog resolver (config > built-in 0; no env). */
export const resolveClaudeTimeoutMs = resolveConfigOnlyTimeoutMs;
/** codex watchdog resolver (config > built-in 0; no env). */
export const resolveCodexTimeoutMs = resolveConfigOnlyTimeoutMs;
/** agy watchdog resolver (config > built-in 0; no env). */
export const resolveAgyTimeoutMs = resolveConfigOnlyTimeoutMs;

/** Bound a captured text blob to its tail (default 4000 chars). Shared by the
 *  stderr scanner and the error formatter so the bound lives in one place. */
export function boundedTail(text: string | null | undefined, max = 4000): string {
  if (!text) return '';
  return text.length > max ? text.slice(-max) : text;
}

// --- Shared process execution contract ---------------------------------------

export interface ProcessRunOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Timeout in ms; <= 0 (default) disables timeout handling. */
  timeoutMs?: number;
  /** Called for each stdout data chunk (raw string). */
  onStdoutChunk?: (chunk: string) => void;
}

export interface RawProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  signal: NodeJS.Signals | null;
  durationMs: number;
  /** Present when the process failed to spawn (e.g. ENOENT). */
  spawnErrorMessage?: string;
}

/**
 * One shared process-execution contract supporting stdout/stderr capture, spawn
 * failure handling, and optional timeout handling. Provider-specific behavior
 * (opencode stream parsing / stderr scanning) lives in the adapters that call
 * this — the shared runner owns only generic process execution.
 */
export function runProcess(options: ProcessRunOptions): Promise<RawProcessResult> {
  const { command, args, cwd, timeoutMs = 0 } = options;
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let hasClosed = false;
    let killTimeout: NodeJS.Timeout | null = null;
    let forceKillTimeout: NodeJS.Timeout | null = null;

    if (timeoutMs > 0) {
      killTimeout = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        forceKillTimeout = setTimeout(() => {
          if (!hasClosed) {
            proc.kill('SIGKILL');
          }
        }, 2000);
      }, timeoutMs);
    }

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      options.onStdoutChunk?.(chunk);
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // Track the live child so an interrupt signal can terminate it (§3).
    registerActiveChild(proc);

    const cleanup = () => {
      if (killTimeout) {
        clearTimeout(killTimeout);
        killTimeout = null;
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
    };

    debugProcessLifecycle({
      adapter: command,
      phase: 'spawned',
      command,
      args,
      cwd,
      pid: proc.pid
    });

    proc.on('close', (code, signal) => {
      hasClosed = true;
      cleanup();
      const durationMs = Date.now() - startedAt;
      debugProcessLifecycle({
        adapter: command,
        phase: 'completed',
        command,
        args,
        cwd,
        pid: proc.pid,
        durationMs,
        exitCode: code ?? 0,
        signal,
        timedOut,
        stdout,
        stderr
      });
      resolve({ stdout, stderr, exitCode: code ?? 0, timedOut, signal, durationMs });
    });

    proc.on('error', (err) => {
      hasClosed = true;
      cleanup();
      const durationMs = Date.now() - startedAt;
      debugProcessLifecycle({
        adapter: command,
        phase: 'spawn-error',
        command,
        args,
        cwd,
        pid: proc.pid,
        durationMs,
        exitCode: -1,
        signal: null,
        timedOut,
        stdout,
        stderr,
        spawnErrorMessage: err.message
      });
      resolve({ stdout, stderr, exitCode: -1, timedOut, signal: null, durationMs, spawnErrorMessage: err.message });
    });
  });
}

export type ProcessRunner = (options: ProcessRunOptions) => Promise<RawProcessResult>;
export const realProcessRunner: ProcessRunner = runProcess;

// --- Active child tracking + termination (§3 interrupted-run handling) --------
//
// `runProcess` registers every spawned provider child here so that an interrupt
// signal (SIGINT/SIGTERM) can terminate orphaned provider processes. This is the
// single registry; `terminateActiveChildren` is the only terminator.

const activeChildren = new Set<ChildProcess>();

/** Register a live child for interrupt-time termination. Auto-removes on exit. */
export function registerActiveChild(proc: ChildProcess): void {
  activeChildren.add(proc);
  const remove = () => activeChildren.delete(proc);
  proc.once('exit', remove);
  proc.once('error', remove);
}

/** Test seam: reset the active-child registry between tests. */
export function resetActiveChildren(): void {
  activeChildren.clear();
}

/**
 * Terminate every active provider child: SIGTERM all, then SIGKILL stragglers
 * after a bounded grace period. Safe to call with no active children (no-op).
 * Resolves once the grace window has elapsed so the caller can exit cleanly.
 */
export async function terminateActiveChildren(graceMs = 2000): Promise<void> {
  const procs = [...activeChildren].filter((p) => !p.killed);
  for (const p of procs) {
    try {
      p.kill('SIGTERM');
    } catch {
      // Process may have already exited between snapshot and kill.
    }
  }
  if (procs.length === 0) return;
  await new Promise((r) => setTimeout(r, graceMs));
  for (const p of procs) {
    try {
      if (!p.killed) {
        p.kill('SIGKILL');
      }
    } catch {
      // Best-effort; the child is likely already gone.
    }
  }
}

/** Generic agent spawn (codex/claude/agy): capture + spawn-failure handling +
 *  optional watchdog timeout + optional lifecycle. The timeout is threaded
 *  through the lifecycle/options object (not a positional parameter) to
 *  preserve the existing call shape. */
export function spawnAgentProcess(
  command: string,
  args: string[],
  cwd: string,
  lifecycle?: {
    agent: string;
    model: string;
    skillId?: string;
    version?: number;
    onLifecycle?: (e: LifecycleEvent) => void;
    /** Watchdog deadline in ms; <= 0 / unset disables timeout handling. */
    timeoutMs?: number;
  },
  processRunner: ProcessRunner = realProcessRunner
): Promise<RunResult> {
  if (lifecycle?.onLifecycle && lifecycle.version !== undefined && lifecycle.skillId !== undefined) {
    lifecycle.onLifecycle({
      type: 'started',
      agent: lifecycle.agent,
      model: lifecycle.model,
      version: lifecycle.version,
      skillId: lifecycle.skillId,
      message: command,
      atMs: Date.now()
    });
  }

  const timeoutMs = lifecycle?.timeoutMs ?? 0;
  return processRunner({ command, args, cwd, timeoutMs }).then((raw) => {
    // Classification precedence: spawn error → timeout → nonzero exit → completed.
    // A nonzero exit emits a failed lifecycle event but (by existing contract)
    // does NOT populate RunResult.error; timeout and spawn errors both do.
    let error: RunError | undefined;
    let failedKind: string | undefined;
    if (raw.spawnErrorMessage) {
      error = { kind: 'spawn', message: `failed to spawn '${command}': ${raw.spawnErrorMessage}` };
      failedKind = 'spawn';
    } else if (raw.timedOut) {
      error = {
        kind: 'timeout',
        message: `agent '${lifecycle?.agent ?? command}' exceeded the configured watchdog timeout`,
        raw: { timeoutMs }
      };
      failedKind = 'timeout';
    } else if (raw.exitCode !== 0) {
      failedKind = 'nonzero-exit';
    }

    if (lifecycle?.onLifecycle && lifecycle.version !== undefined) {
      if (failedKind) {
        lifecycle.onLifecycle({
          type: 'failed',
          agent: lifecycle.agent,
          version: lifecycle.version,
          errorKind: failedKind,
          atMs: Date.now()
        });
      } else {
        lifecycle.onLifecycle({
          type: 'completed',
          agent: lifecycle.agent,
          version: lifecycle.version,
          atMs: Date.now()
        });
      }
    }

    return { stdout: raw.stdout, stderr: raw.stderr, exitCode: raw.exitCode, error };
  });
}

export function scanStderrForError(stderr: string): RunError | null {
  if (!stderr) return null;
  const combinedPattern = /credential|unauthor|401|api[_-]?key|provider.*(not found|unknown)/i;
  const match = stderr.match(combinedPattern);
  if (!match) return null;

  const isConfig = /provider/i.test(match[0]);
  const tail = boundedTail(stderr);
  return {
    kind: isConfig ? 'config' : 'auth',
    message: tail.trim(),
    raw: tail
  };
}

/** opencode spawn: generic execution via runProcess, then opencode-owns stream
 *  parsing, stderr scanning, error classification, and completion labeling. */
export function spawnOpencode(
  input: RunInput,
  args: string[],
  options?: { defaultTimeoutMs?: number; processRunner?: ProcessRunner }
): Promise<RunResult> {
  // Precedence: OPENCODE_RUN_TIMEOUT_MS env > options.defaultTimeoutMs (config tier) > built-in 600000.
  // 0 (or env "0") disables the watchdog.
  const timeoutMs = resolveOpencodeTimeoutMs(options);
  const runner = options?.processRunner ?? realProcessRunner;

  let buffer = '';
  let prevTextLen = 0;
  let prevToolCount = 0;

  if (input.onLifecycle && input.version !== undefined && input.skillId !== undefined) {
    input.onLifecycle({
      type: 'started',
      agent: 'opencode',
      model: input.model,
      version: input.version,
      skillId: input.skillId,
      message: 'opencode',
      atMs: Date.now()
    });
  }

  return runner({
    command: 'opencode',
    args,
    cwd: input.cwd,
    timeoutMs,
    onStdoutChunk: input.onLifecycle && input.version !== undefined
      ? (chunk: string) => {
          buffer += chunk;
          const parsed = parseOpencodeStream(buffer);
          const delta = diffOpencodeProgress(prevTextLen, prevToolCount, parsed);
          prevTextLen = parsed.finalText.length;
          prevToolCount = parsed.toolCalls.length;
          if (delta && input.onLifecycle && input.version !== undefined) {
            input.onLifecycle({
              type: 'message',
              agent: 'opencode',
              version: input.version,
              text: delta.textDelta,
              toolCalls: delta.toolCallDelta,
              atMs: Date.now()
            });
          }
        }
      : undefined
  }).then((raw) => {
    return buildOpencodeRunResult(raw, input, timeoutMs);
  });
}

function buildOpencodeRunResult(
  raw: RawProcessResult,
  input: RunInput,
  timeoutMs: number
): RunResult {
  if (raw.spawnErrorMessage) {
    if (input.onLifecycle && input.version !== undefined) {
      input.onLifecycle({
        type: 'failed',
        agent: 'opencode',
        version: input.version,
        errorKind: 'spawn',
        atMs: Date.now()
      });
    }
    return {
      stdout: '',
      stderr: raw.stderr,
      exitCode: -1,
      error: {
        kind: 'spawn',
        message: `failed to spawn 'opencode': ${raw.spawnErrorMessage}`
      }
    };
  }

  const p = parseOpencodeStream(raw.stdout);

  let error: RunError | undefined = undefined;
  if (p.streamError) {
    error = classifyOpencodeError(p.streamError);
  } else if (raw.timedOut) {
    error = {
      kind: 'timeout',
      message: 'no completion event before deadline',
      raw: { timeoutMs }
    };
  } else {
    const se = scanStderrForError(raw.stderr);
    if (se) {
      error = se;
    } else if (raw.exitCode !== 0) {
      error = {
        kind: 'nonzero-exit',
        message: `exit code ${raw.exitCode}`
      };
    }
  }

  if (input.onLifecycle && input.version !== undefined) {
    if (raw.spawnErrorMessage) {
      input.onLifecycle({
        type: 'failed',
        agent: 'opencode',
        version: input.version,
        errorKind: 'spawn',
        atMs: Date.now()
      });
    } else if (error) {
      input.onLifecycle({
        type: 'failed',
        agent: 'opencode',
        version: input.version,
        errorKind: error.kind,
        atMs: Date.now()
      });
    } else {
      input.onLifecycle({
        type: 'completed',
        agent: 'opencode',
        version: input.version,
        atMs: Date.now()
      });
    }
  }

  const runResult: RunResult = {
    stdout: p.finalText,
    stderr: raw.stderr,
    exitCode: raw.exitCode,
    error,
    toolCalls: p.toolCalls,
    stopReason: p.stopReason
  };
  runResult.completion = classifyCompletion('opencode', runResult);
  return runResult;
}
