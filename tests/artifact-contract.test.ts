import { describe, expect, it } from 'vitest';
import { parseCompletionContent, parseDecisionContent } from '../src/artifact-contract.js';

describe('generic artifact contracts', () => {
  it('normalizes configured decision tokens and does not scan unrelated sections', () => {
    expect(parseDecisionContent('# Result\nPASS\n\n## Decision\n\nFAIL\n', 'Decision', 'PASS', 'FAIL')).toBe('retry');
    expect(parseDecisionContent('## Decision\n\nPASS\n', 'Decision', 'PASS', 'FAIL')).toBe('accepted');
    expect(parseDecisionContent('## Notes\n\nPASS\n', 'Decision', 'PASS', 'FAIL')).toBe('unknown');
  });

  it('requires one exact completion Outcome section', () => {
    expect(parseCompletionContent('## Outcome\n\nCOMPLETED\n')).toBe('COMPLETED');
    expect(parseCompletionContent('## Outcome\n\nBLOCKED\n\nReason: missing input\n')).toBe('BLOCKED');
    expect(parseCompletionContent('## Outcome\n\nCOMPLETED\n\n## Outcome\n\nBLOCKED\n')).toBe('unknown');
    expect(parseCompletionContent('## Outcome\n\ncompleted with caveats\n')).toBe('unknown');
  });
});
