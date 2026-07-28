---
status: draft
batch: 7
confidence: 0.98
---

# Plan — Optional identity and fingerprint visibility

## Objective

Add a single, explicit `--show-fingerprints` presentation flag to both
`orc smash` and `orc status`.

The normal `orc smash` timeline should show its nine operational columns:
`Ver`, `Role`, `Agent`, `Model`, `Effort`, `Result`, `Time`, `Session`, and
`Status`. The four diagnostic columns—`Artifact`, `Parent`, `Input FP`, and
`Result FP`—should be hidden unless the operator supplies
`--show-fingerprints`.

The read-only `orc status` report is line-oriented rather than a timeline
table. Its default view should likewise omit raw artifact-identity and
fingerprint values from pipeline suggestions; `--show-fingerprints` should
restore those existing diagnostic lines. Both commands must continue to show
the semantic result of fingerprint processing, including stale eligibility,
target drift, and missing-fingerprint reasons, regardless of the flag.

This is a presentation-only batch. It must not alter artifact contents,
provenance, fingerprint computation, state reconstruction, pipeline
eligibility, runner selection, provider execution, interruption handling,
ownership, or supervisor compatibility.

## Scope

### Included

- Declare `--show-fingerprints` on the `smash` and `status` commands.
- Carry one default-off display choice through interactive, direct loop, task,
  pipeline, continuation, and second-opinion `orc smash` runs.
- Apply the choice to every live-panel repaint, including historical and
  in-flight timeline rows.
- Preserve the current responsive rendering when diagnostics are enabled:
  four table columns on sufficiently wide terminals and one compact
  identity/fingerprint line beneath each row on narrow terminals.
- Apply the same choice to raw identity/fingerprint diagnostics in
  `orc status` and in the interactive **Display pipeline and project state**
  action.
- Leave `--plain` lifecycle/event output structurally and textually unchanged.
- Update deterministic tests and operator/architecture documentation.

### Not included

- No `-fp`, `--fingerprints`, or `--verbose-identity` alias.
- No persisted preference, project-manifest setting, environment variable,
  interactive toggle, or automatic terminal-width policy that changes the
  operator's selection.
- No independent switches for the four diagnostic fields.
- No new status table or redesign of the line-oriented `orc status` report.
- No change to the compact startup project snapshot, which does not currently
  expose the four raw values.
- No change to plain events, artifact front matter, event schemas, logs, or
  provider telemetry.
- No Batch 8 specification/plan split and no Batch 9 scope-triage task.

## Current behavior and exact change

### Live `orc smash` timeline

`src/status-panel.ts` currently constructs thirteen cells for every historical
and in-flight row. `renderTimelineSection` renders all thirteen when the
minimum widths fit. On a narrow terminal, it renders the first nine columns and
unconditionally appends `compactIdentityLine(...)` beneath every row.

Change that decision table to:

| `showFingerprints` | Wide terminal | Narrow terminal |
| --- | --- | --- |
| `false` or omitted | Nine core columns only | Nine core columns only |
| `true` | All thirteen columns | Nine core columns plus compact diagnostic line |

The four values remain available in `Step` and the in-flight context. Hiding
them must be implemented only at render time.

### Read-only `orc status`

`src/project-snapshot-renderer.ts` currently prints pipeline-candidate
diagnostics as individual lines. The relevant raw lines are:

- `Artifact identity: <value>`
- `Fingerprint: valid (<value>)`
- `Fingerprint: drift (recorded <value> vs current <value>)`

When the flag is absent, omit the raw `Artifact identity` and `Fingerprint`
lines. Keep the candidate status, human-readable stale reason, and exact
`Eligibility reason` line. Those lines already communicate `eligible`,
`target-fingerprint-drift`, `missing-target-fingerprint`, and other typed
states without exposing compact or full diagnostic values.

When the flag is present, render the existing raw lines unchanged. Keep
`Predecessor artifact`, binding/phase, chain, normalized result, and decision
or outcome visible in both modes; they are normal workflow context rather than
the optional raw identity/fingerprint display.

## Architecture and ownership

The feature should use the existing seams and should not introduce a new
generic helper module:

- `src/cli.ts` owns declaration and help text for the operator flag.
- `SmashOptions`, `StatusOptions`, and the generic binding execution options
  carry the boolean without interpreting workflow state.
- `PanelContext` carries the live-panel presentation choice. The live supplier
  closes over the run-scoped value so every timer-driven repaint uses the same
  selection.
- `src/status-panel.ts` alone decides whether the four live timeline fields are
  rendered.
