import { spawn } from 'node:child_process';
import type { RunInput, RunResult, RunError } from './types.js';
import { parseOpencodeStream, classifyOpencodeError } from './opencode-stream.js';

export function spawnAgentProcess(command: string, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 0
      });
    });

    proc.on('error', (err) => {
      resolve({
        stdout,
        stderr,
        exitCode: -1,
        error: {
          kind: 'spawn',
          message: `failed to spawn '${command}': ${err.message}`
        }
      });
    });
  });
}

export function scanStderrForError(stderr: string): RunError | null {
  if (!stderr) return null;
  const combinedPattern = /credential|unauthor|401|api[_-]?key|provider.*(not found|unknown)/i;
  const match = stderr.match(combinedPattern);
  if (!match) return null;

  const isConfig = /provider/i.test(match[0]);
  const tail = stderr.length > 4000 ? stderr.slice(-4000) : stderr;
  return {
    kind: isConfig ? 'config' : 'auth',
    message: tail.trim(),
    raw: tail
  };
}

export function spawnOpencode(input: RunInput, args: string[], options?: { timeoutMs?: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    const proc = spawn('opencode', args, {
      cwd: input.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeoutEnv = process.env['OPENCODE_RUN_TIMEOUT_MS'];
    const timeoutMs = options?.timeoutMs ?? (timeoutEnv ? parseInt(timeoutEnv, 10) : 180000);

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

    const cleanupTimeouts = () => {
      if (killTimeout) {
        clearTimeout(killTimeout);
        killTimeout = null;
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = null;
      }
    };

    const handleExit = (code: number | null) => {
      cleanupTimeouts();

      const p = parseOpencodeStream(stdout);
      
      let error: RunError | undefined = undefined;

      if (p.streamError) {
        error = classifyOpencodeError(p.streamError);
      } else if (timedOut) {
        error = {
          kind: 'timeout',
          message: 'no completion event before deadline',
          raw: { timeoutMs }
        };
      } else {
        const se = scanStderrForError(stderr);
        if (se) {
          error = se;
        } else if (code !== null && code !== 0) {
          error = {
            kind: 'nonzero-exit',
            message: `exit code ${code}`
          };
        }
      }

      resolve({
        stdout: p.finalText,
        stderr,
        exitCode: code ?? 0,
        error,
        toolCalls: p.toolCalls,
        stopReason: p.stopReason
      });
    };

    proc.on('close', (code) => {
      handleExit(code);
    });

    proc.on('error', (err) => {
      cleanupTimeouts();
      resolve({
        stdout: '',
        stderr,
        exitCode: -1,
        error: {
          kind: 'spawn',
          message: `failed to spawn 'opencode': ${err.message}`
        }
      });
    });
  });
}
