# Batch 3 — Artifact Outcomes and Recovery

**Status:** ready for plan audit

**Confidence:** 0.97

**Source:** `docs/dev/archived/follow-up.md`, Batch 3

## Objective

Make artifact outcomes precise and recoverable without weakening the
fail-closed workflow contract:

- a structurally valid implementation ledger with unresolved gates is
  `blocked`, not `artifact.unknown`;
- malformed or internally inconsistent artifacts remain `unknown`;
- ledger failures identify the exact components and rows involved; and
- an interactive operator may explicitly correct a qualified decision line
  without another provider invocation.

The implementation must remain manifest-driven. It must not branch on the
literal binding names `implement`, `plan`, or `review`, on filename families, or
on the default decision tokens `APPROVED` and `REJECTED`.

## Architectural decisions

### One canonical output-classification path

`src/artifact-contract.ts` will own the shared output-classification result used
both immediately after a provider run and during artifact-index reconstruction.
Remove the duplicate contract interpretation from
`src/loops/binding-engine.ts`; live execution and restart scans must not derive
different outcomes from the same body and manifest output specification.

The canonical classifier is a **body + output-spec function** — for example
`classifyOutputBody(output, body, validator)` — that performs *no* provenance
check and reads only the raw artifact body plus the configured `OutputSpec`.
This decoupling is mandatory: the live path (`src/loops/binding-engine.ts`)
classifies the raw provider `body` *before* `writeArtifactWithMeta` stamps
provenance, so any classifier that reads a file path and demands v1 front matter
(the current `classifyArtifact`, which calls `parseArtifactMetaClassified`
first) would return `unknown` for every live artifact. Provenance validity stays
a separate, earlier gate that the canonical classifier must not fold in: the
restart path keeps its existing `parseArtifactMetaClassified` provenance gate in
`src/artifact-index.ts`, and the live path relies on the post-classification
`writeArtifactWithMeta` stamping. Both call sites must invoke the same body-based
classifier — the live site (today `validateOutput` in
`src/loops/binding-engine.ts`) and the restart site (`classifyArtifact` in
`src/artifact-index.ts`, reached only after the provenance gate). The existing
file-path `classifyArtifact` is re-implemented on top of the body-based
classifier; `parseArtifactMetaClassified` is never embedded inside it.

A classification result carries:

- `kind`: the normalized outcome;
- bounded, structured diagnostics when classification is blocked or unknown;
  and
- decision-correction context only when a decision artifact has one safely
  identifiable decision line.

Named `required-artifact` validators become outcome-aware classifiers. A
required artifact with no validator retains its current `valid | unknown`
behavior. The configured `implement-ledger` validator may return
`valid | blocked | unknown`; this does not add a new manifest contract or a
special implementation execution path.

### Validity and success remain separate

`contractValid` means the artifact is structurally classifiable, not that its
workflow outcome succeeded. Therefore:

- a passing ledger is `contractValid: true`, normalized as `valid`;
- a blocked ledger is `contractValid: true`, normalized as `blocked`; and
- a malformed ledger is unclassified with `contractValid: false`, normalized
  as `unknown`.

Only `valid` required-artifact evidence may unlock a pipeline successor.
`blocked` remains durable terminal evidence for the task but never becomes
completion evidence.

### Decision correction is explicit operator authority

Exact configured decision tokens remain the only automatically accepted
decision syntax. A qualified line such as `REJECTED (narrow)` remains
`unknown` until an operator selects a canonical configured token.

The parser and binding engine must not prompt. The interactive command layer
provides an optional correction callback to the engine. The callback is
installed only for an interactive, non-plain run; explicit CLI runs and
`--plain` runs fail closed with actionable diagnostics.

Before applying an approved correction, build the corrected body in memory by
changing only the first substantive decision line in the configured decision
section, then validate that corrected body through the ordinary classifier
*before* touching the active artifact. Only on a valid reclassification does the
engine move the untouched provider output to the existing `docs/dev/archived/`
quarantine area with reason `decision-correction`, write the corrected body to
the active path, and add normal provenance. This ordering is mandatory because
`quarantineArtifact` performs an irreversible `renameSync`: validating the
corrected body *first* means the irreversible archive never runs until the
replacement is known valid, so the active path always holds either the untouched
original (on rewrite/revalidation failure) or the provenance-stamped corrected
body (on success) — never an invalid rewritten body with the original already
moved. Record the correction and archived evidence path in provenance and emit a
structured correction event. If rewriting or revalidation fails, leave the
original untouched at the active path as the recoverable evidence and stop; if
the archive or corrected-body write fails after a valid reclassification, the
archived original (when the rename completed) is the canonical recoverable
evidence and the active path is left invalid or empty. In every failure case no
provenance-stamped active artifact exists and the run does not advance.

