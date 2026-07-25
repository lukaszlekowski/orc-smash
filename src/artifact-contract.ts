import { readFileSync } from 'node:fs';
import type { OutputSpec } from './manifest.js';
import { validateImplementLedger, type ImplementLedgerValidation } from './implement-ledger.js';

export type DecisionOutcome = 'accepted' | 'retry' | 'unknown';
export type CompletionOutcome = 'COMPLETED' | 'BLOCKED' | 'unknown';
export type RequiredOutcome = 'valid' | 'blocked' | 'unknown';
export type ContractOutcome = 'accepted' | 'retry' | 'completed' | 'blocked' | 'valid' | 'unknown';

export interface ContractDiagnostic {
  code: string;
  message: string;
  table?: 'evidence' | 'coverage';
  rowLabel?: string;
  omittedCount?: number;
}

/** Pure, bounded context for an operator-confirmed one-line correction. */
export interface DecisionCorrectionDiagnostic {
  heading: string;
  acceptedToken: string;
  retryToken: string;
  safe: boolean;
  invalidLine?: string;
  firstSubstantiveLine?: string;
  lineIndex?: number;
  /** Internal source offsets used by replaceDecisionLine; not persisted. */
  lineStart?: number;
  lineEnd?: number;
  suggestedToken?: string;
  reason?: string;
}

export interface ContractClassification {
  kind: ContractOutcome;
  diagnostics: ContractDiagnostic[];
  detail?: string;
  correction?: DecisionCorrectionDiagnostic;
}

function bounded(value: string, max = 240): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripFrontMatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  return match ? content.slice(match[0].length) : content;
}

function normalizeDecisionLine(line: string): string {
  return line
    .trim()
    .replace(/^(?:[*_>-]\s*)+/, '')
    .replace(/[*_]+$/, '')
    .trim()
    .toUpperCase();
}

function exactDecisionLine(line: string, acceptedToken: string, retryToken: string): DecisionOutcome {
  const normalized = normalizeDecisionLine(line);
  if (normalized === acceptedToken.trim().toUpperCase()) return 'accepted';
  if (normalized === retryToken.trim().toUpperCase()) return 'retry';
  return 'unknown';
}

function tokenStartsLine(line: string, token: string): boolean {
  const normalized = line.trim().replace(/^(?:[*_>-]\s*)+/, '').trim();
  const upper = normalized.toUpperCase();
  const expected = token.trim().toUpperCase();
  if (!expected || !upper.startsWith(expected)) return false;
  const next = normalized.slice(token.trim().length);
  return next.length === 0 || /^[\s\p{P}]/u.test(next);
}

function lineContainsToken(line: string, token: string): boolean {
  const normalized = line.toUpperCase();
  const expected = token.trim().toUpperCase();
  if (!expected) return false;
  let offset = normalized.indexOf(expected);
  while (offset >= 0) {
    const before = offset === 0 ? '' : normalized[offset - 1]!;
    const after = normalized[offset + expected.length] ?? '';
    const boundary = (!before || /[\s\p{P}]/u.test(before))
      && (!after || /[\s\p{P}]/u.test(after));
    if (boundary) return true;
    offset = normalized.indexOf(expected, offset + 1);
  }
  return false;
}

interface SectionLine {
  raw: string;
  lineIndex: number;
  start: number;
  end: number;
}

function sectionLines(content: string, sectionStart: number, sectionEnd: number): SectionLine[] {
  const section = content.slice(sectionStart, sectionEnd);
  const lines: SectionLine[] = [];
  let cursor = sectionStart;
  const parts = section.split('\n');
  for (let index = 0; index < parts.length; index += 1) {
    const rawWithCarriage = parts[index]!;
    const raw = rawWithCarriage.endsWith('\r') ? rawWithCarriage.slice(0, -1) : rawWithCarriage;
    const start = cursor;
    const end = start + raw.length;
    lines.push({ raw, lineIndex: content.slice(0, start).split('\n').length - 1, start, end });
    cursor += rawWithCarriage.length + (index < parts.length - 1 ? 1 : 0);
  }
  return lines;
}

/**
 * Diagnose a decision body without changing the strict parser. A candidate is
 * a non-blank line whose normalized form begins with exactly one configured
 * token; prose with an embedded token is deliberately not recoverable.
 */
