import { describe, expect, it } from 'vitest';
import {
  classifyOutputBody,
  diagnoseDecisionContent,
  parseCompletionContent,
  parseDecisionContent,
  replaceDecisionLine,
} from '../src/artifact-contract.js';

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

  it('classifies the same body identically with and without v1 front matter', () => {
    const body =
      '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
      '| --- | --- | --- | --- | --- |\n' +
      '| Step 1 | src/x.ts | pnpm test | pending | none |\n\n' +
      '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
      '| --- | --- | --- | --- |\n' +
      '| Req A | src/x.ts | tests/x.test.ts | pass |\n\n' +
      'Confidence: 0.95\n';
    const output = { contract: 'required-artifact' as const, validator: 'implement-ledger' };
    const bare = classifyOutputBody(output, body);
    const stamped = classifyOutputBody(output, `---\nschemaVersion: 1\n---\n\n${body}`);
    expect(stamped.kind).toBe(bare.kind);
    expect(stamped.diagnostics).toEqual(bare.diagnostics);
  });

  it('keeps custom decision tokens exact and reports a safe correction for a qualified line', () => {
    const output = {
      contract: 'decision-artifact' as const,
      decision: { heading: 'Call', accepted: 'SHIP', retry: 'HOLD' },
    };
    const body = '## Call\n\nHOLD (narrow)\n\nReason: check one thing\n';
    expect(classifyOutputBody(output, body).kind).toBe('unknown');
    const diagnostic = diagnoseDecisionContent(body, 'Call', 'SHIP', 'HOLD');
    expect(diagnostic).toMatchObject({ safe: true, invalidLine: 'HOLD (narrow)', suggestedToken: 'HOLD' });
    const corrected = replaceDecisionLine(body, diagnostic, 'SHIP');
    expect(corrected).toBe('## Call\n\nSHIP\n\nReason: check one thing\n');
    expect(classifyOutputBody(output, corrected!).kind).toBe('accepted');
  });

  it.each([
    'Not HOLD because the old result was different',
    'Previously HOLD was recorded',
    'The result is HOLD (narrow)',
    'HOLD and SHIP are both mentioned',
  ])('does not suggest a token for unsafe decision prose: %s', (line) => {
    const diagnostic = diagnoseDecisionContent(`## Verdict\n\n${line}\n`, 'Verdict', 'SHIP', 'HOLD');
    expect(diagnostic.suggestedToken).toBeUndefined();
  });

  it('rejects duplicate decision sections and multiple candidate lines for rewriting', () => {
    const duplicate = diagnoseDecisionContent('## Verdict\n\nHOLD (narrow)\n\n## Verdict\n\nSHIP (narrow)\n', 'Verdict', 'SHIP', 'HOLD');
    expect(duplicate.safe).toBe(false);
    const multiple = diagnoseDecisionContent('## Verdict\n\nHOLD (narrow)\nSHIP (other)\n', 'Verdict', 'SHIP', 'HOLD');
    expect(multiple.safe).toBe(false);
    expect(replaceDecisionLine('## Verdict\n\nHOLD\n', multiple, 'SHIP')).toBeNull();
  });
});
