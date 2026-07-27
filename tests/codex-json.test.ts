import { describe, it, expect } from 'vitest';
import { parseCodexJsonOutput, CodexJsonParser } from '../src/adapters/codex-json.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('Codex JSON Stream Parser', () => {
  it.each([
    ['fresh', 'codex-stream-fresh.jsonl'],
    ['resumed', 'codex-stream-resumed.jsonl'],
  ])('parses the redacted real-derived %s stream fixture', (_mode, filename) => {
    const content = readFileSync(join(__dirname, 'fixtures', filename), 'utf8');
    const parser = new CodexJsonParser({ agent: 'codex', version: 1 });

    // Split within the first native JSONL record so the retained fixtures also
    // protect incremental framing, not only whole-buffer parsing.
    const splitAt = content.indexOf('"thread_id"');
    expect(parser.push(content.slice(0, splitAt))).toHaveLength(0);
    const progress = parser.push(content.slice(splitAt));
    const result = parser.finish();

    expect(progress).toEqual([
      expect.objectContaining({
        type: 'message',
        agent: 'codex',
        version: 1,
        text: 'command execution',
        toolCalls: 1,
      }),
    ]);
    expect(result).toEqual({
      sessionId: 'redacted-codex-thread',
      assistantText: '[REDACTED_ASSISTANT_TEXT]',
      toolCallCount: 1,
    });
  });

  it('captures thread.started.thread_id and reconstructs final assistant output', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"sess_12345"}',
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"APPROVED\\nDone."}}',
      '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
    ].join('\n');

    const result = parseCodexJsonOutput(stdout);
    expect(result.sessionId).toBe('sess_12345');
    expect(result.assistantText).toBe('APPROVED\nDone.');
  });

  it('fails explicitly when thread.started event is missing', () => {
    const stdout = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"APPROVED"}}'
    ].join('\n');

    expect(() => parseCodexJsonOutput(stdout)).toThrow('Missing thread.started event');
  });

  it('fails explicitly when thread_id is missing or invalid', () => {
    const stdout = [
      '{"type":"thread.started"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"APPROVED"}}'
    ].join('\n');

    expect(() => parseCodexJsonOutput(stdout)).toThrow('Missing thread_id');
  });

  it('fails explicitly when duplicate thread.started is present', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"sess_12345"}',
      '{"type":"thread.started","thread_id":"sess_67890"}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"APPROVED"}}'
    ].join('\n');

    expect(() => parseCodexJsonOutput(stdout)).toThrow('Duplicate thread.started event');
  });

  it('fails explicitly on malformed JSON', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"sess_12345"}',
      '{invalid json}',
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"APPROVED"}}'
    ].join('\n');

    expect(() => parseCodexJsonOutput(stdout)).toThrow('Malformed JSON output');
  });

  it('fails explicitly when agent_message item is missing', () => {
    const stdout = [
      '{"type":"thread.started","thread_id":"sess_12345"}',
      '{"type":"turn.completed"}'
    ].join('\n');

    expect(() => parseCodexJsonOutput(stdout)).toThrow('Missing final assistant output');
  });

  it('emits safe activity progress events and deduplicates tool items by ID', () => {
    const parser = new CodexJsonParser({ agent: 'codex', version: 1 });
    const events1 = parser.push('{"type":"thread.started","thread_id":"sess_100"}\n');
    expect(events1).toHaveLength(0);

    // Command execution item created
    const events2 = parser.push('{"type":"item.created","item":{"id":"tool-1","type":"command_execution","command":"ls -l"}}\n');
    expect(events2).toHaveLength(1);
    expect(events2[0]).toMatchObject({
      type: 'message',
      agent: 'codex',
      version: 1,
      text: 'command execution',
      toolCalls: 1
    });

    // Same item updated/completed: should NOT increment tool calls or emit duplicate progress
    const events3 = parser.push('{"type":"item.completed","item":{"id":"tool-1","type":"command_execution","command":"ls -l","output":"file.txt"}}\n');
    expect(events3).toHaveLength(0);

    // File change item created
    const events4 = parser.push('{"type":"item.created","item":{"id":"tool-2","type":"file_change","path":"foo.ts"}}\n');
    expect(events4).toHaveLength(1);
    expect(events4[0]).toMatchObject({
      type: 'message',
      agent: 'codex',
      version: 1,
      text: 'file change',
      toolCalls: 1
    });

    // Assistant message completed
    const events5 = parser.push('{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"APPROVED"}}\n');
    expect(events5).toHaveLength(0);

    const finalRes = parser.finish();
    expect(finalRes.sessionId).toBe('sess_100');
    expect(finalRes.assistantText).toBe('APPROVED');
    expect(finalRes.toolCallCount).toBe(2);
  });

  it('fails explicitly when duplicate thread.started is present in an unterminated final record', () => {
    const parser = new CodexJsonParser({ agent: 'codex', version: 1 });
    parser.push('{"type":"thread.started","thread_id":"sess_12345"}\n{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"APPROVED"}}');
    parser.push('\n{"type":"thread.started","thread_id":"sess_67890"}');
    expect(() => parser.finish()).toThrow('Duplicate thread.started event');
  });
});
