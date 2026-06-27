import { describe, it, expect } from 'vitest';
import { structuredMessage } from '../src/adapters/errors.js';
import type { RunResult } from '../src/adapters/types.js';

describe('structuredMessage error formatting', () => {
  const ctx = { label: 'Audit', model: 'opencode-go/deepseek-v4-flash' };

  it('formats unknown-model / server error correctly', () => {
    const result: RunResult = {
      stdout: '',
      exitCode: 1,
      error: {
        kind: 'server',
        message: 'Unexpected server error',
        ref: 'err_123'
      }
    };
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain("opencode rejected model 'opencode-go/deepseek-v4-flash'");
    expect(msg).toContain('Unexpected server error');
    expect(msg).toContain('(ref err_123)');
  });

  it('omits ref when not present in server/unknown-model error (m11)', () => {
    const result: RunResult = {
      stdout: '',
      exitCode: 1,
      error: {
        kind: 'unknown-model',
        message: 'Model not found'
      }
    };
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain("opencode rejected model 'opencode-go/deepseek-v4-flash'");
    expect(msg).toContain('Model not found');
    expect(msg).not.toContain('ref');
  });

  it('formats auth / config error correctly', () => {
    const result: RunResult = {
      stdout: '',
      exitCode: 1,
      error: {
        kind: 'auth',
        message: 'unauthorized key',
        ref: 'err_auth'
      }
    };
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain('opencode provider/credential error');
    expect(msg).toContain('unauthorized key');
    expect(msg).toContain('(ref err_auth)');
  });

  it('formats timeout error correctly (m10)', () => {
    const result: RunResult = {
      stdout: '',
      exitCode: 0,
      error: {
        kind: 'timeout',
        message: 'no completion event',
        raw: { timeoutMs: 5000 }
      }
    };
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain('opencode run timed out after 5000ms');
    expect(msg).toContain('Verify the model/provider with `opencode models`');
  });

  it('formats spawn error correctly', () => {
    const result: RunResult = {
      stdout: '',
      exitCode: -1,
      error: {
        kind: 'spawn',
        message: 'ENOENT'
      }
    };
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain("opencode failed to start: is the 'opencode' CLI installed and on PATH?");
    expect(msg).toContain('(ENOENT)');
  });

  it('formats nonzero-exit error correctly with bounded stderr', () => {
    const hugeStderr = 'a'.repeat(10000);
    const result: RunResult = {
      stdout: '',
      exitCode: 2,
      stderr: hugeStderr,
      error: {
        kind: 'nonzero-exit',
        message: 'exit code 2'
      }
    };
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain('Audit exited with code 2. stderr:');
    const tailPart = msg.split('stderr: ')[1];
    expect(tailPart.length).toBe(4000);
    expect(tailPart).toBe('a'.repeat(4000));
  });

  it('falls back to exited with code message when no error object is present but exit code is nonzero', () => {
    const result: RunResult = {
      stdout: '',
      exitCode: 3,
      stderr: 'some stderr'
    };
    const msg = structuredMessage(result, ctx);
    expect(msg).toBe('Audit exited with code 3. stderr: some stderr');
  });
});
