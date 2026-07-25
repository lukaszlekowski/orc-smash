/**
 * Structural and outcome-aware validation for the implementation evidence
 * ledger. The parser deliberately understands only the two declared tables
 * and the confidence declaration; it never infers completion from prose.
 */

const EVIDENCE_TABLE_HEADER = ['plan step', 'files changed', 'tests / verification', 'result', 'deviation'];
const COVERAGE_TABLE_HEADER = ['spec requirement / checklist item', 'implemented in', 'verified by', 'status'];
const CONFIDENCE_THRESHOLD = 0.95;
const MAX_DIAGNOSTICS = 8;
const MAX_LABEL_LENGTH = 72;
const MAX_MESSAGE_LENGTH = 220;

export type ImplementLedgerKind = 'valid' | 'blocked' | 'unknown';
export type LedgerTable = 'evidence' | 'coverage';

export type ImplementLedgerDiagnosticCode =
  | 'missing-evidence-table'
  | 'malformed-evidence-table'
  | 'missing-coverage-table'
  | 'malformed-coverage-table'
  | 'missing-confidence'
  | 'malformed-confidence'
  | 'confidence-out-of-range'
  | 'confidence-below-threshold'
  | 'incomplete-row'
  | 'invalid-status'
  | 'unresolved-row';

export interface ImplementLedgerDiagnostic {
  code: ImplementLedgerDiagnosticCode;
  message: string;
  table?: LedgerTable;
  rowLabel?: string;
}

export interface ImplementLedgerValidation {
  kind: ImplementLedgerKind;
  diagnostics: ImplementLedgerDiagnostic[];
  omittedDiagnostics: number;
  evidenceTableValid: boolean;
  coverageTableValid: boolean;
  confidenceValid: boolean;
  confidence?: number;
}

const PASSING_STATUS = /^(?:pass|passed|success|succeeded|done|ok|verified|✅)(?:\s*\(.*?\))?$/i;
const UNRESOLVED_STATUS = /^(?:❌|blocked|failed|pending|not\s+run|skip(?:ped)?|untested)(?:\s*\(.*?\))?$/i;

interface ParsedTable {
  rows: string[][];
  valid: boolean;
  headerFound: boolean;
}

interface TableSpec {
  name: LedgerTable;
  header: string[];
  expectedColumns: number;
}

interface RowIssue {
  kind: 'incomplete-row' | 'invalid-status' | 'unresolved-row';
  label: string;
  table: LedgerTable;
  status?: string;
}