- `src/project-snapshot-renderer.ts` alone decides whether raw detailed-snapshot
  values are rendered.
- State builders and scanners continue to collect complete data in both modes.

Use the same property name, `showFingerprints`, at each boundary. Treat only
the exact boolean `true` as enabled so existing direct callers and test
fixtures that omit the new optional property retain the new default-hidden
behavior.

Do not make the manifest own this setting. It is a per-invocation operator
display preference, not workflow configuration or durable state.

## Implementation plan

### 1. Add the CLI contract

**Files:** `src/cli.ts`, `tests/cli.test.ts`

- Add `.option('--show-fingerprints', ...)` to both the `smash` and `status`
  Commander commands.
- Describe the option as showing artifact lineage and input/result
  fingerprints so the help text is accurate even though two fields are
  identities rather than fingerprints.
- Do not declare any short or legacy alias.
- Extend the CLI contract test to require the long option on both commands and
  to ensure no `--fingerprints` compatibility option is introduced.

**Verification:** Commander exposes the option on exactly the two intended
commands, parses it as a boolean, and continues to parse `-p` / `--project`
unchanged.

### 2. Thread the run-scoped choice to the live panel

**Files:** `src/commands/smash.ts`, `src/loop.ts`,
`src/loops/binding-engine.ts`, `src/loops/execution.ts`, and `src/status.ts`.

> **Role of `src/status.ts` (type-only).** This module owns the
> `PanelContext`/`buildPanelContext` *types* (and the `buildPanelContext`
> constructor) only. The per-invocation boolean is **not** propagated *through*
> `status.ts`; it flows `loop.ts` → `binding-engine.ts` → `execution.ts`. The
> only change in `src/status.ts` is the optional field on `PanelContext` plus
> the matching `buildPanelContext` parameter described below. Do not route the
> runtime boolean through this module.

- Add `showFingerprints?: boolean` to `SmashOptions`, `LoopOptions`,
  `BindingEngineOptions`, and `LoopExecutionDeps`.
- Pass `options.showFingerprints === true` from `smashAction` into the shared
  loop/task executor options — add it to the `executorOptions` object literal
  in `src/commands/smash.ts` (the single `executorOptions = { ... }` site fed
  to both `runLoop` and `runTask`). This single route must cover interactive
  starts, direct loops, tasks, pipelines, continuations, suggested stages, and
  second opinions.
- Pass the value from `runBinding` to `executeLoopStep`.
- Extend `PanelContext` with optional `showFingerprints?: boolean`, added as
  the **last field of the interface** (immediately after `providerCalls?`).
- Extend `buildPanelContext` with a **trailing optional positional parameter**
  `showFingerprints?: boolean = false`, placed after the current final
  parameter (`activeInvocation?`), and map it into the returned object literal
  as `showFingerprints`. Commit to the trailing-optional positional form rather
  than a named options object: every existing call site already omits this
  parameter, so all stay valid with no rewrite — the single production call site
  `src/loops/execution.ts:255` (inside the live-region supplier, which reads
  `deps.showFingerprints`) and the `tests/status-core.test.ts` calls (`:21`,
  `:28`). The `execution.ts` call is the one that supplies the value: add
  `deps.showFingerprints` as its trailing argument. A named options object would
  instead force a rewrite of every call site and risks forgetting to map the
  field, silently leaving `context.showFingerprints` `undefined` so that
  diagnostics never render in the enabled case.
- Do not derive the value from terminal width, output mode, environment, the
  active provider, or binding kind.
- Keep the flag stable in the live-region supplier. It must not be reset when
  lifecycle events update progress, tool-call count, status, or the in-flight
  row.

**Verification:** captured live contexts have `showFingerprints: true` when the
command option is enabled and default to disabled when it is absent.

### 3. Make the timeline renderer default to the core table

**File:** `src/status-panel.ts`

> **Name collision — edit the right function.** Two exported functions share
> the name `renderStatusPanel`. The live-panel one modified here takes a
> `PanelContext`: `renderStatusPanel(context: PanelContext)` at
> `src/status-panel.ts:110`. The unrelated detailed-snapshot one takes a project
> root: `renderStatusPanel(projectRoot, config, output, opts?)` in
> `src/commands/status.ts:47`, handled in Step 4. They share nothing but the
> name; do not confuse them.

- Keep the existing thirteen-column header, preferred widths, minimum widths,
  full row values, and `compactIdentityLine` formatter as the enabled
  diagnostic representation.
