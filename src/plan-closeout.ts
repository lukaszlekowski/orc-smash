import { readFileSync, writeFileSync } from 'node:fs';
import { validateCanonicalPlanMetadata } from './plan-metadata.js';

export type CloseoutStatus = 'done' | 'blocked';

export interface CloseoutSignal {
  status: CloseoutStatus;
  /** Human-readable reason when status is 'blocked' (low confidence). */
  reason?: string;
  /**
   * Deviations recorded from evidence rows; preserved in the change log
   * entry but NEVER force `status: 'blocked'`. Per the v5-audit M1 fix,
   * the only `blocked` trigger is low confidence — a documented deviation
   * is a normal post-implementation artifact, not a workflow-terminating
   * failure signal (the `30-simple-implement` skill only mandates
   * `blocked` on `< 0.95` confidence; minor documented deviations are
   * not declared terminal by the skill).
   */
  deviations: string[];
}

/**
 * Below this confidence value the closeout status is 'blocked' rather than
 * 'done'. Exported so the contract test in Step 12 can pin the threshold.
 * `30-simple-implement` requires the implementer to "State overall
 * confidence that the implementation matches the spec" — and requires the
 * implementer to STOP and mark the run blocked if that value is below
 * 0.95 (Pre-Implementation Check: "If confidence < 0.95, stop and list the
 * specific blockers before writing code"; Post-Implementation step 5:
 * "If confidence < 0.95, mark the implementation blocked and list the
 * specific unresolved blockers"). A ledger that reports a value below
 * 0.95 means the implementer explicitly flagged the run as low-confidence
 * and the closeout MUST surface that, not silently write 'done'.
 */
export const BLOCKED_CONFIDENCE_THRESHOLD = 0.95;

/**
 * Pure function: derive the closeout signal from a verified implement-ledger.
 * Rules (v5-audit M1 fix — only confidence drives `blocked`):
 *   1. If the ledger's confidence declaration parses to a number below
 *      BLOCKED_CONFIDENCE_THRESHOLD (0.95) → status: 'blocked',
 *      reason: 'confidence < N below threshold 0.95'.
 *   2. Otherwise → status: 'done' (any non-trivial deviation row is
 *      recorded in `signal.deviations` and rendered in the change log
 *      entry, but is NOT a workflow-terminating signal — the skill only
 *      mandates `blocked` on low confidence; a documented deviation is
 *      a normal post-implementation artifact, not a failure).
 * This is a pure function over the ledger string — no I/O, no shared state.
 * It accepts the same confidence-line shapes the artifact gate accepts
 * (`State overall confidence: 0.94`, `Confidence score: 0.94`, etc.).
 */
export function deriveCloseoutSignal(ledgerContent: string): CloseoutSignal {
  // Scan the evidence table for deviations. Deviations are recorded
  // (preserved in the change log entry) but NEVER auto-block — see
  // the v5-audit M1 fix. The evidence-table header is anchored on
  // `Plan Step | Files Changed | Tests / Verification | Result | Deviation`;
  // the `Deviation` column is the last cell of each row.
  // v7-audit C1 fix: JavaScript RegExp does NOT support `\Z` as an
  // end-of-string anchor (it is a literal `Z`). The original regex
  // used `(?=\n\s*\n|\Z)`, which silently fails to terminate at end
  // of input — a ledger whose evidence table is the last block in
  // the file (no trailing blank line) would NOT match. The fix uses
  // `(?![\s\S])` instead, which is the standard JavaScript idiom
  // for "end of input" (negative lookahead for any character —
  // succeeds only when there is no next character, i.e. at end of
  // string). Note: `\s*$` with the `m` flag is NOT a correct
  // substitute, because `$` in multiline mode matches end of EVERY
  // line, not just end of input — the non-greedy `[\s\S]*?` would
  // stop at the end of the header line and the table body would
  // never be captured. `(?![\s\S])` is unambiguous: it only matches
  // at end of input.
  const evidenceTableMatch = ledgerContent.match(
    /^\s*\|[^|\n]*Plan Step[^|\n]*\|[^|\n]*Files Changed[^|\n]*\|[^|\n]*Tests\s*\/\s*Verification[^|\n]*\|[^|\n]*Result[^|\n]*\|[^|\n]*Deviation[^|\n]*\|[\s\S]*?(?=\n\s*\n|(?![\s\S]))/im
  );
  const deviations: string[] = [];
  if (evidenceTableMatch) {
    const rows = evidenceTableMatch[0].split('\n').filter((l) => /^\s*\|/.test(l));
    // Skip the header row AND the separator row (`| --- | ... |`).
    const dataRows = rows.filter(
      (l) => !/^\s*\|[\s|:-]+\|\s*$/.test(l)
    ).slice(1);
    for (const row of dataRows) {
      const cells = row.split('|').map((c) => c.trim()).filter((c) => c !== '');
      // Last cell is the Deviation column; tolerate a trailing empty cell from
      // the leading/trailing `|` delimiters.
      const deviation = (cells[cells.length - 1] ?? '').toLowerCase();
      if (deviation && deviation !== 'none' && deviation !== '-' && deviation !== 'n/a') {
        deviations.push(cells[cells.length - 1] ?? '');
      }
    }
  }

  const confMatch = ledgerContent.match(/\bconfidence\b[^\n]*?\b(\d+(?:\.\d+)?)\b/i);
  if (confMatch) {
    const conf = parseFloat(confMatch[1]!);
    if (Number.isFinite(conf) && conf < BLOCKED_CONFIDENCE_THRESHOLD) {
      return {
        status: 'blocked',
        reason: `confidence ${conf.toFixed(2)} below threshold ${BLOCKED_CONFIDENCE_THRESHOLD}`,
        deviations
      };
    }
  }
  return { status: 'done', deviations };
}

