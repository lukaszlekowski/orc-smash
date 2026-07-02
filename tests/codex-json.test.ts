import { describe, it, expect } from 'vitest';
import { parseCodexJsonOutput } from '../src/adapters/codex-json.js';

describe('Codex JSON Stream Parser', () => {
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
});
