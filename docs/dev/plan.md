# Plan — Status panel and timeline (follow-up batch 1)

**Confidence: 0.96**

This plan implements **Batch 1 — Status panel and timeline** from
`docs/dev/archived/follow-up.md` (five checklist items). It is deliberately
limited to live-panel/panel-context presentation and the pure derivation that
feeds it. Batches 2–6 are out of scope.

## Status

Implementation complete. See `docs/dev/review-followup-v2-opencode.md` for follow-up closure status.

## Objective

Make the live status panel honest and complete:

1. the selected effort is shown consistently for the active invocation;
2. single tasks never render approval-loop iteration vocabulary;
3. **Run configuration** is an aligned table;
4. the timeline shows all discovered workflow artifacts with relevance
   emphasis; and
5. the timeline carries compact artifact/parent/input/result identity columns.

## Scope

- `src/status-panel.ts`, `src/plain-render.ts`, `src/status.ts`,
  `src/terminal-accent.ts` presentation and panel-contract changes;
- `src/loops/execution.ts` live-region data sourcing (in-flight fields and
  per-step global snapshot);
- one new pure module, `src/timeline-rows.ts`, owning global timeline row
  derivation and relevance classification;
- deterministic unit, panel, and e2e regression tests.

## Non-goals

- No provider, adapter, runner-resolution, continuity, ownership,
  interruption, quarantine, or supervisor-surface changes.
- No workflow-state changes: relevance dimming never affects candidate
  eligibility, recovery, chain reduction, artifact ordering, artifact
  classification, or which runner is invoked.
- No Batch 2+ work: continuation runner defaults/recommendation labels,
  effort-only selection, requested-vs-effective effort telemetry, decision
  correction, post-approval tasks/commit skill, provider progress telemetry,
  blocked-ledger outcomes.
- No new read-only `orc status` timeline UI (parity is structural — see D6).
- Plain-mode event stream and plain panel formats stay line-oriented; the only
  deliberate plain-output change is the task execution vocabulary (D3/D4),
  shipped with its own tests.
- Compact identity suffixes are display-only and are never used for
  comparison, selection, parent lookup, or authorization.
- Do not branch on literal binding IDs (`implement`, `review`, …) anywhere in
  the new code; all behavior keys off `bindingKind`, provenance, and manifest
  data.

## Current behavior (verified root causes)

- **Effort drop.** `src/loops/execution.ts` builds `liveInFlight` without
  `runner.effort`, although `PanelContext.inFlight.effort` already exists and
  `stepStarted`, `setStepCtx`, provenance, and `adapter.run` all receive it.
  `src/status-panel.ts` then renders its fallback for the active row. The
  fallback label also differs: run configuration and plain/detailed views use
  `provider default`; timeline rows use `default`.
- **Loop vocabulary on tasks.** `src/commands/smash.ts:358` initializes
  `maxIterations = 4` for every binding; a task never increments the evaluator
  counter, so `status-panel.ts:10-14`, `plain-render.ts:52-55`, and the
  `execution.ts:332` note line render `Round 0/4`-style text. The
  `promptMaxIterations` call is already gated to loops (`smash.ts:359`) but has
  no regression proof across the four task launch paths.
- **Run configuration.** Rendered as padded text lines
  (`status-panel.ts:35-41`).
- **Timeline scope.** The live panel renders only the in-memory `deps.steps`
  of the current run (`binding-engine.ts:98`); the surrounding discovered
  project history is invisible during execution.
- **Identity columns.** `Step` already carries `artifactIdentity`,
  `parentArtifactIdentity`, `inputFingerprint`, and `resultFingerprint`, and
  `execution.ts:259-292` computes the pre-spawn draft identity recorded in the
  interrupted marker — none of it is rendered.

## Normative decisions

### D1 — The live in-flight row carries the resolved effort (item 1)

**Design.** Add `effort: runner.effort` to the `liveInFlight` literal in
`src/loops/execution.ts`. No type change: `PanelContext.inFlight.effort`
already exists. The durable interrupted marker already persists effort through
`setStepCtx` and `state.ts:122`; this release adds regression coverage proving
it, without engine changes.