export interface WritePlanCloseoutOptions {
  planPath: string;
  version: number;
  agent: string;
  signal: CloseoutSignal;
  /** Injectable ISO timestamp; tests use a fixed value for determinism. */
  timestamp?: string;
}

export type WritePlanCloseoutResult =
  | { ok: true; status: CloseoutStatus; changeLogCreated: boolean; changeLogAppended: true }
  | { ok: false; error: string };

/**
 * Read `planPath`, update the front-matter `status:` to `signal.status`, and
 * append a new `### Implementation v{n}-{agent} {timestamp}` entry to the
 * `## Change Log` section — creating the section if it does not exist (the
 * real `docs/dev/plan.md` currently has front matter but NO `## Change Log`,
 * so the missing-section branch is the path the v3-audit C1 closeout tests
 * must cover). The pre-existing `## Change Log` content (if any) is
 * preserved: new entries are appended at the END of the section (just before
 * the next `## ` heading or at end of file), never inserted at the top of
 * the section — see the v4-audit M2 finding for why append (not prepend) is
 * the contract.
 *
 * If `signal.deviations` is non-empty, the change log entry includes a
 * separate `- deviations:` line listing the recorded deviation values.
 * Deviations are recorded as evidence, not as a blocked trigger (the
 * v5-audit M1 fix). Returns `{ ok: true, status, changeLogCreated,
 * changeLogAppended }` on success, or `{ ok: false, error }` if the plan
 * file is missing or the front matter is malformed (no `---` delimiters).
 */
export function writePlanCloseout(opts: WritePlanCloseoutOptions): WritePlanCloseoutResult {
  const metadata = validateCanonicalPlanMetadata(opts.planPath);
  if (!metadata.ok) return metadata;
  const original = readFileSync(opts.planPath, 'utf-8');
  const timestamp = opts.timestamp ?? new Date().toISOString();
  const entryHeading = `### Implementation v${opts.version}-${opts.agent} ${timestamp}`;
  // v5-audit M1 fix: deviations are recorded as a SEPARATE `- deviations:`
  // line in the change log entry, not folded into the status reason. The
  // status itself reflects only the confidence gate; deviations are
  // documented evidence (the skill only mandates `blocked` on low
  // confidence). When no deviations are recorded, the deviations line
  // is omitted.
  const statusLine = `- status: ${opts.signal.status}${opts.signal.reason ? ` (${opts.signal.reason})` : ''}\n`;
  const deviationsLine = (opts.signal.deviations && opts.signal.deviations.length > 0)
    ? `- deviations: ${opts.signal.deviations.join('; ')}\n`
    : '';
  const entryBody = statusLine + deviationsLine;

  // 1. Update front-matter `status:` (must exist; if missing, error out so
  // a partial plan shape does not silently close out).
  const fmMatch = original.match(/^---\n([\s\S]*?)\n---\n/);
  if (!fmMatch) {
    return { ok: false, error: 'plan file has no front matter (missing `---` delimiters)' };
  }
  const fm = fmMatch[1]!;
  if (!/^(\s*)status:\s*\S+(\s*)$/m.test(fm)) {
    return { ok: false, error: 'plan front matter has no `status:` field' };
  }
  const updatedFm = fm.replace(/^(\s*)status:\s*\S+(\s*)$/m, `$1status: ${opts.signal.status}$2`);
  let body = original.replace(fmMatch[0], `---\n${updatedFm}\n---\n`);

  // 2. Ensure `## Change Log` section exists; append a new entry.
  // The append (not prepend) order is the v4-audit M2 contract: new
  // entries go to the END of the section (just before the next `## `
  // heading or at end of file), preserving pre-existing `###` entries
  // in their original order. The Step 12 change-log test asserts this
  // with `/Pre-batch baseline[\s\S]+### Implementation v1-fake/` — the
  // pre-existing entry must appear BEFORE the new entry.
  let changeLogCreated = false;
  if (/\n## Change Log\s*\n/.test(body)) {
    // v7-audit C1 fix: JavaScript RegExp does NOT support `\Z` as an
    // end-of-string anchor (it is treated as a literal `Z`). The
    // original lookahead `(?=\n## |\Z)` would fail to match end of
    // input, so a `## Change Log` section that sits at the end of
    // the plan file (e.g. the real `docs/dev/plan.md` shape once
    // the closeout creates the section) would NOT be detected as a
    // section to append to — the replacement would silently no-op
    // and the new `### Implementation v{n}-{agent}` entry would
    // never be written. With no flags, `$` matches end of input
    // directly, so `(?=\n## |$)` correctly covers both "next
    // `## ` heading" and "end of file" as the section boundary.
    body = body.replace(
      /(\n## Change Log\s*\n)([\s\S]*?)(?=\n## |$)/,
      (_match, heading, content) => {
        const trimmed = content.replace(/\s+$/, '');
        return `${heading}${trimmed}\n\n${entryHeading}\n${entryBody}`;
      }
    );
  } else {
    // Section missing — create it at the end of the file (the real
    // `docs/dev/plan.md` shape is "front matter + body, no `## Change Log`",
    // so this is the default path the v3-audit C1 closeout test exercises).
    body = body.replace(/\s*$/, '') + `\n\n## Change Log\n\n${entryHeading}\n${entryBody}`;
    changeLogCreated = true;
  }

  writeFileSync(opts.planPath, body, 'utf-8');
  return { ok: true, status: opts.signal.status, changeLogCreated, changeLogAppended: true };
}
