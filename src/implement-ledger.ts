/**
 * The implementation evidence-ledger contract: what the harness treats as a
 * genuinely-written `docs/dev/impl-v{n}-{agent}.md` ledger. This is the runtime
 * artifact gate for the `30-simple-implement` skill's two required tables
 * (evidence + coverage), row completeness, and confidence declaration.
 * The closeout checklist (plan status update, change-log entry) is NOT
 * runtime-gated from the ledger markdown — it is verified by
 * `tests/loop-implement.test.ts` (see Step 12 "post-implementation closeout"
 * cases) and by the env-gated real-provider contract suite (Step 13).
 */

const EVIDENCE_TABLE_HEADER = /^\s*\|[^|\n]*Plan Step[^|\n]*\|[^|\n]*Files Changed[^|\n]*\|[^|\n]*Tests\s*\/\s*Verification[^|\n]*\|[^|\n]*Result[^|\n]*\|[^|\n]*Deviation[^|\n]*\|\s*$/im;
const COVERAGE_TABLE_HEADER = /^\s*\|[^|\n]*Spec Requirement[^|\n]*\|[^|\n]*Implemented In[^|\n]*\|[^|\n]*Verified By[^|\n]*\|[^|\n]*Status[^|\n]*\|\s*$/im;
const CONFIDENCE = /^[^\n]*\bconfidence\b[^\n]*\b\d+(?:\.\d+)?\b[^\n]*$/im;
const PASSING_STATUS = /^(?:pass|passed|success|succeeded|done|ok|verified|✅)(?:\s*\(.*?\))?$/i;

function isPassingLedgerStatus(cell: string): boolean {
  return PASSING_STATUS.test(cell.trim());
}

function parseMarkdownTable(content: string, headerPattern: RegExp, expectedColumns: number): string[][] | null {
  const lines = content.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => headerPattern.test(line));
  if (headerIndex < 0 || headerIndex + 1 >= lines.length) return null;

  const rows: string[][] = [];
  for (let i = headerIndex + 2; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim().startsWith('|')) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    if (cells.length !== expectedColumns) return null;
    rows.push(cells);
  }
  return rows.length > 0 ? rows : null;
}

function hasOnlyCompleteRows(rows: string[][], statusColumn: number): boolean {
  return rows.every((row) =>
    row.every((cell, index) => {
      if (!cell) return false;
      return index !== statusColumn || isPassingLedgerStatus(cell);
    })
  );
}

export interface ImplementLedgerValidation {
  valid: boolean;
  evidenceTableValid: boolean;
  coverageTableValid: boolean;
  confidenceValid: boolean;
}

export function validateImplementLedger(content: string): ImplementLedgerValidation {
  if (!content || !content.trim()) {
    return {
      valid: false,
      evidenceTableValid: false,
      coverageTableValid: false,
      confidenceValid: false
    };
  }

  const evidenceRows = parseMarkdownTable(content, EVIDENCE_TABLE_HEADER, 5);
  const coverageRows = parseMarkdownTable(content, COVERAGE_TABLE_HEADER, 4);
  const evidenceTableValid = Boolean(evidenceRows && hasOnlyCompleteRows(evidenceRows, 3));
  const coverageTableValid = Boolean(coverageRows && hasOnlyCompleteRows(coverageRows, 3));
  const confidenceValid = CONFIDENCE.test(content);

  return {
    valid: evidenceTableValid && coverageTableValid && confidenceValid,
    evidenceTableValid,
    coverageTableValid,
    confidenceValid
  };
}

export function isCompleteImplementLedger(content: string): boolean {
  return validateImplementLedger(content).valid;
}