Choosing not to correct archives the unchanged invalid output and stops. It
does not provenance-stamp the invalid body or invoke the provider again.

## Feature 1 — Outcome-aware implementation ledger

### Design

Refactor `validateImplementLedger` into a structural parser plus outcome
classifier.

The ledger contract is:

- **valid:** both required tables exist, every row has the expected non-empty
  cells, every status is an allowed passing value, and confidence is a number
  from `0` through `1` at or above `0.95`;
- **blocked:** the structure is complete and every status is recognized, but
  at least one evidence or coverage row has an allowed unresolved value, or
  confidence is below `0.95`; and
- **unknown:** a table, header, separator, row, required cell, or confidence
  declaration is missing or malformed; confidence is outside `0..1`; or a
  status value is not in the declared passing/unresolved vocabulary.

Continue accepting the existing passing vocabulary. Add a small explicit
unresolved vocabulary covering the skill's documented output, including `❌`,
`blocked`, `failed`, `pending`, and `not run`, with case and surrounding-space
normalization. Do not infer blocked state from free prose such as
`Status: blocked`.

Diagnostics use stable codes and bounded display messages. They must
distinguish at least:

- missing or malformed evidence table;
- missing or malformed requirement-coverage table;
- missing, malformed, out-of-range, or below-threshold confidence;
- incomplete rows or invalid status cells; and
- unresolved evidence or coverage rows.

Row diagnostics identify the table and the first-column row label, truncate
labels to a safe display length, and cap the number emitted while reporting how
many additional issues were omitted. They must not echo arbitrary full
provider output.

### File impact

- `src/implement-ledger.ts`
  - introduce the typed ledger outcome and diagnostic model;
  - separate table structure from row-status classification;
  - parse and enforce the confidence range and `0.95` completion threshold.
- `src/artifact-contract.ts`
  - define the canonical contract-classification result;
  - dispatch the configured named validator and preserve its
    `valid | blocked | unknown` result.
- `src/loops/binding-engine.ts`
  - use the canonical classifier instead of local `validateOutput`;
  - provenance-stamp a classifiable blocked artifact;
  - emit blocked diagnostics and terminate the task as `blocked`.
- `src/artifact-index.ts`, `src/state.ts`, and
  `src/pipeline-stage-state.ts`
  - reconstruct a blocked required artifact as classified blocked evidence using
    the existing field that `artifactRecordFromStep` already maps to
    `normalizedResult: 'blocked'`: for a blocked implement ledger the restart
    scan sets `step.contractValid = true`, `step.unclassified = false`, and
    `step.completionOutcome = 'blocked'`. Do **not** introduce a new carrier
    field — `artifactRecordFromStep` only consults `decision`, `completionOutcome`,
    and `contractValid`, so a new field would be silently dropped;
  - exclude it from successor completion evidence without marking it
    unclassified. Today `src/artifact-index.ts` marks any `contractValid === false`
    step as unclassified, so the blocked ledger must keep `contractValid = true`
    precisely to avoid that path, and `completionEvidenceForStage` already
    accepts only `normalizedResult === 'valid'` for a required-artifact task, so
    a blocked ledger naturally resolves to neither completion evidence nor an
    eligible continuation parent.
- `src/run-event.ts`, `src/plain-event-renderer.ts`, and the status/final-summary
  presentation
  - show the bounded diagnostics on the verified blocked artifact and terminal
    outcome rather than `implementation evidence ledger validator failed`.
- `tests/implement-ledger.test.ts` and `tests/adapters-contract.test.ts`
  - the existing `validateImplementLedger(...).toEqual({ valid,
    evidenceTableValid, coverageTableValid, confidenceValid })` shape
    assertions (≈7 sites in `tests/implement-ledger.test.ts`) migrate to the new
    typed outcome/diagnostic model;
  - the `isCompleteImplementLedger` assertions for `skip` / `not run` /
    `untested` status cells flip from "invalid" (`toBe(false)`) to "`blocked`
    with an unresolved-row diagnostic" — under the new contract those ledgers
    are structurally complete and recognized, just unresolved, so they are
    `blocked`, not malformed;
  - `tests/adapters-contract.test.ts:389` continues to assert a clean body (no
    front matter) is a complete ledger, and additionally covers the blocked
    distinction so the public validator shape change does not silently pass an
    out-of-date suite.

No manifest schema change is required. The existing explicit pairing
`contract: required-artifact` plus `validator: implement-ledger` selects this
behavior.

### Verification

- Unit-test passing, blocked, and malformed ledgers independently.
- Cover missing tables, bad column counts, empty cells, known unresolved
  statuses, unknown statuses, confidence below `0.95`, and confidence outside
  `0..1`.