**File impact.** `src/loops/execution.ts`.

**Verification.**

- An active runner selected with `max` displays `max` in both Run
  configuration and the Timeline active row (execution-panel seam: capture the
  `attachLiveRegion` supplier and render it).
- Low/medium/high/xhigh/max/ultra or any configured token is carried through
  without display-specific filtering.
- The completed timeline row agrees with the active row and with artifact
  provenance.

### D2 — One absent-effort vocabulary: `provider default` (item 1)

**Design.** Every panel timeline row (completed and in-flight) renders an
absent effort as `provider default`, matching run configuration, plain output,
and the detailed snapshot. Persisted provenance is unchanged: the field
remains omitted when absent; an absent effort means *provider default* and is
never confused with a lost selected value.

**File impact.** `src/status-panel.ts` (timeline row fallbacks only).

**Verification.**

- `provider default` appears only when the resolved runner has no effort.
- The interrupted row retains the selected effort through its durable marker
  and never falls back to `provider default` for a run that had one.

### D3 — Task executions use task vocabulary; loop budget vocabulary is loop-only (item 2)

**Design.** `PanelContext` gains a required `bindingKind: 'loop' | 'task'`
field, threaded through `buildPanelContext` as a required parameter (inserted
among the required parameters, before the defaulted ones, so every caller
must supply it). `src/loops/execution.ts:185` is the only production caller
and passes `deps.bindingKind`. Renderers branch on `bindingKind`:

- loops keep `Iteration: Round n/max - provider calls N`;
- tasks render `Execution: Single task - provider calls N` (with the provider
  call count when available; `Single task` otherwise). The production
  interactive panel branch is `src/status-panel.ts`. `src/plain-render.ts`
  is updated for test consistency and future snapshots, but it has **no
  production caller today** (verified: production plain mode is
  `createPlainCliOutput` in `src/cli-output.ts`, whose `renderPanel` is a
  no-op at `:290` and `attachLiveRegion` is a no-op at `:299`; plain output
  is driven by `renderRunEvent` over the event stream). The real
  plain-output loop-vocabulary vector is the note line at
  `src/loops/execution.ts:332` (`Round n/max - provider calls N` today),
  which branches identically to `Single task - provider calls N` for tasks.

No task retry/iteration semantics are invented to reuse the loop display;
adapter-internal CLI retry is not an orc-smash evaluator iteration. Task
completion, failure, timeout, interruption, and restart remain
single-invocation states in `binding-engine.ts` (unchanged).

**File impact.** `src/status.ts` (`PanelContext` plus the required
`buildPanelContext` parameter), `src/status-panel.ts`, `src/plain-render.ts`
(test/future only), `src/loops/execution.ts`, and **every**
`PanelContext`/`buildPanelContext` construction site in tests. Verified by
grep + reading each fixture, the full set is:

*Literal/helper sites that must add `bindingKind`.* These break the Release 1
`pnpm typecheck` if left unupdated, because they build a full `PanelContext`
without the now-required field:

- `tests/status.test.ts:6` — raw `renderStatusPanel({...})` literal;
- `tests/cli-output.test.ts:220` — `output.renderPanel({...})` literal
  (`renderPanel(context: PanelContext)`);
- `tests/terminal-accent.test.ts:21` — `makeContext(overrides)` helper whose
  base object must default `bindingKind`;
- `tests/cli-output-live.test.ts:36` — `makeContext(...)` helper feeding the
  `attachLiveRegion` suppliers (lines 84, 100, 114, 128, …);
- `tests/status-panel.test.ts`, `tests/plain-render.test.ts`,
  `tests/terminal-surfaces.test.ts` — direct `PanelContext` literals;
- `tests/helpers/panel-context.ts` — the shared context helper; and
- `tests/status-core.test.ts:68,75` — the only test that calls
  `buildPanelContext(...)` positionally; both calls gain the new required
  `bindingKind` argument.

*Supplier-driven sites.* These receive `PanelContext` from `execution.ts`, so
`bindingKind` flows in automatically and they do **not** break Release 1, but
their render assertions must be re-validated under D5/D6/D8 (see those
decisions):

