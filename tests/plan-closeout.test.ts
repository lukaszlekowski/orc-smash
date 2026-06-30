import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  deriveCloseoutSignal,
  writePlanCloseout,
  BLOCKED_CONFIDENCE_THRESHOLD
} from '../src/plan-closeout.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

const EVIDENCE_TABLE =
  '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
  '| --- | --- | --- | --- | --- |\n' +
  '| Step 1 | src/x.ts | pnpm test | pass | none |\n';

const COVERAGE_TABLE =
  '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
  '| --- | --- | --- | --- |\n' +
  '| Req A | src/x.ts | tests/x.test.ts | pass |\n';

const HIGH_CONF_LEDGER = EVIDENCE_TABLE + '\n' + COVERAGE_TABLE + '\nState overall confidence: 1.00\n';
const LOW_CONF_LEDGER  = EVIDENCE_TABLE + '\n' + COVERAGE_TABLE + '\nState overall confidence: 0.94\n';

describe('deriveCloseoutSignal', () => {
  it('returns done (with empty deviations) for high confidence + no deviation rows', () => {
    expect(deriveCloseoutSignal(HIGH_CONF_LEDGER)).toEqual({ status: 'done', deviations: [] });
  });

  it('returns blocked (with reason) for confidence below the 0.95 threshold — v4-audit C1 fix', () => {
    const sig = deriveCloseoutSignal(LOW_CONF_LEDGER);
    expect(sig.status).toBe('blocked');
    expect(sig.reason).toMatch(/confidence 0\.94 below threshold 0\.95/);
    expect(sig.deviations).toEqual([]);
  });

  it('accepts the standalone "Confidence: 0.94" phrasing (skill-template-independent) — v4-audit C1 fix', () => {
    const sig = deriveCloseoutSignal(
      EVIDENCE_TABLE + '\n' + COVERAGE_TABLE + '\nConfidence: 0.94\n'
    );
    expect(sig.status).toBe('blocked');
  });

  it('returns done for confidence exactly at the threshold (0.95) — v4-audit C1 threshold boundary', () => {
    const sig = deriveCloseoutSignal(
      EVIDENCE_TABLE + '\n' + COVERAGE_TABLE + '\nState overall confidence: 0.95\n'
    );
    expect(sig.status).toBe('done');
  });

  /**
   * v5-audit M1 fix: a documented deviation row is recorded in
   * `signal.deviations` but does NOT force `status: 'blocked'`. The
   * only `blocked` trigger is low confidence. This test pins both
   * sides: `status: 'done'` AND the deviation captured.
   * A partial implementation that returns `{ status: 'blocked',
   * reason: 'deviation in evidence row: skip' }` (the previous
   * over-strict rule) fails this test.
   */
  it('returns done WITH deviation recorded when a deviation row has a non-trivial value — v5-audit M1 fix', () => {
    const ledger = EVIDENCE_TABLE.replace('| pass | none |', '| pass | skip |') +
      '\n' + COVERAGE_TABLE + '\nState overall confidence: 0.95\n';
    const sig = deriveCloseoutSignal(ledger);
    expect(sig.status).toBe('done');
    expect(sig.deviations).toEqual(['skip']);
  });

  it('records multiple deviation rows in the order they appear in the evidence table — v5-audit M1 fix', () => {
    const multiRowEvidence =
      '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
      '| --- | --- | --- | --- | --- |\n' +
      '| Step 1 | src/x.ts | pnpm test | pass | none |\n' +
      '| Step 2 | src/y.ts | pnpm test | pass | skip |\n' +
      '| Step 3 | src/z.ts | pnpm test | pass | manual review needed |\n';
    const sig = deriveCloseoutSignal(
      multiRowEvidence + '\n' + COVERAGE_TABLE + '\nState overall confidence: 0.95\n'
    );
    expect(sig.status).toBe('done');
    expect(sig.deviations).toEqual(['skip', 'manual review needed']);
  });

  it('treats trivial deviation values (none / - / n/a, case-insensitive) as done with empty deviations', () => {
    for (const trivial of ['none', 'None', 'NONE', '-', 'n/a', 'N/A']) {
      const ledger = EVIDENCE_TABLE.replace('| pass | none |', `| pass | ${trivial} |`) +
        '\n' + COVERAGE_TABLE + '\nState overall confidence: 0.95\n';
      const sig = deriveCloseoutSignal(ledger);
      expect(sig.status).toBe('done');
      expect(sig.deviations).toEqual([]);
    }
  });

  /**
   * v7-audit C1 fix: the evidence-table capture regex must recognise
   * end of input as a valid table boundary, not just a trailing blank
   * line. JavaScript RegExp does not support `\Z` as an end-of-string
   * anchor (it is a literal `Z`), so the original
   * `(?=\n\s*\n|\Z)` lookahead failed silently at EOF — a ledger
   * whose evidence table is the last block in the file (no trailing
   * blank line) would NOT match, and the function would see an empty
   * match → zero deviations, regardless of what the table actually
   * says. The fix uses `(?=\n\s*\n|(?![\s\S]))` — `(?![\s\S])` is
   * the standard JavaScript idiom for "end of input" (negative
   * lookahead for any character; succeeds only when there is no
   * next character). A partial implementation that keeps the
   * unsupported `\Z` anchor fails this test: the deviation row at
   * the end of the table would be silently dropped.
   */
  it('parses the evidence table at end of ledger without requiring a trailing blank line — v7-audit C1 fix', () => {
    // Ledger shape: evidence table is the last block, no trailing
    // blank line before EOF. The high-confidence + non-trivial
    // deviation row MUST be captured into `signal.deviations` —
    // the v5-audit M1 contract — AND the status MUST be `done` (not
    // `blocked`). A broken `\Z` anchor would cause the regex to miss
    // the table entirely, deviations would be `[]`, and the function
    // would still return `{ status: 'done', deviations: [] }` — but
    // the deviation would be silently dropped, which is the bug.
    const ledger =
      '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
      '| --- | --- | --- | --- | --- |\n' +
      '| Step 1 | src/x.ts | pnpm test | pass | none |\n' +
      '| Step 2 | src/y.ts | pnpm test | pass | skip |\n' +
      '\n' +
      'State overall confidence: 0.95';
    const sig = deriveCloseoutSignal(ledger);
    // The v5-audit M1 contract: deviation recorded, status is `done`.
    expect(sig.status).toBe('done');
    // The v7-audit C1 contract: the deviation IS captured (the table
    // was actually matched, not silently dropped at EOF). This is
    // the assertion that fails if the `\Z` bug is reintroduced.
    expect(sig.deviations).toEqual(['skip']);
  });

  it('returns done for a ledger with no evidence table (e.g. only coverage + confidence) — signal is best-effort, not the artifact gate', () => {
    const sig = deriveCloseoutSignal(COVERAGE_TABLE + '\nState overall confidence: 0.95\n');
    expect(sig.status).toBe('done');
  });

  it('exports BLOCKED_CONFIDENCE_THRESHOLD = 0.95 as the contract boundary — v4-audit C1 fix', () => {
    expect(BLOCKED_CONFIDENCE_THRESHOLD).toBe(0.95);
  });
});

