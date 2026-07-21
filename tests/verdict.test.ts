import { describe, it, expect } from 'vitest';
import { parseVerdict } from '../src/verdict.js';

describe('Verdict parser', () => {
  it('parses APPROVED from ## Verdict block', () => {
    const fileContent = `
# Plan Audit
Some findings...

## Verdict

APPROVED

Some other notes.
    `;
    expect(parseVerdict(fileContent)).toBe('accepted');
  });

  it('parses REJECTED with bold markdown from ## Verdict block', () => {
    const fileContent = `
# Plan Audit
Some findings...

## Verdict

**REJECTED**

Some other notes.
    `;
    expect(parseVerdict(fileContent)).toBe('retry');
  });

  it('handles other characters/whitespace in Verdict block', () => {
    const fileContent = `
## Verdict
   APPROVED   
    `;
    expect(parseVerdict(fileContent)).toBe('accepted');
  });

  it('does not treat stdout as artifact evidence', () => {
    const stdout = 'Agent process ran. Verdict was APPROVED';
    expect(parseVerdict(null, stdout)).toBe('unknown');
  });

  it('returns unknown if missing both or both present or malformed', () => {
    const fileContent = `
## Verdict
Some text that is neither approved nor rejected.
    `;
    expect(parseVerdict(fileContent)).toBe('unknown');
    expect(parseVerdict(null, null)).toBe('unknown');
  });
});