- `tests/execution-panel.test.ts` (captures the supplier at `:101` and renders
  at `:131`, `:214`, `:249`);
- `tests/loop-live.test.ts:73`; and
- `tests/lease-expiry.execution.test.ts` (already sets `bindingKind: 'loop'`,
  lowest risk, but it exercises the `executeLoopStep` seam that D6 modifies).

**Verification.**

- Task panels never display `Round`, `0/4`, or any other loop budget, in panel
  and plain rendering.
- The provider-call counter remains visible and begins at the actual count.
- Plan and review approval loops retain their configured evaluator-round
  prompt and `Round n/max` display.
- Task completion, failure, timeout, interruption, and restart stay
  single-invocation states (existing e2e outcomes unchanged).

### D4 — The maximum-evaluation-round prompt stays loop-only on every launch path (item 2)

**Design.** No behavior change to the existing gate at
`src/commands/smash.ts:359` (`isInteractive && selected.kind === 'loop'`).
This decision adds the missing regression proof and forbids re-widening. Do
not add task-side prompting and do not route tasks through loop setup.

**File impact.** Tests only: `tests/smash-action.test.ts` (or
`tests/commands/`) with `interactive.ts` mocked to spy on
`promptMaxIterations`, plus `tests/e2e/smash.test.ts`.

**Verification.**

- Interactive task selection never calls the maximum-evaluation-round prompt,
  proven for: **Start suggested stage** whose successor is a task;
  **Tasks / Execute one-off task**; and a pipeline whose configured first
  stage is a task. Direct `--task` is non-interactive by construction and is
  covered by an e2e asserting no `maximum evaluation rounds` prompt and no
  `Round` text in output.
- A suggested stage resolving to a task remains classified
  `bindingKind: 'task'` (`resolveBindingForSuggested`).
- Loop selections still invoke the prompt exactly once.

### D5 — Run configuration renders as a borderless aligned table (item 3)

**Design.** Replace the padded lines in `src/status-panel.ts` with a
`cli-table3` table (already a dependency, used by the timeline) with columns
in this exact order:

```text
Phase  Skill  Role  Provider  Model  Effort  Session
```

The table consumes the existing `ResolvedRunnerDisplay` values only — the
renderer must not resolve runners, infer effort, or recompute continuity.
Evaluate, repair, and task rows share the one column order. Styling reuses the
timeline table's stripped-border character set so the boxen interior-grid
invariant (≤ 2 `│` per line) keeps holding; `wordWrap` plus explicit
`colWidths` bounded to the panel inner width (reuse the `resolveTerminalWidth`
seam) keep long model/skill names from overflowing the panel border. Effort
renders as the selected level or `provider default`; session renders as
`resume per skill` / `fresh per invocation`. Plain output
(`src/plain-render.ts`) stays line-oriented and is not changed by this
decision.

**File impact.** `src/status-panel.ts`; existing run-configuration assertions
in `tests/execution-panel.test.ts` (and any `renderStatusPanel`/
`renderPlainPanel` snapshot checks) are updated from the padded-line format to
the aligned table as part of this release.

**Verification.**

- Column order and content match `ResolvedRunnerDisplay` for evaluate, repair,
  and task phases.
- Long model and skill names wrap or truncate without corrupting other
  columns, and narrow terminals do not overflow the status-panel border
  (ANSI-stripped line-width assertion with `COLUMNS` forced).
- Provider default effort and fresh/resumed session policy remain explicit.
- Plain output format is byte-stable for the runner section.
- Existing run-configuration assertions in `tests/execution-panel.test.ts`
  and any panel-render snapshots are updated from padded lines to the aligned
  table and re-pass; no assertion is left pointing at the old padded format.

### D6 — One global timeline derivation with typed relevance (item 4)

**Design.** Introduce `src/timeline-rows.ts` as the single pure owner of
global timeline rows and their relevance:

