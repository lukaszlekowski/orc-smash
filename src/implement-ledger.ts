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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { patternToRegex } from './patterns.js';
import { parseArtifactMeta } from './provenance.js';

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
    if (cells.length !== expectedColumns) continue;
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

export function isCompleteImplementLedger(content: string): boolean {
  if (!content || !content.trim()) return false;

  const evidenceRows = parseMarkdownTable(content, EVIDENCE_TABLE_HEADER, 5);
  const coverageRows = parseMarkdownTable(content, COVERAGE_TABLE_HEADER, 4);
  if (!evidenceRows || !coverageRows) return false;

  return (
    hasOnlyCompleteRows(evidenceRows, 3) &&
    hasOnlyCompleteRows(coverageRows, 3) &&
    CONFIDENCE.test(content)
  );
}

export interface RawImplementLedger {
  version: number;
  agent: string;
  artifactPath: string;
  content: string;
}

function collectFiles(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === 'archived' ? [] : collectFiles(path);
      return [path];
    });
  } catch {
    return [];
  }
}

/**
 * A raw ledger is structurally complete but has no harness provenance. This is
 * deliberately narrower than a filename match: partial or malformed ledgers
 * must never become recoverable state.
 */
export function findHighestRawImplementLedger(
  projectRoot: string,
  implementPattern: string
): RawImplementLedger | null {
  const regex = patternToRegex(implementPattern);
  const candidates: RawImplementLedger[] = [];
  for (const artifactPath of collectFiles(projectRoot)) {
    const match = relative(projectRoot, artifactPath).match(regex);
    if (!match) continue;
    const version = Number(match[1]);
    const agent = match[2]!;
    try {
      const content = readFileSync(artifactPath, 'utf-8');
      const meta = parseArtifactMeta(content, { agent, version, kind: 'implement' });
      if (meta.loop !== 'unknown' || !isCompleteImplementLedger(content)) continue;
      candidates.push({ version, agent, artifactPath, content });
    } catch {
      // Corrupt artifacts are not recovery candidates.
    }
  }
  return candidates.sort((a, b) => b.version - a.version || b.artifactPath.localeCompare(a.artifactPath))[0] ?? null;
}