export function diagnoseDecisionContent(
  content: string,
  heading: string,
  acceptedToken: string,
  retryToken: string,
): DecisionCorrectionDiagnostic {
  const headingPattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, 'gim');
  const matches = [...content.matchAll(headingPattern)];
  const base: DecisionCorrectionDiagnostic = {
    heading,
    acceptedToken,
    retryToken,
    safe: false,
  };
  if (matches.length !== 1) {
    return {
      ...base,
      reason: matches.length === 0
        ? 'configured decision section is missing'
        : 'configured decision section appears more than once',
    };
  }

  const headingMatch = matches[0]!;
  const sectionStart = headingMatch.index! + headingMatch[0].length;
  const remainder = content.slice(sectionStart);
  const nextHeading = /^##\s+/m.exec(remainder);
  const sectionEnd = nextHeading ? sectionStart + nextHeading.index : content.length;
  const substantive = sectionLines(content, sectionStart, sectionEnd).filter(line => line.raw.trim() !== '');
  const first = substantive[0];
  const candidates = substantive.filter(line => {
    const startsAccepted = tokenStartsLine(line.raw, acceptedToken);
    const startsRetry = tokenStartsLine(line.raw, retryToken);
    return startsAccepted || startsRetry;
  });
  const withLine = first
    ? { ...base, invalidLine: bounded(first.raw), firstSubstantiveLine: bounded(first.raw), lineIndex: first.lineIndex }
    : base;
  if (candidates.length !== 1) {
    return {
      ...withLine,
      reason: candidates.length === 0
        ? 'no identifiable decision line begins with a configured token'
        : 'multiple candidate decision lines are present',
    };
  }

  const candidate = candidates[0]!;
  const startsAccepted = tokenStartsLine(candidate.raw, acceptedToken);
  const startsRetry = tokenStartsLine(candidate.raw, retryToken);
  const starts = [
    ...(startsAccepted ? [acceptedToken] : []),
    ...(startsRetry ? [retryToken] : []),
  ];
  const hasBothTokens = lineContainsToken(candidate.raw, acceptedToken)
    && lineContainsToken(candidate.raw, retryToken);
  const candidateContext = {
    ...base,
    invalidLine: bounded(candidate.raw),
    ...(first ? { firstSubstantiveLine: bounded(first.raw) } : {}),
    lineIndex: candidate.lineIndex,
  };
  return {
    ...candidateContext,
    safe: true,
    lineIndex: candidate.lineIndex,
    lineStart: candidate.start,
    lineEnd: candidate.end,
    ...(starts.length === 1 && !hasBothTokens ? { suggestedToken: starts[0] } : {}),
  };
}

/** Replace only the identified decision line with one exact configured token. */
export function replaceDecisionLine(
  content: string,
  diagnostic: DecisionCorrectionDiagnostic,
  selectedToken: string,
): string | null {
  if (!diagnostic.safe || diagnostic.lineStart === undefined || diagnostic.lineEnd === undefined) return null;
  const choices = [diagnostic.acceptedToken, diagnostic.retryToken];
  if (!choices.some(token => token === selectedToken)) return null;
  return content.slice(0, diagnostic.lineStart) + selectedToken + content.slice(diagnostic.lineEnd);
}

/** Parse a decision-artifact file against its configured tokens. */
export function parseDecisionArtifact(
  filePath: string,
  heading: string,
  acceptedToken: string,
  retryToken: string,
): DecisionOutcome {
  return parseDecisionContent(readFileSync(filePath, 'utf-8'), heading, acceptedToken, retryToken);
}

/** Parse exactly one configured decision section using exact token syntax. */
export function parseDecisionContent(
  content: string,
  heading: string,
  acceptedToken: string,
  retryToken: string,
): DecisionOutcome {
  const body = stripFrontMatter(content);
  const headingPattern = new RegExp(`^##\\s+${escapeRegex(heading)}\\s*$`, 'gim');
  const matches = [...body.matchAll(headingPattern)];
  if (matches.length !== 1) return 'unknown';

  const afterHeading = body.slice(matches[0]!.index! + matches[0]![0].length);
  const nextHeadingMatch = /^##\s+/m.exec(afterHeading);
  const section = nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;
  for (const rawLine of section.split('\n')) {
    if (!rawLine.trim()) continue;
    const result = exactDecisionLine(rawLine, acceptedToken, retryToken);
    if (result !== 'unknown') return result;
  }
  return 'unknown';
}

export function parseCompletionArtifact(filePath: string): CompletionOutcome {
  return parseCompletionContent(readFileSync(filePath, 'utf-8'));
}

export function parseCompletionContent(content: string): CompletionOutcome {
  const body = stripFrontMatter(content);
  const headingRe = /^##\s+Outcome\s*$/gim;
  const matches = [...body.matchAll(headingRe)];
  if (matches.length !== 1) return 'unknown';

  const afterHeading = body.slice(matches[0]!.index! + matches[0]![0].length);
  const nextHeadingMatch = /^##\s+/m.exec(afterHeading);
  const section = nextHeadingMatch ? afterHeading.slice(0, nextHeadingMatch.index) : afterHeading;
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line === 'COMPLETED') return 'COMPLETED';
    if (line === 'BLOCKED') return 'BLOCKED';
    return 'unknown';
  }
  return 'unknown';
}