```ts
export type TimelineRelevance =
  'current-chain' | 'current-run' | 'unrelated' | 'unclassified';
export interface TimelineRow { step: Step; relevance: TimelineRelevance; }
export interface TimelineRelevanceContext {
  chainId: string | null;
  pipelineId: string | null;
  pipelineRunId: string | null;
  bindingId: string;
}
export function buildTimelineRows(
  snapshot: GlobalSnapshot,
  context: TimelineRelevanceContext,
): TimelineRow[];
```

Classification precedence (first match wins):

1. `step.unclassified` → `unclassified`;
2. `step.chainId === context.chainId` → `current-chain`;
3. `context.pipelineId && context.pipelineRunId` and both match the step →
   `current-run` (same pipeline run, different chain);
4. otherwise → `unrelated` (includes same-binding artifacts from another run,
  other bindings, other ad-hoc runs, and independent chains).

`PanelContext.timeline` changes type from `Step[]` to `TimelineRow[]`.
`src/loops/execution.ts` calls `scanGlobalSnapshot` **once per provider step**
(before `attachLiveRegion`; never inside the per-tick supplier) and builds the
rows with the active run context (`deps.runContext`, `deps.loopName`). The
supplier closure serves the precomputed rows; only `liveInFlight` fields keep
mutating per tick as today. Row order is the scanner's causal order; the
renderer appends the in-flight row last.

Rendering in `src/status-panel.ts`:

- `current-chain` rows render as today; the `*` latest marker moves to the
  latest `current-chain` row only (no marker when the chain has no persisted
  rows yet);
- `current-run` rows render normally, without the marker;
- `unrelated` rows are dimmed (`chalk.dim` on every cell);
- `unclassified` rows are dimmed warnings: status cell reads `unclassified`
  (warning accent, dimmed) and the result cell carries the harness-generated
  `unclassifiedReason` bounded to ≤ 48 chars with ellipsis — never provider
  output;
- `panelBorderColor` ignores `unrelated`/`unclassified` rows when choosing the
  resting border color;
- **Latest version** derives from the global snapshot, not the possibly empty
  in-memory `deps.steps`: it is
  `max(snapshot.steps.filter(s => s.bindingId === deps.loopName).map(s => s.version), inFlightVersion, 0)`,
  including the in-flight version so a running step is counted. At the
  `execution.ts:194` call site, `latestVersion(deps.steps)` is **replaced** by
  a small pure helper that takes the snapshot, the binding id, and the
  in-flight version (e.g. `latestVersionForBinding(snapshot, deps.loopName, inFlightVersion)`), so the value never again reads the stale in-memory
  list. The existing `status.ts:latestVersion(steps: Step[])` helper is either
  given an overload or removed once its last caller migrates — it must not be
  left pointing at `deps.steps`. This fixes the continuation-time `v0`
  display as a deliberate, called-out correction.

`src/plain-render.ts` adapts to the row type with its per-artifact block
format otherwise unchanged (plus the D3 line). Read-only parity is structural:
`orc status` keeps rendering from
`buildProjectSnapshotView(scanGlobalSnapshot(...))`, and a parity regression
proves the live panel's row set is exactly the global snapshot's step set — no
new read-only timeline UI is added in this batch.

**File impact.** New `src/timeline-rows.ts`; `src/status.ts`
(`PanelContext.timeline`, `buildPanelContext`), `src/loops/execution.ts`
(per-step scan + row build), `src/status-panel.ts` (relevance rendering),
`src/terminal-accent.ts` (`panelBorderColor`), `src/plain-render.ts` (type
adaptation), `tests/helpers/panel-context.ts` and panel-context literals in
tests.

**Verification.**

- Active and historical artifacts from the current chain remain prominent.
- Same-loop artifacts from another run remain visible but dimmed.
- Artifacts from plan, implement, and review bindings appear together in their
  causal (scanner) order.
- Ad-hoc and second-opinion chains remain distinguishable (a second-opinion
  run shares the pipeline run of its origin chain → `current-run` vs
  `current-chain`; an unrelated ad-hoc run is dimmed).
- Matching-but-unclassified artifacts remain visible as warnings and never
  become completion evidence (state logic untouched — D7).
