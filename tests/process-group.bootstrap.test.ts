import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { resolveBootstrapPath } from '../src/adapters/process-group.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

const tmp = join(process.cwd(), 'temp-pg-bootstrap');

beforeEach(() => createTempDir('temp-pg-bootstrap'));
afterEach(() => removeTempDir(tmp));

function launch(spec: Record<string, unknown>): ChildProcess {
  return fork(resolveBootstrapPath(), [JSON.stringify(spec)], {
    execPath: process.execPath,
    execArgv: [],
    detached: true,
    cwd: tmp,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  });
}

function providerSpec(command: string, args: string[]): Record<string, unknown> {
  return {
    command,
    args,
    cwd: tmp,
    env: process.env,
    expectedProviderExecutablePath: command,
    expectedProviderArgvFingerprint: process.platform === 'darwin' ? undefined : [command, ...args].join('\0')
  };
}

describe('process-group bootstrap — source-shipped Node contract', () => {
  it('resolves a readable source-relative bootstrap asset', () => {
    const p = resolveBootstrapPath();
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, 'utf8')).toContain('provider-started');
    expect(p.endsWith('process-group-bootstrap.mjs')).toBe(true);
  });

  it('keeps control frames on IPC and starts the exact provider only after ACK', async () => {
    const args = ['-e', 'process.stdout.write("from-provider\\n");'];
    const child = launch(providerSpec(process.execPath, args));
    let stdout = '';
    let stderr = '';
    const frames: any[] = [];
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      child.on('message', (rawFrame) => {
        const frame = rawFrame as { type?: string; protocolVersion?: number };
        frames.push(frame);
        if (frame.type === 'ready') child.send({ protocolVersion: 1, type: 'ack' });
        if (frame.type === 'provider-exited') child.send({ protocolVersion: 1, type: 'retire' });
      });
      child.on('close', (code, signal) => resolve({ code, signal }));
    });

    expect(frames.map((frame) => frame.type)).toEqual(['ready', 'provider-started', 'provider-exited']);
    expect(frames[0].protocolVersion).toBe(1);
    expect(frames[0].bootstrapPid).toBe(child.pid);
    expect(stdout).toBe('from-provider\n');
    expect(stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.signal).toBeNull();
  });

  it('does not start the provider after an invalid ACK frame', async () => {
    const args = ['-e', 'process.stdout.write("must-not-run\\n");'];
    const child = launch(providerSpec(process.execPath, args));
    let stdout = '';
    const frames: any[] = [];
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    const result = await new Promise<{ code: number | null }>((resolve) => {
      child.on('message', (rawFrame) => {
        const frame = rawFrame as { type?: string; protocolVersion?: number };
        frames.push(frame);
        if (frame.type === 'ready') child.send({ protocolVersion: 99, type: 'ack' });
      });
      child.on('close', (code) => resolve({ code }));
    });
    expect(frames.some((frame) => frame.type === 'provider-started')).toBe(false);
    expect(stdout).toBe('');
    expect(result.code).toBe(70);
  });
});