describe('writePlanCloseout', () => {
  const tempDir = join(process.cwd(), 'temp-plan-closeout');

  beforeEach(() => {
    createTempDir('temp-plan-closeout');
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('appends a new ### entry to an existing ## Change Log section (preserves pre-existing entries)', () => {
    const planPath = join(tempDir, 'docs/dev/plan.md');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(planPath,
      '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n' +
      '# Plan body\n\n## Change Log\n\n### Pre-batch baseline\n- Old entry.\n');

    const result = writePlanCloseout({
      planPath,
      version: 1,
      agent: 'fake',
      signal: { status: 'done', deviations: [] },
      timestamp: '2026-06-30T00:00:00.000Z'
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('done');
      expect(result.changeLogCreated).toBe(false);
      expect(result.changeLogAppended).toBe(true);
    }
    const updated = readFileSync(planPath, 'utf-8');
    expect(updated).toMatch(/Pre-batch baseline/);
    expect(updated).toMatch(/### Implementation v1-fake 2026-06-30T00:00:00\.000Z/);
    expect(updated).toMatch(/^status:\s*done\s*$/m);
  });

  /**
   * v7-audit C1 fix: when `## Change Log` is the LAST section in the
   * plan file (i.e. the section boundary is end-of-input, not the
   * start of another `## ` heading), the append regex MUST still
   * match. JavaScript RegExp does not support `\Z` as an end-of-
   * string anchor, so the original `(?=\n## |\Z)` lookahead failed
   * silently at EOF — `body.replace(...)` would no-op and the new
   * `### Implementation v{n}-{agent}` entry would never be written.
   * The fix uses `(?=\n## |$)` (no `m` flag, so `$` is end of input).
   * A partial implementation that keeps the unsupported `\Z` anchor
   * fails this test: `body.replace` returns the original string, the
   * new entry is missing, and the status update is the only change
   * visible on disk.
   */
  it('appends a new ### entry when ## Change Log is the last section in the file (EOF boundary — v7-audit C1 fix)', () => {
    const planPath = join(tempDir, 'docs/dev/plan.md');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    // Fixture: `## Change Log` is the last section. No following
    // `## ` heading exists, so the append regex MUST recognise EOF
    // (via the `$` anchor, NOT the unsupported `\Z`) as the section
    // boundary. The pre-existing `### Pre-batch baseline` entry is
    // preserved (append-not-prepend, the v4-audit M2 contract).
    writeFileSync(planPath,
      '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n' +
      '# Plan body\n\n## Change Log\n\n### Pre-batch baseline\n- Old entry.\n'
    );

    const result = writePlanCloseout({
      planPath,
      version: 1,
      agent: 'fake',
      signal: { status: 'done', deviations: [] },
      timestamp: '2026-06-30T00:00:00.000Z'
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('done');
      expect(result.changeLogCreated).toBe(false);
      expect(result.changeLogAppended).toBe(true);
    }
    const updated = readFileSync(planPath, 'utf-8');
    // Pre-existing entry is preserved (append, not prepend).
    expect(updated).toMatch(/Pre-batch baseline/);
    // New entry is appended — this is the assertion that fails if
    // the `\Z` bug is reintroduced (the regex would no-op at EOF and
    // the new entry would never be written).
    expect(updated).toMatch(/### Implementation v1-fake 2026-06-30T00:00:00\.000Z/);
    // Append order: the pre-existing entry appears BEFORE the new
    // entry — the v4-audit M2 contract.
    expect(updated).toMatch(/Pre-batch baseline[\s\S]+### Implementation v1-fake 2026-06-30T00:00:00\.000Z/);
    // Front matter updated.
    expect(updated).toMatch(/^status:\s*done\s*$/m);
  });

  it('creates ## Change Log section + appends entry when the section is missing (the real docs/dev/plan.md shape)', () => {
    const planPath = join(tempDir, 'docs/dev/plan.md');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(planPath,
      '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n' +
      '# Plan body\n\n## Step list\n\n### Step 1\n');

    const result = writePlanCloseout({
      planPath,
      version: 1,
      agent: 'fake',
      signal: { status: 'done', deviations: [] },
      timestamp: '2026-06-30T00:00:00.000Z'
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('done');
      expect(result.changeLogCreated).toBe(true);
      expect(result.changeLogAppended).toBe(true);
    }
    const updated = readFileSync(planPath, 'utf-8');
    expect(updated).toMatch(/^## Change Log\s*$/m);
    expect(updated).toMatch(/## Change Log\s*\n\n### Implementation v1-fake 2026-06-30T00:00:00\.000Z/);
    expect(updated).toContain('## Step list');   // pre-existing body preserved
    expect(updated).toMatch(/^status:\s*done\s*$/m);
  });

  it('writes status: blocked + records the blocked reason in the change-log entry', () => {
    const planPath = join(tempDir, 'docs/dev/plan.md');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(planPath, '---\nstatus: ready\n---\n\n# Plan body\n');

    const result = writePlanCloseout({
      planPath,
      version: 2,
      agent: 'opencode',
      signal: { status: 'blocked', reason: 'confidence 0.94 below threshold 0.95', deviations: [] },
      timestamp: '2026-06-30T00:00:00.000Z'
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe('blocked');
    }
    const updated = readFileSync(planPath, 'utf-8');
    expect(updated).toMatch(/^status:\s*blocked\s*$/m);
    expect(updated).toMatch(/- status: blocked \(confidence 0\.94 below threshold 0\.95\)/);
  });

  /**
   * v5-audit M1 fix: a high-confidence `done` closeout that records
   * deviations in the signal MUST render a SEPARATE `- deviations:`
   * line in the change log entry, NOT fold the deviations into the
   * status reason. The deviations are evidence; the status reflects
   * only the confidence gate. A partial implementation that omits
   * the deviations line (or that mixes deviations into the status
   * reason) fails this test.
   */
  it('writes a separate - deviations: line for a done closeout with recorded deviations — v5-audit M1 fix', () => {
    const planPath = join(tempDir, 'docs/dev/plan.md');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(planPath, '---\nstatus: ready\n---\n\n# Plan body\n');

    const result = writePlanCloseout({
      planPath,
      version: 1,
      agent: 'fake',
      signal: { status: 'done', deviations: ['skip', 'manual review needed'] },
      timestamp: '2026-06-30T00:00:00.000Z'
    });

    expect(result.ok).toBe(true);
    const updated = readFileSync(planPath, 'utf-8');
    // The status line carries the closeout status, NOT the deviations.
    expect(updated).toMatch(/- status: done\n/);
    // The deviations are on a separate, machine-parseable line.
    expect(updated).toMatch(/- deviations: skip; manual review needed\n/);
    // The deviations do NOT appear inside the status reason (no
    // "deviation in evidence row" reason text for a done closeout).
    expect(updated).not.toMatch(/- status: done \(deviation/);
  });

  /**
   * v5-audit M1 fix: a `done` closeout with no recorded deviations
   * omits the `- deviations:` line entirely (no noise in the change
   * log when nothing deviates). The status line is the only entry
   * body line in that case.
   */
  it('omits the deviations line for a done closeout with empty deviations — v5-audit M1 fix', () => {
    const planPath = join(tempDir, 'docs/dev/plan.md');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(planPath, '---\nstatus: ready\n---\n\n# Plan body\n');

    const result = writePlanCloseout({
      planPath,
      version: 1,
      agent: 'fake',
      signal: { status: 'done', deviations: [] },
      timestamp: '2026-06-30T00:00:00.000Z'
    });

    expect(result.ok).toBe(true);
    const updated = readFileSync(planPath, 'utf-8');
    expect(updated).toMatch(/- status: done\n/);
    expect(updated).not.toMatch(/- deviations:/);
  });

  it('returns { ok: false, error } when the plan file does not exist', () => {
    const result = writePlanCloseout({
      planPath: join(tempDir, 'docs/dev/does-not-exist.md'),
      version: 1,
      agent: 'fake',
      signal: { status: 'done', deviations: [] }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/plan file not found/);
    }
  });

  it('returns { ok: false, error } when the plan has no front matter', () => {
    const planPath = join(tempDir, 'docs/dev/plan.md');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(planPath, '# Plan with no front matter\n');

    const result = writePlanCloseout({
      planPath,
      version: 1,
      agent: 'fake',
      signal: { status: 'done', deviations: [] }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no front matter/);
    }
  });

  it('returns { ok: false, error } when the plan front matter has no status field', () => {
    const planPath = join(tempDir, 'docs/dev/plan.md');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(planPath, '---\nconfidence: 0.96\nowners: x\n---\n\n# Plan\n');

    const result = writePlanCloseout({
      planPath,
      version: 1,
      agent: 'fake',
      signal: { status: 'done', deviations: [] }
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no `status:` field/);
    }
  });
});