- Prove row labels and omitted-issue counts are bounded and deterministic.
- Run a task through the real binding engine for each outcome:
  - valid emits `artifact.verified result=valid`, completes, and can unlock its
    configured successor;
  - blocked emits a parsed/verified blocked result, `stage.blocked`, and a
    terminal blocked outcome with exact diagnostics;
  - unknown emits `artifact.unknown` with structural diagnostics and does not
    advance.
- Prove the canonical classifier is provenance-decoupled: for the same body,
  assert it returns the identical `kind` and diagnostics with and without v1
  front matter prepended (this is the regression guard for F1 — a
  provenance-coupled classifier would misclassify the bare live body).
- Rescan each persisted fixture and prove live and reconstructed
  `contractValid`, normalized result, status rendering, and pipeline
  eligibility agree.
- Prove a blocked task is not offered as resumable provider work and gains no
  implicit repair loop.
- Prove a blocked implement ledger never unlocks a successor: assert it is
  absent from `completionEvidenceForStage` for the configured successor review
  stage, and assert a stage-continuation child anchored to it fails
  `validateContinuationParent` ("not completion-capable") — both must hold while
  the blocked artifact remains classified (not `unclassified`).

## Feature 2 — Operator-confirmed decision correction

### Design

Keep `parseDecisionContent` strict. Add a separate pure diagnostic function
that locates the configured decision section and reports:

- the first substantive decision line;
- the configured accepted and retry tokens;
- whether the structure is safe for a one-line replacement; and
- an optional suggested token.

A correction is structurally available only when there is exactly one
configured decision section and exactly one identifiable substantive decision
line to replace. Missing or duplicate sections and multiple candidate decision
lines remain non-recoverable unknown output.

A suggestion is allowed only when the normalized invalid line starts with
exactly one configured token followed by whitespace or punctuation. Token
substrings, token mentions later in prose, negated or historical statements,
and lines containing both configured tokens receive no suggestion. No
suggestion is ever auto-selected as the operator's answer.

The interactive prompt displays:

- artifact path and the raw invalid line;
- the two configured canonical choices;
- the optional suggestion as presentation only; and
- an option to archive the unchanged invalid output and stop.

After confirmation, the binding engine archives the original, applies the
single-line correction, reclassifies, writes normal provenance, emits
`artifact.decision-corrected`, and follows the existing accepted or retry
transition. The provider-call count and session history do not change.

Add optional correction provenance containing the original line, selected
canonical token, correction timestamp, and project-relative archived evidence
path. Preserve this field when parsing and rendering artifact metadata, but do
not change pipeline/chain identity or fingerprint rules.

For non-interactive, plain, structurally ambiguous, or declined cases, emit the
invalid line, expected configured tokens, and the archived evidence path when
available, then stop as `unknown`.

### File impact

- `src/artifact-contract.ts`
  - add the pure correction diagnostic and safe one-line replacement
    primitives without relaxing normal decision parsing.
- `src/interactive.ts`
  - add the operator correction prompt using configured tokens.
- `src/commands/smash.ts`, `src/loop.ts`, and
  `src/loops/runtime.ts`
  - install the correction callback only at the interactive command boundary,
    gated on `setup.isInteractive && !options.plain` (where `isInteractive` is
    `!options.loop && !options.task && !options.pipeline` and `--plain` is the
    renderer-only flag from `src/cli.ts`), and carry its typed result through the
    shared executor options. The binding engine never receives a `plain` flag:
    it treats "no correction callback" as fail-closed, so the `--plain`
    guarantee falls out of callback *absence* rather than engine-level branching
    or a new `BindingEngineOptions` field.
- `src/loops/binding-engine.ts`
  - request correction only for a recoverable decision-classification result;
  - archive, rewrite, revalidate, provenance-stamp, and continue atomically at
    the existing pre-persistence boundary.
- `src/interrupted-artifact.ts`
  - reuse the generic quarantine operation with the distinct
    `decision-correction` reason; do not introduce hidden state.
- `src/provenance.ts`
  - add the decision-correction field to the `ArtifactMeta` interface **and** to
    the `optionalKeys` array in `parseArtifactMeta`; `parseArtifactMeta` only
    preserves keys listed in `optionalKeys`, so a field omitted from that list is
    silently dropped on reparse and the correction record would be written once
    by `writeArtifactWithMeta` but vanish on the next restart scan. Round-trip it
    losslessly (original line, selected canonical token, correction timestamp,
    project-relative archived evidence path) without changing pipeline/chain
    identity or fingerprint rules.
- `src/run-event.ts`, `src/plain-event-renderer.ts`, and panel/final-summary
  rendering
  - add the `artifact.decision-corrected` event to the `RunEvent` union **and**
    handle it in the exhaustive `fmtEvent` / `renderRunEvent` switch (an
    unhandled union member is either a TypeScript exhaustiveness error or a
    silently unrendered event in plain mode), plus the precise fail-closed
    diagnostics.