- In `renderTimelineSection`, branch first on
  `context.showFingerprints === true`.
- When disabled, render only `head.slice(0, 9)` and `row.slice(0, 9)` at every
  terminal width. Do not append compact diagnostic lines. On a wide terminal
  this nine-column table grows toward its preferred widths (sum 109) to fill the
  panel — this is expected and harmless (no overflow: `fitColumnWidths` caps
  growth at the preferred widths and the emergency fallback in
  `renderAlignedTable` guarantees the panel bound). It is simply the inverse of
  compacting on a narrow terminal, not a bug, so "the columns got wider after I
  hid diagnostics" is the correct wide-width behavior.
- When enabled, retain the current responsive behavior:
  - render the thirteen-column table when its minimum width fits;
  - otherwise render the nine-column table and append exactly one compact
    diagnostic line for each historical or in-flight row.
- Preserve current row ordering, latest-current-chain marker placement,
  dimming of unrelated/unclassified rows, per-cell result accents, elapsed
  duration updates, and panel width bounds.
- Do not erase diagnostic values from `timelineCells` or `inFlightCells`;
  render-time projection is what makes this a presentation-only feature.

**Verification:** the four headers and compact values are absent by default,
present with the flag, and responsive behavior remains bounded at wide and
narrow widths.

### 4. Apply the option to detailed project status

**Files:** `src/commands/status.ts`,
`src/project-snapshot-renderer.ts`, `src/commands/smash.ts`

> **Reminder (same collision as Step 3).** `commands/status.renderStatusPanel`
> is the detailed-snapshot renderer at `src/commands/status.ts:47` — distinct
> from the live `status-panel.renderStatusPanel` modified in Step 3. Note that
> `src/commands/smash.ts` imports it via the relative path `'./status.js'`, which
> resolves to `src/commands/status.ts` — not `src/status.ts` (types) and not
> `src/status-panel.ts`.

- Add `showFingerprints?: boolean` to `StatusOptions`
  (`src/commands/status.ts`).
- Change the 4th parameter of `renderStatusPanel` from the current dead
  placeholder `_opts?: { loop?: string; all?: boolean }` (the `loop`/`all`
  fields are passed in but never read by the body — hence the `_opts` underscore)
  to `opts?: { showFingerprints?: boolean }`.
- Update the two call sites of that 4th parameter:
  - `renderStatus` (`src/commands/status.ts:68`) — replace
    `{ loop: options.loop, all: options.all }` with
    `{ showFingerprints: options.showFingerprints === true }`.
  - The interactive **Display pipeline and project state** branch
    (`src/commands/smash.ts:481`), which today calls
    `renderStatusPanel(projectRoot, config, options.output)` with no 4th
    argument — forward the invocation flag:
    `renderStatusPanel(projectRoot, config, options.output, { showFingerprints: options.showFingerprints === true })`.
    `SmashOptions` already carries `showFingerprints` from Step 2.
- Let `renderDetailedSnapshot` (`src/project-snapshot-renderer.ts:77`) accept an
  optional named render-options object `{ showFingerprints?: boolean }` as a
  trailing second parameter; do not add the flag to `ProjectSnapshotView`,
  because the view describes state rather than display policy. Update its single
  production caller (inside `renderStatusPanel`) to forward
  `opts?.showFingerprints`.
- In the pipeline-suggestion block, render the `Artifact identity` line
  (`project-snapshot-renderer.ts:201`) and the raw `Fingerprint` line (`:210`,
  fed by `rawFpStr` at `:206-209`) only when the option is exactly `true`.
- Continue computing `rawFpStr` only for the enabled branch. The default branch
  must still render:
  - the candidate's eligible/unavailable status (`:199`);
  - its human-readable stale or unavailable reason (`:193-198`);
  - `Eligibility reason` (`:205`), including exact typed fingerprint reasons
    (`target-fingerprint-drift`, `missing-target-fingerprint`, …).
  `Predecessor artifact` (`:200`), `Decision/Outcome` (`:202`), `Binding/Phase`
  (`:203`), and `Chain` / `Normalized result` (`:204`) remain in both modes —
  they are workflow context, not the optional raw identity/fingerprint display.
- Pass the option from `statusAction` to the detailed renderer.
- Returning to the interactive menu after showing project state must not alter
  the original invocation choice.

**Verification:** standalone and interactive detailed status use identical
visibility rules without changing candidate counts, ordering, reasons, or
eligibility.

### 5. Prove plain-output and state invariance