- Archived files and unrelated `docs/dev` documents (`plan.md`,
  `research.md`, notes) never produce rows (fixture test against
  `buildTimelineRows`).
- Parity: the live panel row set equals `scanGlobalSnapshot(...).steps` for a
  fixed project, and `orc status` continues to derive from the same snapshot.
- Per-step (not per-tick) scanning: the supplier serves identical rows across
  two paints without a second scan (spy on the scanner seam).
- Per-step scan cost is bounded and called out: `scanGlobalSnapshot`
  (`src/artifact-index.ts:96`) walks the project, parses every artifact,
  recomputes every identity digest, and runs the lineage + approval-reduction
  passes — O(artifacts) per provider step, bounded by the project artifact
  count. No caching is added in this batch (deliberate); the cadence stays
  once per provider step, never per tick. While the renderer is open, the
  stale `across 200ms ticks` comment at `src/status-panel.ts:86` is corrected
  — the interval is `PANEL_RENDER_INTERVAL_MS = 1000`
  (`src/cli-output.ts:14`), so it reads `across 1s ticks`.

### D7 — Relevance is presentation-only (item 4)

**Design.** `buildTimelineRows` consumes an already-built `GlobalSnapshot` and
returns display rows; it never mutates steps, never marks classification, and
is not consulted by candidate eligibility, recovery, chain reduction,
ordering, or runner invocation. Timeline membership continues to come only
from the manifest-driven artifact scanner (`artifact-index.ts`), whose
pattern matching and `archived/` exclusion are unchanged.

**Verification.**

- Existing scanner, chain-lineage, approval-reduction, and pipeline-stage
  tests pass unmodified.
- A dimmed artifact's `Step` is deep-equal before and after row derivation.

### D8 — Compact identity/fingerprint columns with the `*suffix` convention (item 5)

**Design.** The timeline table gains four columns in this order after the
existing ones:

```text
Artifact  Parent  Input FP  Result FP
```

Each value renders through one shared compact formatter in `src/status.ts`.
`formatSessionId` (`status.ts:22`) already returns
`sessionId.length > 5 ? \`*${sessionId.slice(-5)}\` : sessionId` with an em-dash
fallback, so rather than duplicate it, extract `formatCompactId(value?: string | null)` with the same five-suffix rule and have `formatSessionId`
delegate to it. Every compact identity and session cell then uses one helper
(artifact identities are 64-char sha256 digests, so the `≤ 5` branch is never
hit in practice, but the two functions no longer drift). Completed and
interrupted rows map the fields from provenance: `artifactIdentity`,
`parentArtifactIdentity`, `inputFingerprint`, `resultFingerprint`.

Running rows show the values known before spawn: `PanelContext.inFlight` gains
optional `artifactIdentity`, `parentArtifactIdentity`, `inputFingerprint`, and
`resultFingerprint`, populated in `src/loops/execution.ts` from the pre-spawn
draft identity (the same value the durable interrupted marker records), the
run-context parent, and `request.inputFingerprint`. The result fingerprint is
genuinely pending while running and renders as an em dash; it appears once the
artifact persists.

Provisional identity: a running row's compact `Artifact` is the pre-spawn
draft identity (`execution.ts:273`, computed from `targetFingerprintBefore`),
recorded by the durable interrupted marker. The persisted artifact identity
(`binding-engine.ts:325`) is recomputed after the step with the post-step
`resultFingerprint` (`binding-engine.ts:320`). When the target changes, these
two identities differ, so the same version's compact `Artifact` suffix can
shift between the running row and the completed row. This is display-only
(compact suffixes are never compared — see below), but it is called out here
so the suffix change on completion is not reported as a regression; provenance
full values remain authoritative.

The compact form is a render-time derivative of `Step`/in-flight fields. It is
never fed back into comparison, selection, parent lookup, or authorization;
full values remain authoritative in provenance and detailed status/debug
views.

Width-adaptive layout: the renderer computes the panel inner width via
`resolveTerminalWidth` minus panel chrome. When the 13-column table fits, it
renders as one table with explicit `colWidths` and `wordWrap`. When it does
not, the four compact fields move to a dimmed continuation row beneath each
artifact row, preserving their labels and their association with the correct
artifact (e.g. `artifact *a1b2c  parent *d4e5f  in *g6h7i  out —`).