### Verification

- Exact custom accepted and retry tokens still classify without interaction.
- `REJECTED (narrow)` is unknown before confirmation and safely suggests the
  configured retry token.
- Confirm each canonical choice and prove:
  - only the decision line changes;
  - the untouched original is archived;
  - correction provenance and the event identify the original and corrected
    values;
  - ordinary validation runs again;
  - the correct accepted/retry transition occurs; and
  - no second provider invocation occurs.
- Prove no suggestion for negated, historical, embedded-substring, both-token,
  or arbitrary prose cases.
- Prove duplicate sections and multiple candidate lines cannot be rewritten.
- Prove declining archives the unchanged raw output, leaves no classified
  active artifact, and stops unknown.
- Inject archive, rewrite, and revalidation failures and prove the run remains
  fail-closed with recoverable raw evidence. Specifically, after an injected
  revalidation failure assert the untouched original is still intact at the
  active path (archive/rename did not run) and no provenance-stamped active
  artifact exists; after an injected archive failure following a valid
  reclassification assert the archived original is intact and the active path
  holds no classified artifact.
- Re-scan a corrected artifact from disk and assert the correction provenance
  (original line, selected canonical token, archived evidence path) survives the
  `parseArtifactMeta` round-trip — this is the guard for F6, since a field missing
  from `optionalKeys` would be silently dropped.
- Render the `artifact.decision-corrected` event through both the panel and the
  plain (`renderRunEvent`) renderer so the correction is observable in each
  output mode (F7 exhaustiveness guard).
- Prove explicit-binding, non-interactive, and `--plain` executions never open
  the correction prompt.
- Cover custom manifest headings/tokens and at least two differently named loop
  bindings to prevent workflow-name coupling.

## Delivery order

1. Centralize contract results and add ledger diagnostics without changing
   behavior. The current `validateImplementLedger` return shape and all existing
   assertions stay green in this step.
2. Enable the ledger `blocked` classification across live execution, events,
   indexing, restart reconstruction, and pipeline eligibility. Update
   `tests/implement-ledger.test.ts` and `tests/adapters-contract.test.ts` in
   this same step: migrate the `toEqual` shape assertions to the new
   outcome/diagnostic model and flip the `skip` / `not run` / `untested` cases
   from invalid to `blocked` with an unresolved-row diagnostic. Step 1 keeps the
   old shape, so the suite is green until this step changes both the contract
   and its assertions together.
3. Add pure decision diagnostics and replacement tests.
4. Add the interactive correction callback, quarantine evidence, provenance,
   and event presentation.
5. Run the focused suites, then the full deterministic gate:

   ```text
   pnpm typecheck
   pnpm test
   pnpm build
   ```

6. Manually verify one interactive qualified-decision correction, one declined
   correction, and one blocked implementation ledger through `bin/orc.js`
   after the build.

Each step must leave all prior tests passing and be independently reviewable.

## Documentation impact

After implementation, synchronize:

- `AGENTS.md` with the outcome-aware named-validator and explicit correction
  boundaries;
- `README.md` with the operator-visible blocked and correction behavior; and
- `docs/architecture/overview.md` with the shared live/restart classifier and
  command-owned interaction seam.

Do not remove the Batch 3 follow-up checklist until implementation and review
are approved.

## Non-goals

- Relaxing exact decision-token parsing or silently inferring decisions.
- Automatically choosing a correction.
- Editing findings or any provider text outside the selected decision line.
- Adding a general artifact editor or repair pipeline.
- Adding an implementation retry loop or resuming blocked task sessions.
- Allowing blocked or unknown artifacts to unlock pipeline successors.
- Adding new manifest workflow names, hardcoded stage transitions, or a second
  execution engine.
- Changing provider adapters, session continuity, effort selection, ownership,
  timeout, interruption, signal-gate, or supervisor contracts.
- Implementing Batch 4 provider telemetry or Batch 5 configured commit tasks.

## Acceptance gates

- [ ] Live execution and restart reconstruction use one canonical classifier.
- [ ] Passing, blocked, and unknown implementation ledgers remain distinct
      across events, artifacts, status, and pipeline eligibility.
- [ ] Blocked ledger diagnostics identify exact components and rows and remain
      bounded.
- [ ] Qualified decisions require explicit operator confirmation and retain
      original evidence.
- [ ] Declined, ambiguous, plain, and non-interactive correction paths fail
      closed.
- [ ] No correction path invokes the provider twice or changes chain identity.
- [ ] Focused tests, full deterministic tests, typecheck, build, and the three
      manual smoke cases pass.