**Files:** `src/plain-render.ts` only if a type adjustment is required;
`tests/plain-render.test.ts`, `tests/terminal-surfaces.test.ts`, or the narrowest
existing equivalent tests

- Do not add identity/fingerprint rendering controlled by this flag to
  `renderPlainPanel`.
- Do not add the option to `RunEvent` or any event payload.
- Ensure `createPlainCliOutput` behavior is unchanged whether the flag is
  present or absent.
- Compare representative plain output or emitted event arrays for both option
  values.
- Build the same project snapshot and pipeline candidates in both display
  modes and assert that only rendered raw diagnostic text differs.

**Verification:** state resolution and plain event output are byte-for-byte or
deep-equal equivalent across the two display choices.

### 6. Update deterministic coverage

**Files:** primarily `tests/status-panel.test.ts`,
`tests/status-action.test.ts`, `tests/project-snapshot.test.ts`,
`tests/status-core.test.ts`, `tests/loop-live.test.ts`,
`tests/smash-action.test.ts`, and `tests/cli.test.ts`; touch other test helpers
only where the `PanelContext` type requires it.

Add or update focused cases for:

1. Wide live panel, default: nine headers; no `Artifact`, `Parent`, `Input FP`,
   `Result FP`, or compact values.
2. Narrow live panel, default (e.g. `COLUMNS=80`): no compact identity line and
   no `Artifact`/`Input FP`/compact values, **and** the rendered max line width
   is `≤ resolveTerminalWidth()` (no horizontal overflow). At 80 columns the
   nine-column minimum width sums to 78 (`[3,10,6,6,8,14,5,7,11]` + 8 gaps),
   which exceeds the 76-column inner panel width, so this case proves
   `fitColumnWidths` compacts the *default* table — the emergency fallback in
   `renderAlignedTable` only guarantees safety; assert it directly for the
   default path, not just the enabled narrow path (item 4).
3. Wide live panel, enabled: all thirteen headers and all four compact values.
4. Narrow live panel, enabled: nine headers plus exactly one compact line per
   historical and in-flight row, with no horizontal overflow.
5. Repeated live supplier calls: the enabled choice and in-flight row remain
   visible while elapsed/progress fields update.
6. Unrelated, unclassified, interrupted, and in-flight rows: visibility
   changes do not change dimming, status, result, or row count.
7. Standalone status, default: raw identity/fingerprint lines omitted while
   stale and missing-fingerprint diagnoses remain.
8. Standalone status, enabled: the existing raw valid and drift lines render
   unchanged.
9. Interactive **Display pipeline and project state** respects the `orc smash`
   invocation flag.
10. Direct loop, task, pipeline, and interactive executor setup passes the
    option into the same live context.
11. `NO_COLOR` changes only ANSI styling and never visibility.
12. Plain output and event streams remain unchanged.

Update existing tests that currently assume identity columns are visible by
default to pass `showFingerprints: true` when that is the behavior under test.
Do not weaken their assertions merely to accommodate the new default. Scope the
change set up front rather than discovering each case via `pnpm test`: the tests
at risk are those that render the panel or detailed snapshot and then assert on
a diagnostic value (`Artifact`, `Parent`, `Input FP`, `Result FP`, a
`*<suffix>` compact id, or a raw `Artifact identity:` / `Fingerprint:` line)
without enabling the flag. To find them, grep the entry points in `tests/` —

- `renderStatusPanel(` — used via `makeContext(` in `status-panel.test.ts`, and
  via literal or variable contexts in `status.test.ts`,
  `execution-panel.test.ts`, `loop-live.test.ts`, and
  `terminal-surfaces.test.ts`; `makeContext` spreads `...overrides` last, so
  `makeContext({ showFingerprints: true })` threads the flag correctly.
- `renderDetailedSnapshot(` — in `project-snapshot.test.ts` and
  `terminal-surfaces.test.ts`.

