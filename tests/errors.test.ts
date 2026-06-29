import { describe, it, expect } from 'vitest';
import { structuredMessage } from '../src/adapters/errors.js';
import { makeRunResult, makeRunError } from './helpers/results.js';

describe('structuredMessage — opencode-specific remediation', () => {
  const ctx = { label: 'Audit', model: 'opencode-go/deepseek-v4-flash', agent: 'opencode' };

  it('formats unknown-model / server error correctly', () => {
    const result = makeRunResult({
      exitCode: 1,
      error: makeRunError({
        kind: 'server',
        message: 'Unexpected server error',
        ref: 'err_123'
      })
    });
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain("opencode rejected model 'opencode-go/deepseek-v4-flash'");
    expect(msg).toContain('Unexpected server error');
    expect(msg).toContain('(ref err_123)');
  });

  it('omits ref when not present in server/unknown-model error (m11)', () => {
    const result = makeRunResult({
      exitCode: 1,
      error: makeRunError({
        kind: 'unknown-model',
        message: 'Model not found'
      })
    });
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain("opencode rejected model 'opencode-go/deepseek-v4-flash'");
    expect(msg).toContain('Model not found');
    expect(msg).not.toContain('ref');
  });

  it('formats auth / config error correctly', () => {
    const result = makeRunResult({
      exitCode: 1,
      error: makeRunError({
        kind: 'auth',
        message: 'unauthorized key',
        ref: 'err_auth'
      })
    });
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain('opencode provider/credential error');
    expect(msg).toContain('unauthorized key');
    expect(msg).toContain('(ref err_auth)');
  });

  it('formats timeout error correctly (m10)', () => {
    const result = makeRunResult({
      error: makeRunError({
        kind: 'timeout',
        message: 'no completion event',
        raw: { timeoutMs: 5000 }
      })
    });
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain('opencode run timed out after 5000ms');
    expect(msg).toContain('Verify the model/provider with `opencode models`');
  });

  it('formats spawn error correctly', () => {
    const result = makeRunResult({
      exitCode: -1,
      error: makeRunError({
        kind: 'spawn',
        message: 'ENOENT'
      })
    });
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain("opencode failed to start: is the 'opencode' CLI installed and on PATH?");
    expect(msg).toContain('(ENOENT)');
  });

  it('formats nonzero-exit error correctly with bounded stderr', () => {
    const hugeStderr = 'a'.repeat(10000);
    const result = makeRunResult({
      exitCode: 2,
      stderr: hugeStderr,
      error: makeRunError({
        kind: 'nonzero-exit',
        message: 'exit code 2'
      })
    });
    const msg = structuredMessage(result, ctx);
    expect(msg).toContain('Audit exited with code 2. stderr:');
    const tailPart = msg.split('stderr: ')[1];
    expect(tailPart!.length).toBe(4000);
    expect(tailPart).toBe('a'.repeat(4000));
  });

  it('falls back to exited with code message when no error object is present but exit code is nonzero', () => {
    const result = makeRunResult({
      exitCode: 3,
      stderr: 'some stderr'
    });
    const msg = structuredMessage(result, ctx);
    expect(msg).toBe('Audit exited with code 3. stderr: some stderr');
  });
});

describe('structuredMessage — generic (non-opencode) provider wording', () => {
  // Shared adapter failure paths must name the actual provider, never "opencode".
  const cases: Array<{ agent: string; model: string }> = [
    { agent: 'codex', model: 'gpt-5.4' },
    { agent: 'claude', model: 'claude-sonnet-4-6' },
    { agent: 'fake', model: 'fake-model' }
  ];

  for (const { agent, model } of cases) {
    const ctx = { label: 'Audit', model, agent };

    it(`${agent}: server/unknown-model => "${agent} execution error"`, () => {
      const result = makeRunResult({
        exitCode: 1,
        error: makeRunError({ kind: 'server', message: 'boom', ref: 'err_z' })
      });
      const msg = structuredMessage(result, ctx);
      expect(msg).toBe(`${agent} execution error: boom (ref err_z)`);
      expect(msg).not.toContain('opencode');
    });

    it(`${agent}: auth => "${agent} provider/credential error"`, () => {
      const result = makeRunResult({
        exitCode: 1,
        error: makeRunError({ kind: 'auth', message: 'unauthorized' })
      });
      const msg = structuredMessage(result, ctx);
      expect(msg).toBe(`${agent} provider/credential error: unauthorized`);
      expect(msg).not.toContain('opencode');
    });

    it(`${agent}: config => "${agent} configuration error"`, () => {
      const result = makeRunResult({
        exitCode: 1,
        error: makeRunError({ kind: 'config', message: 'bad provider' })
      });
      const msg = structuredMessage(result, ctx);
      expect(msg).toBe(`${agent} configuration error: bad provider`);
    });

    it(`${agent}: timeout => "${agent} timed out after <ms>ms"`, () => {
      const result = makeRunResult({
        error: makeRunError({ kind: 'timeout', message: 'no completion event', raw: { timeoutMs: 9000 } })
      });
      const msg = structuredMessage(result, ctx);
      expect(msg).toBe(`${agent} timed out after 9000ms`);
      expect(msg).not.toContain('opencode');
    });

    it(`${agent}: spawn => "${agent} failed to start"`, () => {
      const result = makeRunResult({
        exitCode: -1,
        error: makeRunError({ kind: 'spawn', message: 'ENOENT' })
      });
      const msg = structuredMessage(result, ctx);
      expect(msg).toBe(`${agent} failed to start: ENOENT`);
    });
  }
});
