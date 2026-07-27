import { describe, it, expect } from 'vitest';
import { parseClaudeStream, ClaudeStreamParser } from '../src/adapters/claude-stream.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Claude Stream Parser', () => {
  it.each([
    ['fresh', 'claude-stream-fresh.jsonl'],
    ['resumed', 'claude-stream-resumed.jsonl'],
  ])('parses the redacted real-derived %s stream fixture', (_mode, filename) => {
    const content = readFileSync(join(__dirname, 'fixtures', filename), 'utf8');
    const parser = new ClaudeStreamParser({ agent: 'claude', version: 1 });

    // Split inside the init record to cover native stream chunking as well as
    // the fresh/resumed shapes retained by these fixtures.
    const splitAt = content.indexOf('"session_id"');
    expect(parser.push(content.slice(0, splitAt))).toHaveLength(0);
    const progress = parser.push(content.slice(splitAt));
    const result = parser.finish();

    expect(progress).toEqual([
      expect.objectContaining({
        type: 'message',
        agent: 'claude',
        version: 1,
        text: 'command execution',
        toolCalls: 1,
      }),
    ]);
    expect(result).toEqual({
      sessionId: 'redacted-claude-session',
      assistantText: '[REDACTED_ASSISTANT_TEXT]',
      toolCallCount: 1,
    });
  });

  it('streams progress messages for tool_use blocks and counts unique tool IDs', () => {
    const parser = new ClaudeStreamParser({ agent: 'claude', version: 1 });
    const events1 = parser.push('{"type":"system","subtype":"init","session_id":"sess-123"}\n');
    expect(events1).toHaveLength(0);

    const events2 = parser.push('{"type":"assistant","session_id":"sess-123","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}\n');
    expect(events2).toHaveLength(1);
    expect(events2[0]).toMatchObject({
      type: 'message',
      agent: 'claude',
      version: 1,
      text: 'command execution',
      toolCalls: 1,
    });

    const events3 = parser.push('{"type":"assistant","session_id":"sess-123","message":{"id":"m2","content":[{"type":"tool_use","id":"t2","name":"Edit"}]}}\n');
    expect(events3).toHaveLength(1);
    expect(events3[0]).toMatchObject({
      type: 'message',
      agent: 'claude',
      version: 1,
      text: 'file change',
      toolCalls: 1,
    });

    // Duplicate tool ID t1 should not trigger another event or increment count
    const events4 = parser.push('{"type":"assistant","session_id":"sess-123","message":{"id":"m3","content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}\n');
    expect(events4).toHaveLength(0);

    const events5 = parser.push('{"type":"result","subtype":"success","session_id":"sess-123","result":"done"}\n');
    expect(events5).toHaveLength(0);

    const finalResult = parser.finish();
    expect(finalResult.sessionId).toBe('sess-123');
    expect(finalResult.assistantText).toBe('done');
    expect(finalResult.toolCallCount).toBe(2);
  });

  it('handles chunk-boundary splits across JSONL lines', () => {
    const parser = new ClaudeStreamParser({ agent: 'claude', version: 1 });
    parser.push('{"type":"system","sub');
    parser.push('type":"init","session_id":"sess-split"}\n');
    parser.push('{"type":"result","subtype":"success","session_id":"sess-split","result":"COMPLETED"}\n');
    const result = parser.finish();
    expect(result.sessionId).toBe('sess-split');
    expect(result.assistantText).toBe('COMPLETED');
  });

  it('fails explicitly when session_id is missing', () => {
    const stdout = '{"type":"result","result":"hi there"}\n';
    expect(() => parseClaudeStream(stdout)).toThrow('Missing session_id');
  });

  it('fails explicitly when terminal result is missing', () => {
    const stdout = '{"type":"system","session_id":"sess-123"}\n';
    expect(() => parseClaudeStream(stdout)).toThrow('Missing terminal result event');
  });

  it('fails explicitly on malformed stream input', () => {
    const stdout = '{"type":"system","session_id":"sess-123"}\n{invalid json}\n';
    expect(() => parseClaudeStream(stdout)).toThrow('Malformed JSON output');
  });

  it('fails explicitly on mismatched session_id in stream', () => {
    const parser = new ClaudeStreamParser();
    parser.push('{"type":"system","session_id":"sess-1"}\n');
    parser.push('{"type":"result","session_id":"sess-2","result":"hi"}\n');
    expect(() => parser.finish()).toThrow('Mismatched session_id');
  });

  it('fails explicitly on terminal error envelope with is_error: true or subtype: error', () => {
    const stdout = '{"type":"system","session_id":"sess-err"}\n{"type":"result","subtype":"error","is_error":true,"session_id":"sess-err","result":"provider failed"}\n';
    expect(() => parseClaudeStream(stdout)).toThrow('Claude execution failed with provider error');
  });

  it('fails explicitly on duplicate terminal result event', () => {
    const stdout = '{"type":"system","session_id":"sess-dup"}\n{"type":"result","subtype":"success","session_id":"sess-dup","result":"first"}\n{"type":"result","subtype":"success","session_id":"sess-dup","result":"second"}\n';
    expect(() => parseClaudeStream(stdout)).toThrow('Duplicate terminal result event');
  });

  it('fails explicitly when error result arrives in an unterminated final record', () => {
    const parser = new ClaudeStreamParser();
    parser.push('{"type":"system","session_id":"sess-unterm"}\n');
    parser.push('{"type":"result","subtype":"error","is_error":true,"session_id":"sess-unterm","result":"failed"}');
    expect(() => parser.finish()).toThrow('Claude execution failed with provider error');
  });
});
