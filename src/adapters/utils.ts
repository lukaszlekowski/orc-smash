import { spawn } from 'node:child_process';
import type { RunInput, RunResult, RunError } from './types.js';
import { parseOpencodeStream, classifyOpencodeError, type OpencodeStreamError } from './opencode-stream.js';
import { classifyCompletion } from './completion.js';

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
}

export interface RawProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
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
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimeout: NodeJS.Timeout | null = null;
    let forceKillTimeout: NodeJS.Timeout | null = null;

    if (timeoutMs > 0) {
      killTimeout = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        forceKillTimeout = setTimeout(() => {
          if (!proc.killed) {
            proc.kill('SIGKILL');
          }
        }, 2000);
      }, timeoutMs);
    }

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

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

    proc.on('close', (code) => {
      cleanup();
      resolve({ stdout, stderr, exitCode: code ?? 0, timedOut });
    });

    proc.on('error', (err) => {
      cleanup();
      resolve({ stdout, stderr, exitCode: -1, timedOut, spawnErrorMessage: err.message });
    });
  });
}

/** Generic agent spawn (codex/claude): capture + spawn-failure handling only. */
export function spawnAgentProcess(command: string, args: string[], cwd: string): Promise<RunResult> {
  return runProcess({ command, args, cwd }).then((raw) => {
    const error: RunError | undefined = raw.spawnErrorMessage
      ? { kind: 'spawn', message: `failed to spawn '${command}': ${raw.spawnErrorMessage}` }
      : undefined;
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
export function spawnOpencode(input: RunInput, args: string[], options?: { timeoutMs?: number }): Promise<RunResult> {
  const timeoutEnv = process.env['OPENCODE_RUN_TIMEOUT_MS'];
  const timeoutMs = options?.timeoutMs ?? (timeoutEnv ? parseInt(timeoutEnv, 10) : 600000);

  return runProcess({
    command: 'opencode',
    args,
    cwd: input.cwd,
    timeoutMs: timeoutMs > 0 ? timeoutMs : 0
  }).then((raw) => {
    if (raw.spawnErrorMessage) {
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
  });
}