function ledgerDiagnostics(result: ImplementLedgerValidation): ContractDiagnostic[] {
  const diagnostics: ContractDiagnostic[] = result.diagnostics.map(item => ({
    code: item.code,
    message: item.message,
    ...(item.table ? { table: item.table } : {}),
    ...(item.rowLabel ? { rowLabel: item.rowLabel } : {}),
  }));
  if (result.omittedDiagnostics > 0) {
    diagnostics.push({
      code: 'diagnostics-omitted',
      message: `${result.omittedDiagnostics} additional ledger diagnostic(s) omitted.`,
      omittedCount: result.omittedDiagnostics,
    });
  }
  return diagnostics;
}

function detailFor(diagnostics: ContractDiagnostic[], fallback: string): string {
  if (diagnostics.length === 0) return fallback;
  const suffix = diagnostics.length > 1 ? ` (+${diagnostics.length - 1} more)` : '';
  return bounded(`${diagnostics[0]!.message}${suffix}`);
}

type BodyValidator = (body: string) => boolean | ImplementLedgerValidation;

/**
 * Canonical body + output-spec classifier. It intentionally does not inspect
 * provenance; callers perform provenance validation as a separate gate.
 */
export function classifyOutputBody(
  output: Pick<OutputSpec, 'contract' | 'decision' | 'validator'>,
  body: string,
  customValidator?: BodyValidator,
): ContractClassification {
  const contractBody = stripFrontMatter(body);
  try {
    switch (output.contract) {
      case 'decision-artifact': {
        if (!output.decision) {
          return { kind: 'unknown', diagnostics: [{ code: 'missing-decision-config', message: 'Decision configuration is missing.' }], detail: 'decision configuration is missing' };
        }
        const result = parseDecisionContent(contractBody, output.decision.heading, output.decision.accepted, output.decision.retry);
        if (result !== 'unknown') return { kind: result, diagnostics: [] };
        const diagnostic = diagnoseDecisionContent(body, output.decision.heading, output.decision.accepted, output.decision.retry);
        const message = diagnostic.invalidLine
          ? `Decision line '${bounded(diagnostic.invalidLine)}' does not equal either configured token.`
          : `Decision artifact is unknown: ${diagnostic.reason ?? 'decision section is invalid'}.`;
        return {
          kind: 'unknown',
          diagnostics: [{ code: 'decision-unknown', message: bounded(message) }],
          detail: bounded(message),
          ...(diagnostic.safe ? { correction: diagnostic } : {}),
        };
      }
      case 'completion-artifact': {
        const result = parseCompletionContent(contractBody);
        if (result === 'COMPLETED') return { kind: 'completed', diagnostics: [] };
        if (result === 'BLOCKED') return { kind: 'blocked', diagnostics: [], detail: 'BLOCKED' };
        const diagnostics = [{ code: 'completion-unknown', message: 'Exactly one Outcome section with COMPLETED or BLOCKED is required.' }];
        return { kind: 'unknown', diagnostics, detail: diagnostics[0]!.message };
      }
      case 'required-artifact': {
        if (!contractBody.trim()) {
          const diagnostics = [{ code: 'empty-artifact', message: 'Required artifact is empty.' }];
          return { kind: 'unknown', diagnostics, detail: diagnostics[0]!.message };
        }
        if (output.validator === 'implement-ledger') {
          const result = validateImplementLedger(contractBody);
          const diagnostics = ledgerDiagnostics(result);
          return {
            kind: result.kind,
            diagnostics,
            detail: result.kind === 'valid' ? undefined : detailFor(diagnostics, `Implementation ledger is ${result.kind}.`),
          };
        }
        if (customValidator) {
          const result = customValidator(contractBody);
          if (typeof result === 'boolean') {
            return result
              ? { kind: 'valid', diagnostics: [] }
              : { kind: 'unknown', diagnostics: [{ code: 'validator-failed', message: 'Required artifact validator failed.' }], detail: 'validator failed' };
          }
          const diagnostics = ledgerDiagnostics(result);
          return { kind: result.kind, diagnostics, detail: result.kind === 'valid' ? undefined : detailFor(diagnostics, `Required artifact is ${result.kind}.`) };
        }
        return { kind: 'valid', diagnostics: [] };
      }
      default:
        return { kind: 'unknown', diagnostics: [{ code: 'unsupported-contract', message: 'Unsupported output contract.' }], detail: 'unsupported output contract' };
    }
  } catch (error: any) {
    const message = bounded(error?.message ?? String(error));
    return { kind: 'unknown', diagnostics: [{ code: 'classifier-error', message }], detail: message };
  }
}