**File impact.** `src/status.ts` (`formatCompactId`/`formatSessionId`
shared helper, in-flight fields), `src/loops/execution.ts` (population),
`src/status-panel.ts` (columns and width-adaptive layout). Existing
timeline-table assertions in `tests/execution-panel.test.ts` (and any
`renderStatusPanel`/`renderPlainPanel` snapshot checks) are updated from the
current column set to the four new compact columns as part of this release.

**Verification.**

- Artifact, parent, input, and result cells map to the correct provenance
  fields.
- Running rows show pre-spawn values and use an em dash only for the genuinely
  pending result fingerprint.
- Completed and interrupted rows retain their durable compact identifiers.
- Two identifiers sharing a five-character suffix remain distinct in all state
  logic (derivation/render path performs no suffix comparison; provenance
  lookups keep using full values).
- Long model names plus the new columns do not overflow the panel border, in
  both the column layout and the continuation-row layout (`COLUMNS` forced,
  ANSI-stripped width assertions).
- Existing timeline-table assertions in `tests/execution-panel.test.ts` and
  any panel-render snapshots are updated to the new column set and re-pass;
  no assertion is left pointing at the old column layout.
- Plain output changes only through the deliberate, tested D3/D4 format
  update; no compact columns are added to plain rendering in this batch.

## Release boundaries

Each release is independently verifiable with `pnpm typecheck && pnpm test`.

### Release 1 — Execution vocabulary and effort consistency (D1–D4) ✅

- In-flight effort, `provider default` vocabulary, task `Execution` line,
  loop-only iteration prompt regression coverage.
- All `PanelContext`/`buildPanelContext` construction sites listed in D3 are
  updated to supply `bindingKind` — including `tests/status-core.test.ts`,
  the four literal sites (`status.test.ts`, `cli-output.test.ts`,
  `terminal-accent.test.ts`, `cli-output-live.test.ts`), the direct-literal
  sites, and `tests/helpers/panel-context.ts`. This is what makes the
  required field safe to land in Release 1; it is not deferred.
- Gate: `pnpm typecheck` passes with `bindingKind` required (no literal or
  `buildPanelContext` call left without it); new/updated tests green; e2e
  task run shows no `Round` text and no iteration prompt; loop runs
  unchanged. (Coverage gaps in D4 assertions closed by review follow-up.)

### Release 2 — Run configuration table (D5) ✅

- Borderless aligned table for resolved runners.
- Gate: table layout, wrapping, narrow-width, and plain-output stability tests
  green; interior-grid invariant holds.

### Release 3 — Global timeline and compact identity columns (D6–D8) ✅

- `src/timeline-rows.ts`, relevance rendering, per-step snapshot sourcing,
  compact columns with width-adaptive layout.
- Supplier-driven render assertions (`tests/execution-panel.test.ts`,
  `tests/loop-live.test.ts`, `tests/lease-expiry.execution.test.ts`) and the
  existing run-config/timeline-table assertions are re-validated and updated
  under D5/D6/D8 — this is part of the release, not follow-up work.
- Gate: `pnpm typecheck` passes with `PanelContext.timeline` as
  `TimelineRow[]` and the four compact columns present; `pnpm test` green
  with all D6–D8 verification bullets passing; existing state/eligibility
  suites unmodified and green; `docs/architecture/overview.md` gains a
  one-line mention of `timeline-rows.ts` next to the `state.ts` snapshot
  description (the only doc-sync required — `AGENTS.md` and `README.md`
  statements remain accurate). (D6 verification gaps in per-step spy and
  parity tests closed by review follow-up; D8 result-accenting regression
  fixed.)

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

All coverage is deterministic (fake adapter, fixtures, captured live-region
suppliers, forced `COLUMNS`); no real-provider gate is required because the
batch is provider-neutral presentation. Recommended manual smoke after
Release 3: one interactive `orc smash` run on this repository to visually
confirm the table, dimming tiers, and compact columns on a real terminal.