function bounded(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1)}…`;
}

function rowLabel(value: string): string {
  return bounded(value, MAX_LABEL_LENGTH) || '(blank row label)';
}

function splitRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  return trimmed.slice(1, -1).split('|').map(cell => cell.trim());
}

function headerMatches(cells: string[], expected: string[]): boolean {
  if (cells.length !== expected.length) return false;
  return expected.every((item, index) => cells[index]!.toLowerCase() === item);
}

function separatorMatches(line: string, expectedColumns: number): boolean {
  const cells = splitRow(line);
  return Boolean(
    cells
      && cells.length === expectedColumns
      && cells.every(cell => /^:?-{3,}:?$/.test(cell)),
  );
}

function tableSpec(name: LedgerTable): TableSpec {
  return name === 'evidence'
    ? { name, header: EVIDENCE_TABLE_HEADER, expectedColumns: 5 }
    : { name, header: COVERAGE_TABLE_HEADER, expectedColumns: 4 };
}

function parseTable(content: string, spec: TableSpec): ParsedTable {
  const lines = content.split(/\r?\n/);
  const headers = lines
    .map((line, index) => ({ line, index, cells: splitRow(line) }))
    .filter(item => item.cells && headerMatches(item.cells, spec.header));

  if (headers.length === 0) {
    const headerCue = lines.some(line => {
      const cells = splitRow(line);
      return Boolean(cells && cells.length === spec.expectedColumns && cells[0]!.toLowerCase().includes(spec.header[0]!));
    });
    return { rows: [], valid: false, headerFound: headerCue };
  }
  if (headers.length !== 1) return { rows: [], valid: false, headerFound: true };

  const header = headers[0]!;
  if (!separatorMatches(lines[header.index + 1] ?? '', spec.expectedColumns)) {
    return { rows: [], valid: false, headerFound: true };
  }

  const rows: string[][] = [];
  for (let index = header.index + 2; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) break;
    if (!line.trim().startsWith('|')) break;
    const cells = splitRow(line);
    if (!cells || cells.length !== spec.expectedColumns) {
      rows.push(cells ?? [line.trim()]);
      return { rows, valid: false, headerFound: true };
    }
    rows.push(cells);
  }

  return { rows, valid: rows.length > 0, headerFound: true };
}

function isPassingStatus(cell: string): boolean {
  return PASSING_STATUS.test(cell.trim());
}

function isUnresolvedStatus(cell: string): boolean {
  return UNRESOLVED_STATUS.test(cell.trim());
}

function inspectRows(rows: string[][], table: LedgerTable, statusColumn: number): RowIssue[] {
  const issues: RowIssue[] = [];
  for (const row of rows) {
    const label = rowLabel(row[0] ?? '');
    if (row.length <= statusColumn || row.some(cell => !cell.trim())) {
      issues.push({ kind: 'incomplete-row', table, label });
      continue;
    }

    const status = row[statusColumn]!.trim();
    if (isPassingStatus(status)) continue;
    if (isUnresolvedStatus(status)) {
      issues.push({ kind: 'unresolved-row', table, label, status: bounded(status, 48) });
    } else {
      issues.push({ kind: 'invalid-status', table, label, status: bounded(status, 48) });
    }
  }
  return issues;
}

function tableDiagnostic(spec: TableSpec, parsed: ParsedTable): ImplementLedgerDiagnostic {
  const kind = parsed.headerFound ? 'malformed' : 'missing';
  const code = `${kind}-${spec.name}-table` as ImplementLedgerDiagnosticCode;
  const message = kind === 'missing'
    ? `Required ${spec.name} table is missing.`
    : `Required ${spec.name} table is malformed (header, separator, row, or column count).`;
  return { code, table: spec.name, message };
}

function rowDiagnostic(issue: RowIssue): ImplementLedgerDiagnostic {
  if (issue.kind === 'incomplete-row') {
    return {
      code: issue.kind,
      table: issue.table,
      rowLabel: issue.label,
      message: `${issue.table} row '${issue.label}' has a missing or malformed cell.`,
    };
  }
  if (issue.kind === 'invalid-status') {
    return {
      code: issue.kind,
      table: issue.table,
      rowLabel: issue.label,
      message: `${issue.table} row '${issue.label}' has an unrecognized status '${issue.status ?? '(blank)'}'.`,
    };
  }
  return {
    code: issue.kind,
    table: issue.table,
    rowLabel: issue.label,
    message: `${issue.table} row '${issue.label}' is unresolved (${issue.status ?? 'unresolved'}).`,
  };
}

function confidenceDiagnostics(content: string): {
  valid: boolean;
  value?: number;
  diagnostics: ImplementLedgerDiagnostic[];
  belowThreshold: boolean;
} {
  const confidenceLines = content
    .split(/\r?\n/)
    .filter(line => /\bconfidence\b/i.test(line));
  if (confidenceLines.length === 0) {
    return {
      valid: false,
      diagnostics: [{ code: 'missing-confidence', message: 'A confidence declaration is required.' }],
      belowThreshold: false,
    };
  }

  const line = confidenceLines[confidenceLines.length - 1]!;
  const colon = line.lastIndexOf(':');
  const rawValue = colon >= 0 ? line.slice(colon + 1).replace(/[\s*]+$/g, '').trim() : '';
  const value = Number(rawValue);
  if (!rawValue || !Number.isFinite(value)) {
    return {
      valid: false,
      diagnostics: [{ code: 'malformed-confidence', message: 'Confidence must declare a numeric value.' }],
      belowThreshold: false,
    };
  }
  if (value < 0 || value > 1) {
    return {
      valid: false,
      value,
      diagnostics: [{ code: 'confidence-out-of-range', message: `Confidence ${bounded(rawValue, 32)} is outside the allowed range 0..1.` }],
      belowThreshold: false,
    };
  }
  if (value < CONFIDENCE_THRESHOLD) {
    return {
      valid: true,
      value,
      diagnostics: [{ code: 'confidence-below-threshold', message: `Confidence ${value} is below the ${CONFIDENCE_THRESHOLD} completion threshold.` }],
      belowThreshold: true,
    };
  }
  return { valid: true, value, diagnostics: [], belowThreshold: false };
}

function capDiagnostics(diagnostics: ImplementLedgerDiagnostic[]): {
  diagnostics: ImplementLedgerDiagnostic[];
  omittedDiagnostics: number;
} {
  const boundedDiagnostics = diagnostics.map(item => ({
    ...item,
    rowLabel: item.rowLabel ? bounded(item.rowLabel, MAX_LABEL_LENGTH) : undefined,
    message: bounded(item.message, MAX_MESSAGE_LENGTH),
  }));
  return {
    diagnostics: boundedDiagnostics.slice(0, MAX_DIAGNOSTICS),
    omittedDiagnostics: Math.max(0, boundedDiagnostics.length - MAX_DIAGNOSTICS),
  };
}

/**
 * Classify an implementation ledger without reading provenance or filenames.
 * A structurally complete ledger with recognized unresolved gates is blocked;
 * malformed structure and unknown vocabulary remain unknown.
 */
export function validateImplementLedger(content: string): ImplementLedgerValidation {
  const evidenceSpec = tableSpec('evidence');
  const coverageSpec = tableSpec('coverage');
  const evidence = parseTable(content, evidenceSpec);
  const coverage = parseTable(content, coverageSpec);
  const confidence = confidenceDiagnostics(content);
  const diagnostics: ImplementLedgerDiagnostic[] = [];

  if (!evidence.valid) diagnostics.push(tableDiagnostic(evidenceSpec, evidence));
  if (!coverage.valid) diagnostics.push(tableDiagnostic(coverageSpec, coverage));

  const evidenceIssues = evidence.valid ? inspectRows(evidence.rows, 'evidence', 3) : [];
  const coverageIssues = coverage.valid ? inspectRows(coverage.rows, 'coverage', 3) : [];
  for (const issue of [...evidenceIssues, ...coverageIssues]) diagnostics.push(rowDiagnostic(issue));
  diagnostics.push(...confidence.diagnostics);

  const hasStructuralFailure = !evidence.valid
    || !coverage.valid
    || evidenceIssues.some(issue => issue.kind !== 'unresolved-row')
    || coverageIssues.some(issue => issue.kind !== 'unresolved-row')
    || !confidence.valid;
  const hasBlockedOutcome = evidenceIssues.some(issue => issue.kind === 'unresolved-row')
    || coverageIssues.some(issue => issue.kind === 'unresolved-row')
    || confidence.belowThreshold;
  const kind: ImplementLedgerKind = hasStructuralFailure
    ? 'unknown'
    : hasBlockedOutcome
      ? 'blocked'
      : 'valid';
  const capped = capDiagnostics(diagnostics);

  return {
    kind,
    diagnostics: capped.diagnostics,
    omittedDiagnostics: capped.omittedDiagnostics,
    evidenceTableValid: evidence.valid && !evidenceIssues.some(issue => issue.kind !== 'unresolved-row'),
    coverageTableValid: coverage.valid && !coverageIssues.some(issue => issue.kind !== 'unresolved-row'),
    confidenceValid: confidence.valid,
    ...(confidence.value === undefined ? {} : { confidence: confidence.value }),
  };
}

export function isCompleteImplementLedger(content: string): boolean {
  return validateImplementLedger(content).kind === 'valid';
}

export const IMPLEMENT_LEDGER_CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD;
