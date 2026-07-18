import { describe, it, expect } from 'vitest';
import { fork } from 'node:child_process';
import { resolveBootstrapPath } from '../src/adapters/process-group.js';

function launch(spec: Record<string, unknown>) {
  return fork(resolveBootstrapPath(), [JSON.stringify(spec)], {
    execPath: process.execPath,
    execArgv: [],
    detached: true,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });
}

describe('process-group bootstrap — fault boundaries', () => {
  it('parent disconnect before ACK exits without spawning the provider', async () => {
    const child = launch({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("must-not-run");'],
      cwd: process.cwd(),
      env: process.env,
      expectedProviderExecutablePath: process.execPath
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    const result = await new Promise<{ code: number | null }>((resolve) => {
      child.on('message', (rawFrame) => {
        const frame = rawFrame as { type?: string };
        if (frame.type === 'ready') child.disconnect();
      });
      child.on('exit', (code) => resolve({ code }));
    });
    expect(result.code).toBe(66);
    expect(stdout).not.toContain('must-not-run');
  });
});
