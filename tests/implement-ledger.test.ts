import { describe, it, expect } from 'vitest';
import { isCompleteImplementLedger } from '../src/implement-ledger.js';

const EVIDENCE_TABLE =
  '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
  '| --- | --- | --- | --- | --- |\n' +
  '| Step 1 | src/x.ts | pnpm test | pass | none |\n';

const COVERAGE_TABLE =
  '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
  '| --- | --- | --- | --- |\n' +
  '| Req A | src/x.ts | tests/x.test.ts | pass |\n';

const CONFIDENCE_SCORE = 'Confidence score: 0.95\n';
const CONFIDENCE = 'Confidence: 0.95\n';
const STATE_OVERALL_CONFIDENCE = 'State overall confidence: 0.95\n';
const STATE_OVERALL_CONFIDENCE_FULL = 'State overall confidence that the implementation matches the spec: 0.95\n';

describe('isCompleteImplementLedger', () => {
  it('accepts a ledger with both required tables and a confidence declaration', () => {
    const body =
      '# Implementation Evidence Ledger\n\n' + EVIDENCE_TABLE + '\n' + COVERAGE_TABLE + '\n' + CONFIDENCE_SCORE;
    expect(isCompleteImplementLedger(body)).toBe(true);
  });

  it('accepts a ledger with the requirement coverage table appearing before the evidence table', () => {
    const body = COVERAGE_TABLE + '\n' + EVIDENCE_TABLE + '\n' + CONFIDENCE_SCORE;
    expect(isCompleteImplementLedger(body)).toBe(true);
  });

  it('accepts a ledger with case-insensitive Spec Requirement header', () => {
    const body =
      EVIDENCE_TABLE + '\n' +
      '| spec requirement / checklist item | Implemented In | Verified By | Status |\n' +
      '| --- | --- | --- | --- |\n' +
      '| Req A | src/x.ts | tests/x.test.ts | pass |\n\n' +
      CONFIDENCE_SCORE;
    expect(isCompleteImplementLedger(body)).toBe(true);
  });

  it('accepts the skill\'s literal post-implementation confidence wording ("State overall confidence:") — v2-audit C1 fix', () => {
    const body = EVIDENCE_TABLE + '\n' + COVERAGE_TABLE + '\n' + STATE_OVERALL_CONFIDENCE;
    expect(isCompleteImplementLedger(body)).toBe(true);
  });

  it('accepts the skill\'s full post-implementation confidence template ("State overall confidence that the implementation matches the spec:") — v2-audit C1 fix', () => {
    const body = EVIDENCE_TABLE + '\n' + COVERAGE_TABLE + '\n' + STATE_OVERALL_CONFIDENCE_FULL;
    expect(isCompleteImplementLedger(body)).toBe(true);
  });

  it('accepts the standalone "Confidence: 0.95" form', () => {
    const body = EVIDENCE_TABLE + '\n' + COVERAGE_TABLE + '\n' + CONFIDENCE;
    expect(isCompleteImplementLedger(body)).toBe(true);
  });

  it('rejects empty / whitespace', () => {
    expect(isCompleteImplementLedger('')).toBe(false);
    expect(isCompleteImplementLedger('   \n  ')).toBe(false);
  });

  it('rejects a ledger with only an evidence table (no coverage, no confidence) — partial implementation', () => {
    expect(isCompleteImplementLedger(EVIDENCE_TABLE)).toBe(false);
  });

  it('rejects a ledger with only a coverage table (no evidence, no confidence) — partial implementation', () => {
    expect(isCompleteImplementLedger(COVERAGE_TABLE)).toBe(false);
  });

  it('rejects a ledger with both tables but missing the confidence declaration', () => {
    expect(isCompleteImplementLedger(EVIDENCE_TABLE + '\n' + COVERAGE_TABLE)).toBe(false);
  });

  it('rejects header-only tables with no data rows', () => {
    const body =
      '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
      '| --- | --- | --- | --- | --- |\n\n' +
      '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
      '| --- | --- | --- | --- |\n\n' +
      CONFIDENCE_SCORE;
    expect(isCompleteImplementLedger(body)).toBe(false);
  });

  it('rejects rows with blank required cells', () => {
    const badEvidence =
      '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
      '| --- | --- | --- | --- | --- |\n' +
      '| Step 1 |  | pnpm test | pass | none |\n';
    expect(isCompleteImplementLedger(badEvidence + '\n' + COVERAGE_TABLE + '\n' + CONFIDENCE_SCORE)).toBe(false);
  });

  it('rejects a confidence declaration without a numeric value on the same line', () => {
    expect(isCompleteImplementLedger(EVIDENCE_TABLE + '\n' + COVERAGE_TABLE + '\nState overall confidence: high\n')).toBe(false);
  });

  it('rejects a ledger with a failing evidence Result', () => {
    const badEvidence =
      '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
      '| --- | --- | --- | --- | --- |\n' +
      '| Step 1 | src/x.ts | pnpm test | failed | none |\n';
    expect(isCompleteImplementLedger(badEvidence + '\n' + COVERAGE_TABLE + '\n' + CONFIDENCE_SCORE)).toBe(false);
  });

  it('rejects a ledger with a failing coverage Status', () => {
    const badCoverage =
      '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
      '| --- | --- | --- | --- |\n' +
      '| Req A | src/x.ts | tests/x.test.ts | blocked |\n';
    expect(isCompleteImplementLedger(EVIDENCE_TABLE + '\n' + badCoverage + '\n' + CONFIDENCE_SCORE)).toBe(false);
  });

  it('rejects evidence Result values that are skipped, not run, or untested', () => {
    const skipEvidence = EVIDENCE_TABLE.replace('pass', 'skipped');
    const notRunEvidence = EVIDENCE_TABLE.replace('pass', 'not run');
    const untestedEvidence = EVIDENCE_TABLE.replace('pass', 'untested');
    expect(isCompleteImplementLedger(skipEvidence + '\n' + COVERAGE_TABLE + '\n' + CONFIDENCE_SCORE)).toBe(false);
    expect(isCompleteImplementLedger(notRunEvidence + '\n' + COVERAGE_TABLE + '\n' + CONFIDENCE_SCORE)).toBe(false);
    expect(isCompleteImplementLedger(untestedEvidence + '\n' + COVERAGE_TABLE + '\n' + CONFIDENCE_SCORE)).toBe(false);
  });

  it('rejects coverage Status values that are skipped, not run, or untested', () => {
    const skipCoverage = COVERAGE_TABLE.replace('pass', 'skipped');
    const notRunCoverage = COVERAGE_TABLE.replace('pass', 'not run');
    const untestedCoverage = COVERAGE_TABLE.replace('pass', 'untested');
    expect(isCompleteImplementLedger(EVIDENCE_TABLE + '\n' + skipCoverage + '\n' + CONFIDENCE_SCORE)).toBe(false);
    expect(isCompleteImplementLedger(EVIDENCE_TABLE + '\n' + notRunCoverage + '\n' + CONFIDENCE_SCORE)).toBe(false);
    expect(isCompleteImplementLedger(EVIDENCE_TABLE + '\n' + untestedCoverage + '\n' + CONFIDENCE_SCORE)).toBe(false);
  });

  it('rejects a ledger with an evidence table whose columns are renamed (Deviation -> Notes) — wrong header cue', () => {
    const wrongEvidence =
      '| Plan Step | Files Changed | Tests / Verification | Result | Notes |\n' +
      '| --- | --- | --- | --- | --- |\n' +
      '| Step 1 | src/x.ts | pnpm test | pass | none |\n';
    expect(isCompleteImplementLedger(wrongEvidence + '\n' + COVERAGE_TABLE + '\n' + CONFIDENCE_SCORE)).toBe(false);
  });

  it('rejects a coverage table whose columns are renamed (Status -> Done) — wrong header cue', () => {
    const wrongCoverage =
      '| Spec Requirement / Checklist Item | Implemented In | Verified By | Done |\n' +
      '| --- | --- | --- | --- |\n' +
      '| Req A | src/x.ts | tests/x.test.ts | pass |\n';
    expect(isCompleteImplementLedger(EVIDENCE_TABLE + '\n' + wrongCoverage + '\n' + CONFIDENCE_SCORE)).toBe(false);
  });

  it('accepts passing status with optional parenthesized details (e.g. pass (env-gated))', () => {
    const customEvidence = EVIDENCE_TABLE.replace('pass', 'pass (env-gated)');
    const customCoverage = COVERAGE_TABLE.replace('pass', 'pass (CI)');
    const body = customEvidence + '\n' + customCoverage + '\n' + CONFIDENCE_SCORE;
    expect(isCompleteImplementLedger(body)).toBe(true);
  });

  it('rejects prose without the two required tables even if confidence appears', () => {
    expect(isCompleteImplementLedger('Did some work. ' + CONFIDENCE_SCORE)).toBe(false);
  });
});
