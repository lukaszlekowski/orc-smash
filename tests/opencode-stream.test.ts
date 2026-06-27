import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseOpencodeStream, classifyOpencodeError } from '../src/adapters/opencode-stream.js';
import { scanStderrForError } from '../src/adapters/utils.js';

describe('opencode stream parser and classifier', () => {
  it('parses success stream correctly', () => {
    const raw = readFileSync(join(process.cwd(), 'tests/fixtures/opencode-success.ndjson'), 'utf-8');
    const result = parseOpencodeStream(raw);

    expect(result.finalText).toBe('Done.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].tool).toBe('write');
    expect(result.toolCalls[0].callID).toBe('call_123');
    expect(result.stopReason).toBe('stop');
    expect(result.finishReasons).toEqual(['tool-calls', 'stop']);
    expect(result.tokenUsage).toEqual({ prompt: 100, completion: 50, total: 150 });
    expect(result.streamError).toBeUndefined();
    expect(result.unparsed).toEqual([]);
  });

  it('parses error stream correctly', () => {
    const raw = readFileSync(join(process.cwd(), 'tests/fixtures/opencode-error.ndjson'), 'utf-8');
    const result = parseOpencodeStream(raw);

    expect(result.streamError).toBeDefined();
    expect(result.streamError?.name).toBe('UnknownError');
    expect(result.streamError?.message).toContain('Unexpected server error');
    expect(result.streamError?.ref).toBe('err_3a9287f2');

    const classified = classifyOpencodeError(result.streamError!);
    expect(classified.kind).toBe('server');
    expect(classified.message).toContain('Unexpected server error');
    expect(classified.ref).toBe('err_3a9287f2');
  });

  it('handles truncated or malformed lines gracefully', () => {
    const raw = `{"type":"text","part":{"type":"text","text":"Hello"}}
{"type": "step_finish"
{"type":"text","part":{"type":"text","text":" World"}}`;
    const result = parseOpencodeStream(raw);

    expect(result.finalText).toBe('Hello World');
    expect(result.unparsed).toEqual(['{"type": "step_finish"']);
  });

  it('handles empty input', () => {
    const result = parseOpencodeStream('');
    expect(result.finalText).toBe('');
    expect(result.toolCalls).toEqual([]);
    expect(result.streamError).toBeUndefined();
  });

  it('classifies auth error from stream message', () => {
    const err = { name: 'AuthError', message: 'unauthorized API key', ref: 'err_auth' };
    const classified = classifyOpencodeError(err);
    expect(classified.kind).toBe('auth');
  });

  it('classifies config/model error from stream message', () => {
    const err = { name: 'ModelError', message: 'model not found', ref: 'err_model' };
    const classified = classifyOpencodeError(err);
    expect(classified.kind).toBe('unknown-model');
  });

  it('scans stderr for config/auth error and returns correct RunError', () => {
    const configErr = scanStderrForError('Error: provider not found on server');
    expect(configErr).not.toBeNull();
    expect(configErr?.kind).toBe('config');

    const authErr = scanStderrForError('Error: unauthorized API key is invalid');
    expect(authErr).not.toBeNull();
    expect(authErr?.kind).toBe('auth');

    const noErr = scanStderrForError('some random output');
    expect(noErr).toBeNull();

    const emptyErr = scanStderrForError('');
    expect(emptyErr).toBeNull();
  });
});