A confirmed case is `tests/status-panel.test.ts:332` ("shows all compact
identity columns when a wide table fits"), which asserts
`Artifact`/`Parent`/`Input FP`/`Result FP` and the `*aaaaa` compact suffix
without the flag and will fail under the new default-hidden behavior unless
`showFingerprints: true` is supplied. `pnpm test` remains the backstop, but the
grep bounds the change set first.

### 7. Synchronize documentation and close the batch

**Files:** `README.md`, `docs/architecture/overview.md`, `AGENTS.md`,
`docs/dev/archived/follow-up.md`

- Add both command forms to the README examples:
  - `orc smash --project <path> --show-fingerprints`
  - `orc status --project <path> --show-fingerprints`
- Explain the default nine-column live timeline, the opt-in four-field
  diagnostic group, and the narrow-terminal compact form.
- Document that semantic drift and missing-evidence warnings remain visible by
  default and that plain events remain complete and unchanged.
- Record the run-scoped presentation flow in the architecture overview:
  CLI option → executor/live `PanelContext` → renderer, with detailed snapshot
  render options kept outside the state view.
- Keep `AGENTS.md` synchronized with the landed operator contract without
  turning display visibility into a state or fingerprinting invariant.
- After implementation, deterministic verification, and documentation are
  complete, mark only the Batch 7 checklist item complete. Leave Batches 8 and
  9 untouched.

## Edge cases and failure handling

- **Empty timeline:** render the existing panel and `Timeline:` label without
  diagnostic headers or errors in either mode.
- **Missing values:** when enabled, preserve the existing `—` formatting for
  absent artifact, parent, input, or result values, including the pre-completion
  in-flight result fingerprint.
- **Narrow terminal:** enabled diagnostics move below each row; disabled
  diagnostics disappear entirely. Neither mode may exceed the resolved panel
  width.
- **Terminal width changes during a run:** every repaint re-evaluates layout
  width but retains the run-scoped visibility choice.
- **Stale candidate:** default status still says the candidate is unavailable
  because the target fingerprint changed and retains the typed eligibility
  reason; enabled status additionally shows recorded/current values.
- **Missing fingerprint evidence:** default status retains the typed
  `missing-target-fingerprint` reason without printing a raw placeholder line.
- **Unclassified or legacy artifact:** timeline relevance, status, reason, and
  dimming remain unchanged; enabling diagnostics may show `—` where v1 values
  do not exist.
- **`--plain --show-fingerprints`:** accept the option but do not change the
  event stream or add a second human-oriented diagnostic channel.
- **Interactive menu round trip:** showing project status and returning to the
  menu must preserve the original invocation choice.
- **Configuration errors and no-binding status:** error messages and exit codes
  occur before rendering and remain unchanged.

## Verification commands

Run focused tests while implementing:

```bash
pnpm test tests/cli.test.ts tests/status-core.test.ts tests/status-panel.test.ts
pnpm test tests/status-action.test.ts tests/project-snapshot.test.ts
pnpm test tests/loop-live.test.ts tests/smash-action.test.ts
pnpm test tests/plain-render.test.ts tests/terminal-surfaces.test.ts
```

Then run the repository gates:

```bash
pnpm typecheck
pnpm test
pnpm build
```

After the build, perform read-only manual checks against a fixture or disposable
project with at least one eligible and one stale candidate:

```bash
NO_COLOR=1 COLUMNS=160 bin/orc.js status --project <fixture>
NO_COLOR=1 COLUMNS=160 bin/orc.js status --project <fixture> --show-fingerprints
NO_COLOR=1 COLUMNS=80 bin/orc.js status --project <fixture> --show-fingerprints
```

For the live timeline, use deterministic captured-panel tests as the release
gate. An optional manual real-provider run may confirm visual appearance, but
this batch does not change adapter construction, provider arguments, sessions,
timeouts, or artifact contracts and therefore does not require new real-provider
contract coverage.

## Acceptance gates

Batch 7 is complete only when all of the following are true:

- Both commands advertise and accept only the intended
  `--show-fingerprints` long option.
- The normal live timeline contains only the nine core columns at every width.
- Enabled wide and narrow live layouts expose all four diagnostic values
  without overflow.
- The enabled choice survives every live repaint and includes the in-flight
  row.
- Default detailed status omits raw identity/fingerprint values while
  preserving semantic drift, stale, and missing-evidence diagnoses.
- Enabled detailed status restores the existing raw identity/fingerprint
  diagnostics.
- Interactive and direct entry paths share the same behavior.
- Plain output, events, scanning, fingerprints, candidates, and exit codes are
  invariant.
- Typecheck, deterministic tests, and build pass.
- README, architecture, repository rules, and the Batch 7 checklist reflect the
  shipped contract.

## Confidence

Confidence: **0.98**.

The current source already has the required raw fields, responsive table
projection, compact diagnostic formatter, detailed candidate diagnoses, and
run-scoped live context. The remaining work is bounded option propagation,
render-time projection, tests, and documentation. The principal regression
risk is accidentally hiding the semantic reason for a stale or
missing-fingerprint candidate; the plan addresses that with explicit renderer
boundaries and acceptance tests.
