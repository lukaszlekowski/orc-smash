import { describe, it, expect } from 'vitest';
import { parseClaudeResult } from '../src/adapters/claude-result.js';

describe('Claude Result Parser', () => {
  it('captures session_id and assistantText from a valid Claude result object', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'hi there',
      session_id: '185763ee-56c5-4cfa-a427-13318b6af333'
    });

    const parsed = parseClaudeResult(stdout);
    expect(parsed.sessionId).toBe('185763ee-56c5-4cfa-a427-13318b6af333');
    expect(parsed.assistantText).toBe('hi there');
  });

  it('fails explicitly on empty input', () => {
    expect(() => parseClaudeResult('')).toThrow('Empty output received from Claude');
    expect(() => parseClaudeResult('   ')).toThrow('Empty output received from Claude');
  });

  it('fails explicitly on malformed JSON', () => {
    expect(() => parseClaudeResult('{invalid json}')).toThrow('Malformed JSON');
  });

  it('fails explicitly when output is not an object', () => {
    expect(() => parseClaudeResult('["result"]')).toThrow('Malformed JSON: output is not an object');
  });

  it('fails explicitly when session_id is missing', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: 'hi there'
    });
    expect(() => parseClaudeResult(stdout)).toThrow('Missing session_id');
  });

  it('fails explicitly when result is missing', () => {
    const stdout = JSON.stringify({
      type: 'result',
      session_id: '185763ee-56c5-4cfa-a427-13318b6af333'
    });
    expect(() => parseClaudeResult(stdout)).toThrow('Missing result');
  });
});
