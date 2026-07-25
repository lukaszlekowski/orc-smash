import { describe, it, expect } from 'vitest';
import { classifyCompletion, resolveEffortConfirmation } from '../../src/adapters/completion.js';
import type { RunResult } from '../../src/adapters/types.js';

describe('classifyCompletion (normalized execution-completeness)', () => {
  function resultWith(stopReason: string | null): RunResult {
    return { stdout: '', exitCode: 0, stopReason };
  }

  it('opencode + stop => complete', () => {
    expect(classifyCompletion('opencode', resultWith('stop'))).toBe('complete');
  });

  it('opencode + tool-calls => complete', () => {
    expect(classifyCompletion('opencode', resultWith('tool-calls'))).toBe('complete');
  });

  it('opencode + length => truncated', () => {
    expect(classifyCompletion('opencode', resultWith('length'))).toBe('truncated');
  });

  it('opencode + null stop reason => missing completion signal', () => {
    expect(classifyCompletion('opencode', resultWith(null))).toBe('missing');
  });

  it('opencode + any other non-null reason => truncated', () => {
    expect(classifyCompletion('opencode', resultWith('content-filter'))).toBe('truncated');
  });

  it('codex + no signal => undefined (deferred to a later batch)', () => {
    expect(classifyCompletion('codex', resultWith(null))).toBeUndefined();
  });

  it('claude + no signal => undefined (deferred to a later batch)', () => {
    expect(classifyCompletion('claude', resultWith('stop'))).toBeUndefined();
  });
});

describe('resolveEffortConfirmation', () => {
  it('distinguishes requested, confirmed, mismatch, and reported', () => {
    expect(resolveEffortConfirmation({ effort: 'high' }, {})).toBe('requested');
    expect(resolveEffortConfirmation({ effort: 'high' }, { effectiveEffort: 'high' })).toBe('confirmed');
    expect(resolveEffortConfirmation({ effort: 'high' }, { effectiveEffort: 'max' })).toBe('mismatch');
    expect(resolveEffortConfirmation({}, { effectiveEffort: 'default' })).toBe('reported');
  });
});
