import { spawn } from 'node:child_process';
import type { RunResult } from './types.js';

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
        stdout: stdout + stderr,
        exitCode: code ?? 0
      });
    });

    proc.on('error', (err) => {
      resolve({
        stdout: `Error: failed to spawn process '${command}': ${err.message}\n` + stdout + stderr,
        exitCode: -1
      });
    });
  });
}
