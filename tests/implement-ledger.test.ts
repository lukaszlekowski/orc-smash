import { describe, expect, it } from 'vitest';
import { isCompleteImplementLedger, validateImplementLedger } from '../src/implement-ledger.js';

const EVIDENCE_TABLE =
  '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
  '| --- | --- | --- | --- | --- |\n' +
  '| Step 1 | src/x.ts | pnpm test | pass | none |\n';

const COVERAGE_TABLE =
  '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
  '| --- | --- | --- | --- |\n' +
  '| Req A | src/x.ts | tests/x.test.ts | pass |\n';

const CONFIDENCE = 'State overall confidence that the implementation matches the spec: 0.95\n';

function ledger(evidence = EVIDENCE_TABLE, coverage = COVERAGE_TABLE, confidence = CONFIDENCE): string {
  return `${evidence}\n${coverage}\n${confidence}`;
}

describe('implementation ledger outcomes', () => {
  it('classifies a complete passing ledger as valid', () => {
    const result = validateImplementLedger(ledger());
    expect(result.kind).toBe('valid');
    expect(result.diagnostics).toEqual([]);
    expect(result.evidenceTableValid).toBe(true);
    expect(result.coverageTableValid).toBe(true);
    expect(result.confidenceValid).toBe(true);
    expect(isCompleteImplementLedger(ledger())).toBe(true);
  });

  it('accepts the existing passing vocabulary and confidence wording variants', () => {
    for (const status of ['pass', 'passed', 'success', 'succeeded', 'done', 'ok', 'verified', '✅']) {
      expect(validateImplementLedger(ledger(EVIDENCE_TABLE.replace('| pass |', `| ${status} |`))).kind).toBe('valid');
    }
    expect(validateImplementLedger(ledger(EVIDENCE_TABLE, COVERAGE_TABLE, 'Confidence: 0.95')).kind).toBe('valid');
    expect(validateImplementLedger(ledger(EVIDENCE_TABLE, COVERAGE_TABLE, 'State overall confidence: 0.95')).kind).toBe('valid');
    expect(validateImplementLedger(ledger(EVIDENCE_TABLE, COVERAGE_TABLE, 'Confidence: **0.95**')).kind).toBe('valid');
    expect(validateImplementLedger(ledger(EVIDENCE_TABLE, COVERAGE_TABLE, 'Confidence: _0.95_')).kind).toBe('valid');
    expect(validateImplementLedger(ledger(EVIDENCE_TABLE, COVERAGE_TABLE, 'Overall confidence that the implementation matches the specification: **0.97**.')).kind).toBe('valid');
    expect(validateImplementLedger(ledger(EVIDENCE_TABLE, COVERAGE_TABLE, 'Overall confidence: 0.97.')).kind).toBe('valid');
  });

  it('ignores unrelated confidence prose and rejects duplicate or conflicting confidence declarations', () => {
    const withUnrelated = validateImplementLedger(
      ledger(EVIDENCE_TABLE, COVERAGE_TABLE, 'Overall confidence: 0.50\nConfidence in unit-test coverage: 1'),
    );
    expect(withUnrelated.kind).toBe('blocked');
    expect(withUnrelated.confidence).toBe(0.5);

    const duplicateEqual = validateImplementLedger(
      ledger(EVIDENCE_TABLE, COVERAGE_TABLE, 'Overall confidence: 0.95\nOverall confidence: 0.95'),
    );
    expect(duplicateEqual.kind).toBe('unknown');
    expect(duplicateEqual.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'malformed-confidence' }),
    ]));

    const conflictOrder1 = validateImplementLedger(
      ledger(EVIDENCE_TABLE, COVERAGE_TABLE, 'Overall confidence: 0.50\nOverall confidence: 0.95'),
    );
    expect(conflictOrder1.kind).toBe('unknown');
    expect(conflictOrder1.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'malformed-confidence' }),
    ]));

    const conflictOrder2 = validateImplementLedger(
      ledger(EVIDENCE_TABLE, COVERAGE_TABLE, 'Overall confidence: 0.95\nOverall confidence: 0.50'),
    );
    expect(conflictOrder2.kind).toBe('unknown');
    expect(conflictOrder2.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'malformed-confidence' }),
    ]));
  });

  it.each(['❌', 'blocked', 'failed', 'pending', 'not run', 'skip', 'skipped', 'untested'])(
    'classifies recognized unresolved evidence status %s as blocked',
    (status) => {
      const result = validateImplementLedger(ledger(EVIDENCE_TABLE.replace('| pass |', `| ${status} |`)));
      expect(result.kind).toBe('blocked');
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'unresolved-row', table: 'evidence', rowLabel: 'Step 1' }),
      ]));
      expect(result.evidenceTableValid).toBe(true);
      expect(isCompleteImplementLedger(ledger(EVIDENCE_TABLE.replace('| pass |', `| ${status} |`)))).toBe(false);
    },
  );

  it('classifies unresolved coverage rows and below-threshold confidence as blocked', () => {
    const unresolvedCoverage = COVERAGE_TABLE.replace('| pass |', '| not run |');
    const result = validateImplementLedger(ledger(EVIDENCE_TABLE, unresolvedCoverage, 'Confidence: 0.94'));
    expect(result.kind).toBe('blocked');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unresolved-row', table: 'coverage', rowLabel: 'Req A' }),
      expect.objectContaining({ code: 'confidence-below-threshold' }),
    ]));
  });

  it('keeps free prose such as Status: blocked outside the unresolved vocabulary', () => {
    const result = validateImplementLedger(ledger(EVIDENCE_TABLE, COVERAGE_TABLE.replace('| pass |', '| Status: blocked |')));
    expect(result.kind).toBe('unknown');
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-status', table: 'coverage', rowLabel: 'Req A' }),
    ]));
    expect(result.coverageTableValid).toBe(false);
  });

  it('distinguishes missing and malformed tables', () => {
    const missingEvidence = validateImplementLedger(`${COVERAGE_TABLE}\n${CONFIDENCE}`);
    expect(missingEvidence.kind).toBe('unknown');
    expect(missingEvidence.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-evidence-table' }),
    ]));

    const headerOnly = validateImplementLedger(
      '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n| --- | --- | --- | --- | --- |\n\n'
      + COVERAGE_TABLE + CONFIDENCE,
    );
    expect(headerOnly.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'malformed-evidence-table' }),
    ]));

    const renamedColumn = validateImplementLedger(ledger(EVIDENCE_TABLE.replace('Deviation', 'Notes')));
    expect(renamedColumn.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'malformed-evidence-table' }),
    ]));
  });

  it('rejects bad column counts, empty cells, and unknown status cells', () => {
    const badColumns = EVIDENCE_TABLE.replace('| Step 1 | src/x.ts | pnpm test | pass | none |', '| Step 1 | src/x.ts | pnpm test | pass |');
    expect(validateImplementLedger(ledger(badColumns)).kind).toBe('unknown');

    const emptyCell = EVIDENCE_TABLE.replace('src/x.ts', '');
    expect(validateImplementLedger(ledger(emptyCell)).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'incomplete-row', table: 'evidence', rowLabel: 'Step 1' }),
    ]));

    const unknownStatus = EVIDENCE_TABLE.replace('| pass |', '| maybe |');
    expect(validateImplementLedger(ledger(unknownStatus)).kind).toBe('unknown');
    expect(validateImplementLedger(ledger(unknownStatus)).diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'invalid-status', table: 'evidence' }),
    ]));
  });

  it('requires numeric confidence, enforces 0..1, and keeps valid tables visible in diagnostics', () => {
    const missing = validateImplementLedger(`${EVIDENCE_TABLE}\n${COVERAGE_TABLE}`);
    expect(missing.kind).toBe('unknown');
    expect(missing.confidenceValid).toBe(false);
    expect(missing.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'missing-confidence' }),
    ]));

    const malformed = validateImplementLedger(ledger(EVIDENCE_TABLE, COVERAGE_TABLE, 'Confidence: high'));
    expect(malformed.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'malformed-confidence' }),
    ]));

    for (const value of ['-0.1', '1.01']) {
      const result = validateImplementLedger(ledger(EVIDENCE_TABLE, COVERAGE_TABLE, `Confidence: ${value}`));
      expect(result.kind).toBe('unknown');
      expect(result.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'confidence-out-of-range' }),
      ]));
    }
  });

  it('bounds row labels and diagnostics deterministically with an omitted count', () => {
    const rows = Array.from({ length: 14 }, (_, index) =>
      `| ${index} ${'x'.repeat(120)} | src/x.ts | pnpm test | pending | none |`,
    ).join('\n');
    const evidence = EVIDENCE_TABLE.replace('| Step 1 | src/x.ts | pnpm test | pass | none |', rows);
    const first = validateImplementLedger(ledger(evidence));
    const second = validateImplementLedger(ledger(evidence));
    expect(first.kind).toBe('blocked');
    expect(first).toEqual(second);
    expect(first.omittedDiagnostics).toBeGreaterThan(0);
    expect(first.diagnostics.every(item => item.message.length <= 220)).toBe(true);
    expect(first.diagnostics.filter(item => item.rowLabel).every(item => item.rowLabel!.length <= 72)).toBe(true);
  });

  it('accepts tables in either order', () => {
    expect(validateImplementLedger(`${COVERAGE_TABLE}\n${EVIDENCE_TABLE}\n${CONFIDENCE}`).kind).toBe('valid');
  });
});
