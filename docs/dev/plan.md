---
confidence: 0.96
creation:
  protocol: orc-planning-set-v1
  transactionId: deb5151b40759626e8fccf508ed4889c9954335aa1cecd13303576a1479c65eb
  sourceKind: accepted-research
  sourceArtifactIdentity: 29f563eeb17f37071c5b20f8b46bc5d231de88d9fc23ebaf72d4fa6aad4ca5bf
  sourceDigest: c0b1f67eddbe8cc4cd23de40426d98ac9fe9c53bed6a06cdea77359f9cc545e2
  document: plan
  bodyDigest: 5f0390f0fdae7133b2398a09bb4a3a795494f9a93829fe61bc148a94c8428f17
  peerBodyDigest: 81ad471830f42f59651d512d89dd21a745bda15b725424d8cf203e1331efa2a3
---
# Implementation Plan — Semantic, per-location color theming for orc-smash renderers

Acceptance authority: `docs/dev/spec.md`. This plan is the delivery design; every
acceptance criterion (AC1–AC10) and research-derived requirement (R1–R7) maps to
a step below (Spec-to-Plan Coverage). It is concrete against the current
codebase: chalk v5, boxen v8, cli-table3 v0.6, yaml v2, zod v3; accent importers
at `status-panel.ts`, `plain-render.ts`, `plain-event-renderer.ts`,
`interactive.ts`, `cli-output.ts`, `project-snapshot-renderer.ts`; `--plain`
selected at `cli.ts:59`.

## Architecture

### New module — `src/theme.ts`

Owns the theming runtime. Responsibilities:

- The zod schema for `config/theme.yaml` (strict; unknown keys rejected) and the
  fixed token catalog (including `panel.column_header` and `panel.dim_row`).
- `colors:` name resolution (a named hue → a chalk named color or a hex).
- Style-spec → chalk builder (`{ fg, bg, bold, dim, underline, inverse }` → a
  chalk chain), supporting the three color forms: chalk built-in named color,
  `colors:` name, `#rrggbb`. The builder applies attributes in the same order
  chalk does today (e.g. `emphasis.identity` = `{ fg: cyan, bold: true }` opens
  `\x1b[1m\x1b[36m`, matching today's `chalk.bold.cyan`), so composed specs are
  byte-identical by construction (MIN-5).
- Border-spec → boxen color **string** (a chalk named color, or a hex) for
  `borderColor`.
- A per-resolved-spec cache so hot paths (live panel cells) do not rebuild chalk
  chains per cell.
- `borderContext(ctx) -> 'failed'|'audit'|'evaluate'|'follow-up'|'repair'|'implement'|'task'|'default'`
  — the **single** extraction of the border context-selection logic (failed→red;
  in-flight kind; else last-relevant kind; else default), shared by
  `panelBorderColor` and `resolveBorderColor` so neither recurses into the other
  (MIN-3).
- `loadTheme(path?: string): Theme` — a **pure, parameterized** factory mirroring
  `src/config.ts:135` `loadPackagedRegistry(toolRoot)` and the
  `tests/config.test.ts:116-144` pattern: it takes an explicit root/path, holds
  no module cache, and returns a `Theme`. This is the AC10 test target.
- A `Theme` instance exposing `resolveStyle(token, location)` and
  `resolveBorderColor(ctx, location)` — location-override → defaults, first match
  wins; identity formatter at color level 0.

### Theme lifecycle (AC10)

The lifecycle is the **instance form, with a production-convenience default** —
the design MAJ-2's remediation recommends and the only one that satisfies AC10
*and* C-CALLERS at once. AC10 has two clauses that pull in opposite directions:
"does not load at import time" and "a test can swap a fixture `theme.yaml`
without process-wide side effects." A module-level cached singleton loaded lazily
satisfies the first but makes the second unprovable (swapping then requires
mutating process-global state). An explicit injected `Theme` satisfies the second
but forces every accent helper to take a `theme` argument, breaking C-CALLERS
(helpers must keep their single-arg + optional `location` signature). The hybrid
below resolves both:

- **AC10 test path (pure):** `tests/theme.test.ts` calls `loadTheme(fixturePath)`
  → `theme.resolveStyle(...)` / `theme.resolveBorderColor(...)` against temp-dir
  fixtures (good/bad, unknown token rejected), mirroring
  `tests/config.test.ts:116-144`'s `loadPackagedRegistry(tempDir)` calls. Each
  test builds its own `Theme`; **no module state is read or written**, so the
  "swappable fixture without process-wide side effects" clause holds by
  construction. This is the honest proof AC10 names.
- **Production path (free functions, arity-preserving):** the module additionally
  exports free-function `resolveStyle(token, location)` / `resolveBorderColor(ctx,
  location)` that delegate to a **lazily-initialized module-default theme**.
  Accent helpers call the free functions, so they keep their arity (C-CALLERS).
  The default is created on first resolver call, **never at import** — so
  importing `theme.ts` has no side effect and the `config.ts:168`
  `DEFAULT_REGISTRY`-at-import trap is not repeated.
- **Startup initialization (single write):** because the default is lazy, the
  `--theme` path must be fixed before any rendering. `cli.ts` resolves the
  three-tier precedence once and the constructed output calls
  `initTheme(themePath)` to seed the module default (idempotent; one write per
  process). After that, every renderer's free-function call — accent helpers, the
  `panelStyle` wrapper, and `resolveBorderColor` — resolves against the seeded
  theme. If no output initializes it (direct unit-test use of the accent
  helpers), the free functions lazily `initTheme()` with packaged precedence as a
  fallback, so those tests work without the CLI entry point.

**Precedence decision (deferred by the research; C-FORMAT).** Theme precedence
is: `--theme <path>` (explicit) → `<projectRoot>/.theme.yaml` (project-local
override) → packaged `config/theme.yaml`. This mirrors `config.ts`'s three-tier
precedence (`--config` → `.orc-smash.yaml` → `config/`) one-for-one and is the
smallest surprise for users already familiar with orc-smash config. `--theme` is
added as a commander option on the `smash` and `status` commands — the two that
render colored output via `createPanelCliOutput` — mirroring `--config`'s
placement (`cli.ts:50` for `smash`, `:70` for `status`). The `ownership` commands
use `createPlainCliOutput` and carry no `--config`, so they are excluded and keep
the lazy packaged-precedence fallback. The resolved path is threaded end-to-end:
`cli.ts` (parse `--theme`) → `createPanelCliOutput` / `createPlainCliOutput`
(accept an optional `themePath`, added to their signatures) → `initTheme(themePath)`
→ the renderers' free-function resolver calls (MAJ-2). `initTheme` is the single
point that fixes the module-default theme before any rendering.

### Refactor — `src/terminal-accent.ts`

Each helper delegates to `resolveStyle(token, location)` instead of hardcoding
chalk. Each gains an **optional trailing `location` argument** defaulting to
`'terminal-accent'` (C-CALLERS), so existing single-arg callers and
`tests/terminal-accent.test.ts` keep working unchanged. Token mapping:

| Helper | Token(s) |
| --- | --- |
| `roleAccent(role)` | `role.{auditor,planner,reviewer,implementer,unknown}` |
| `kindAccent(kind)` | `kind.{audit,follow-up,implement,evaluate,repair,task}` |
| `statusAccent(status)` | `status.{running,failed,done,interrupted}` |
| `resultAccent(state)` | `result.{pass,fail,warn,neutral}` (via unchanged `toResultState`) |
| `availabilityAccent(state)` | `availability.{available,unavailable,missing-inputs}` |
| `emphasisAccent(state)` | `emphasis.{identity,binding-identity,supporting,placeholder,recommended,warning}` (token key matches the `EmphasisState` `'binding-identity'` verbatim — no abbreviation, MIN-2) |
| `unclassifiedAccent(count)` | `unclassified.{attention,idle}` (count test stays in code) |
| `staleAccent(isStale)` | `stale.{stale,fresh}` (boolean test stays in code) |
| `eventLevelAccent(level)` | `log.{fail,warn,pass,info}` (location default `'log'`) |

The context-selection logic in `panelBorderColor(ctx)` (failed→red; in-flight
kind; else last-relevant kind; else default) is extracted into the single shared
`borderContext(ctx)` helper in `theme.ts` (MIN-3). `panelBorderColor(ctx)` is a
**thin delegate**: it calls `resolveBorderColor(ctx, 'status-panel')`, which runs
`borderContext(ctx)` and resolves the `panel.border.{context}` token via the
theme to a boxen color **string** — a named color (step-1 baseline) or a `#rrggbb`
hex (step-2 rich palette), both accepted by boxen v8 (R2). **No color value lives
in `terminal-accent.ts`**: there is no parallel context→color map; the color comes
solely from the theme, so this is a single source of truth (MAJ-3, restoring the
v1 delegation rather than a second hardcoded resolution). The one-arg
`panelBorderColor(ctx): string` signature is preserved (location defaults to
`'status-panel'`) so `tests/terminal-accent.test.ts`'s name assertions
(`toBe('cyan')`, …) stay green in step 1, where the baseline border tokens resolve
to those same names. `resolveBorderColor` and `panelBorderColor` therefore share
one `borderContext` extraction and one theme resolution — neither recurses, and
they cannot drift. The `PanelBorderColor` literal union
(`'cyan'|'yellow'|'green'|'red'|'blue'`) is retired in favor of `string` because
the resolved value is now theme-driven; the failed→red contract and the
kind-driven selection are unchanged in behavior. `toResultState`, the
`unclassifiedAccent` count test, and the `staleAccent` boolean test are untouched
behavior (C-BEHAVIOR).

### Call-site wiring (R4: local wrapper)

`src/status-panel.ts`: add once
`const panelStyle = (token) => resolveStyle(token, 'status-panel')` and route
cell/header colors through it, replacing the direct
`emphasisAccent`/`roleAccent`/`statusAccent`/`resultAccent` calls and the
hardcoded `head: ['cyan']` at `:97`/`:112` with `panel.column_header`. When the
header cells are pre-colored, cli-table3's `style.head` is set to `[]` (currently
`['cyan']`) so the table does not re-wrap already-colored cells — the suite
already guards against double-wrap (e.g. `tests/status-panel.test.ts:488`)
(MIN-5). The title and section-header call sites (today `emphasisAccent('identity')`)
**stay on `emphasis.identity`** (R3 decision); `panel.title` is dropped from the
catalog and baseline to avoid a dead token. The `boxen({ borderColor })` call at
`:213` receives `resolveBorderColor(context, 'status-panel')`.

The two raw `chalk.dim` sites the audit flagged (MAJ-1) are routed through the
theme, not left hardcoded:

- `status-panel.ts:308` — `cells.map(cell => chalk.dim(cell))` (dims every cell of
  an unrelated/unclassified timeline row) →
  `cells.map(cell => panelStyle('panel.dim_row')(cell))`.
- `status-panel.ts:376` — `chalk.dim(identity)` (the compact identity line in the
  wide-fingerprint layout) → `panelStyle('panel.dim_row')(identity)`.

`panel.dim_row: { dim: true }` reproduces `chalk.dim` byte-for-byte at level 1,
so AC4 is unaffected. With both sites routed, the `import chalk` at `:3` is
**dropped** — `status-panel.ts` no longer imports chalk directly for color, so
the Ownership Boundaries sentence holds as written (MAJ-1, Option 1).

| Renderer / call site | Location |
| --- | --- |
| `status-panel.ts` (cells, header, border) | `status-panel` |
| `interactive.ts`, `cli-output.ts`, `project-snapshot-renderer.ts` | `terminal-accent` |
| `plain-render.ts` (`--plain` timeline) | `plain-timeline` |
| `plain-event-renderer.ts` (event log) | `log` |

`cli-output.ts`, `interactive.ts`, `project-snapshot-renderer.ts`,
`plain-render.ts`, and `plain-event-renderer.ts` pass their location explicitly
at each accent call site. `stage-menu.ts` imports only the `AvailabilityState`
type (no behavior change).

## Ownership boundaries

- **`theme.ts`** owns: schema, catalog, `colors:` table, spec→chalk builder,
  border→name builder, `borderContext`, cache, `loadTheme`/`Theme`, the
  free-function `resolveStyle`/`resolveBorderColor`, the lazy module default +
  `initTheme`, and precedence. It imports nothing from `terminal-accent.ts`.
- **`terminal-accent.ts`** owns: helper signatures, the token↔helper mapping, and
  the preserved behavioral switches (`toResultState`, `panelBorderColor` context,
  the count/boolean tests). It imports from `theme.ts`.
- **`config/theme.yaml`** owns: every color value (baseline and rich). No color
  value lives in `.ts`.
- **Renderers** own: passing the correct `location` literal at each call site.
  After MAJ-1, **no renderer imports chalk directly for color**: the row/identity
  dimming is routed through `panel.dim_row` and the `chalk` import is dropped from
  `status-panel.ts`. The boxen `borderColor` handoff receives a theme-resolved
  color **string** (not a chalk call), and the cli-table3 `head` style is set to
  `[]` with header cells pre-colored through `panel.column_header` — both resolve
  through the theme, not chalk.

## Implementation sequence

**Step 0 — Scaffolding (C-FORMAT, AC10).** Add `src/theme.ts` with the schema,
catalog, `colors:` resolution, spec→chalk builder, border→name builder,
`borderContext`, cache, the pure `loadTheme(path?): Theme` factory, the
`Theme.resolveStyle`/`Theme.resolveBorderColor` instance API, the free-function
`resolveStyle`/`resolveBorderColor` delegating to a lazy module default +
`initTheme`, and the three-tier precedence. Add `tests/theme.test.ts` exercising
`loadTheme(fixturePath)` → `theme.resolveStyle`/`theme.resolveBorderColor`:
strict validation (good/bad fixtures, unknown token rejected), module-load
isolation with **no module state mutated** (per `tests/config.test.ts:116-144`),
token resolution order, and spec→chalk byte assertions. No call site is wired yet.
*Gate:* `pnpm test theme` green; importing `theme.ts` produces no side effects
(AC10: the isolation test builds a `Theme` per case via `loadTheme`, never
touching the module default).

**Step 1 — No-op baseline (AC1–AC5, AC8, AC10).**

1. Add `config/theme.yaml` with the step-1 baseline. Apply the audit fixes up
   front (R1): `role.unknown: { fg: gray }` (no `dim`), and
   `panel.column_header: { fg: cyan }` (no `bold`). Add `panel.dim_row: { dim: true }`
   reproducing today's `chalk.dim` at `status-panel.ts:308,376` (MAJ-1). No
   `panel.title` token (R3). All other baseline tokens use chalk built-in named
   colors reproducing today's (`role.*`, `kind.*`, `status.*`, `result.*`,
   `availability.*`, `emphasis.*`, `unclassified.*`, `stale.*`,
   `panel.column_header`, `panel.dim_row`, `panel.border.*`, `log.*`). Empty
   per-location blocks (`status-panel: {}`, etc.) so every location inherits
   identical `defaults`.
2. Refactor `terminal-accent.ts` helpers to delegate to
   `resolveStyle(token, location)` with the optional trailing `location` arg
   (default `'terminal-accent'`); `eventLevelAccent` defaults to `'log'`.
   `panelBorderColor(ctx)` delegates to `resolveBorderColor(ctx, 'status-panel')`,
   which runs the shared `borderContext(ctx)` and resolves the
   `panel.border.{context}` token via the theme — one selection path, one theme
   resolution, **no context→color map in `.ts`** (MIN-3/MAJ-3).
3. Wire locations: `status-panel.ts` via the `panelStyle` wrapper (R4),
   including routing the two `chalk.dim` sites through `panelStyle('panel.dim_row')`
   and dropping `import chalk` (MAJ-1); `plain-render.ts` → `'plain-timeline'`;
   `plain-event-renderer.ts` → `'log'`;
   `interactive.ts`/`cli-output.ts`/`project-snapshot-renderer.ts` →
   `'terminal-accent'`. One-line wiring edits; no behavior change because every
   location's baseline inherits the same `defaults`.
4. Replace `head: ['cyan']` (`:97`/`:112`) with `panel.column_header` applied to
   the header cells and set `style.head: []` so cli-table3 does not re-wrap them
   (MIN-5).

*Gate (AC4):* `pnpm test status-panel terminal-accent` green — the byte
assertions (`[36m`/`[33m`/`[32m`/`[31m`), the `panelBorderColor` name assertions,
and the strip-ANSI assertions all hold **unchanged**. Plus a new before/after
snapshot test asserting the status panel and the `--plain` timeline are
byte-identical to a captured pre-step-1 baseline. The snapshot is
**deterministic**: it freezes time with `vi.setSystemTime` (precedent
`tests/status-panel.test.ts:14`) or captures a panel with no in-flight row, and
the `--plain`-timeline snapshot is likewise time-stable, because `renderStatusPanel`
reads `Date.now()` for elapsed cells (`status-panel.ts:223,320`) (MIN-4).

**Step 2 — Rich palette (AC6).** Flip `config/theme.yaml` to the rich palette:
add `colors:` (teal/amber/orange/red/green/purple/blue/gray hexes),
`emphasis.identity` → orange bold, distinct role hues,
`result.warn`/`emphasis.warning`/`unclassified.attention`/`stale.stale`/
`availability.missing-inputs` → orange, `status-panel.role.implementer` backlight
(`bg: green, fg: black, bold: true`), and
`status-panel.panel.border.default` → orange. **This deliberately changes the
pinned bytes** (the planned visual change). Update the `status-panel` byte/name
assertions as an **enumerated, acknowledged edit** in `tests/status-panel.test.ts`
(list each changed assertion explicitly in the step's commit message). Because
`panelBorderColor` now delegates to `resolveBorderColor` (MAJ-3), the
default-context `panelBorderColor(ctx)` name assertion follows the theme: it
changes from `'blue'` to the orange value and is folded into this same enumerated
edit (the other context assertions — `toBe('red')`/`toBe('cyan')`/… — are
unchanged, since only `panel.border.default` is recolored). No `.ts` color change.
*Gate:* full suite green; `--plain`/level-0 still uncolored (AC8).

**Step 3 — Background-fill verification (AC7).** Add a `status-panel`/fixture
test with a row whose implementer cell exceeds its column width; assert no
background SGR sequence is left open past the slice boundary and no bleed reaches
the separator or the next column. If bleeding occurs: append an explicit reset at
each styled-cell boundary, or restrict background fills to non-truncating columns
(Role/Status). Document the chosen mitigation in the step's evidence. *Gate:* the
fixture passes (gate #1, R7).

## File impact

| File | Change |
| --- | --- |
| `src/theme.ts` | **New.** Schema, catalog, `colors:` table, spec→chalk builder, `borderContext`, cache, pure `loadTheme(path?): Theme` factory, `Theme.resolveStyle`/`resolveBorderColor`, free-function resolvers + lazy module default + `initTheme`, precedence (MAJ-2). |
| `src/terminal-accent.ts` | Refactor all helpers to delegate; add optional `location` arg; `panelBorderColor` delegates to `resolveBorderColor` (sharing `borderContext`, **no context→color map in `.ts`**, MAJ-3/MIN-3); retire `PanelBorderColor` union for `string`. Behavior switches unchanged. |
| `src/status-panel.ts` | `panelStyle` wrapper (R4); header cells via `panel.column_header` with `style.head: []` (MIN-5); route the two `chalk.dim` sites (`:308,376`) through `panelStyle('panel.dim_row')` and **drop `import chalk`** (MAJ-1); `boxen({borderColor})` via `resolveBorderColor`. Title/headers stay on `emphasis.identity` (R3). |
| `src/plain-render.ts` | Pass `'plain-timeline'` at accent call sites. |
| `src/plain-event-renderer.ts` | Pass `'log'` at `eventLevelAccent` call sites (already its domain). |
| `src/interactive.ts`, `src/project-snapshot-renderer.ts` | Pass `'terminal-accent'` at accent call sites. |
| `src/cli-output.ts` | `createPanelCliOutput` / `createPlainCliOutput` accept an optional `themePath` and call `initTheme(themePath)` to seed the module default once before rendering (MAJ-2); also pass `'terminal-accent'` at its accent call sites. |
| `src/cli.ts` | Add `--theme <path>` option to `smash` and `status` (mirroring `--config` at `:50`/`:70`); resolve three-tier precedence; pass `themePath` to their `createPanelCliOutput` constructors (MAJ-2/MIN-7). |
| `config/theme.yaml` | **New.** Baseline incl. `panel.dim_row: { dim: true }` (step 1) → rich palette (step 2). |
| `tests/theme.test.ts` | **New.** `loadTheme(fixturePath)` isolation (no module state), strict validation, resolution order, spec→chalk bytes (incl. composed), level-0 identity (AC10). |
| `tests/status-panel.test.ts` | Add before/after byte snapshot, **time-frozen / no-in-flight for determinism** (step 1, MIN-4); enumerate changed byte/name assertions (step 2); add backlight-bleed fixture (step 3). |
| `tests/terminal-accent.test.ts` | Signatures unchanged; keep green. Add explicit level-1 byte assertions for composed specs (`emphasis.identity`, `emphasis.binding-identity`) (MIN-5). |

No changes to: `src/state.ts`, `src/status.ts`, `src/manifest.ts`, `src/runner.ts`,
`src/config.ts`, the providers/registry config, or any pipeline/runner/provenance/
adapter module (C-SCOPE).

## Failure handling

- **Bad theme file** (unknown token, malformed hex, unknown color name,
  structural error): zod rejects at load time; the error names the offending
  token/path (mirroring `config.ts`'s `superRefine` messages). The process fails
  fast with a clear message rather than rendering unstyled cells — fail-closed by
  design (AC1).
- **Missing packaged `config/theme.yaml`:** the loader throws a "packaged theme
  not found" error analogous to `config.ts`'s packaged-manifest guard — this
  covers both the explicit `initTheme()` path and the lazy free-function fallback
  (MAJ-2). A project-local `.theme.yaml` still works.
- **`--theme <path>` points to a missing file:** throw
  "Specified theme file not found: <path>" (mirrors the `--config` guard).
- **Background-fill bleed (step 3):** if the fixture shows a dangling background
  SGR past the slice, apply the documented mitigation (explicit reset or
  non-truncating-column restriction) and re-run the gate. Do not ship step 3 with
  a known bleed.
- **Test regression in step 1:** if any byte/name assertion changes unexpectedly,
  the baseline is wrong (likely a missed R1 fix); correct the YAML rather than
  weaken the assertion. Step 1 must be byte-identical — a byte change here is a
  defect, not progress.
- **Color level 0 / `--plain`:** `resolveStyle` returns the identity formatter;
  no throw, no color leak. A colored byte appearing in `--plain` output is a
  defect.

## Verification

Automated (vitest):

- `tests/theme.test.ts` (AC10): `loadTheme(fixturePath)` is exercised directly
  against temp-dir fixtures (good/bad, unknown token rejected), building a
  `Theme` per test with **no module state read or written** (mirrors
  `tests/config.test.ts:116-144`); `theme.resolveStyle` / `theme.resolveBorderColor`
  assert token resolution order (location beats defaults; unknown token fails
  closed) and spec→chalk correctness for named colors (exact bytes, e.g.
  `{ fg: cyan }` → `\x1b[36m`), hex, background, and composed specs; level-0
  returns the identity formatter.
- `tests/status-panel.test.ts` (step 1): a before/after snapshot of the status
  panel **and** the `--plain` timeline asserts identical bytes (closes
  AC4/C1+M3); the snapshot is **time-frozen** (`vi.setSystemTime`, precedent
  `tests/status-panel.test.ts:14`) or uses a no-in-flight panel so the
  `Date.now()` elapsed cells (`status-panel.ts:223,320`) do not make the diff
  flaky (MIN-4); the existing border byte assertions and the `panelBorderColor`
  name assertions stay green unchanged (closes AC5/C2).
- `tests/terminal-accent.test.ts`: the strip-ANSI and label assertions stay
  green; signatures unchanged. Add explicit level-1 byte assertions for
  **composed** specs — `emphasis.identity` (`chalk.bold.cyan` → opens
  `\x1b[1m\x1b[36m`) and `emphasis.binding-identity` (`chalk.cyan` → `\x1b[36m`)
  — pinning the builder's attribute order to today's chalk-chain order (MIN-5).
- `--plain` / level-0 (AC8, MIN-1): pin `chalk.level = 0` (precedent
  `tests/status-panel.test.ts:14`) and assert **zero SGR sequences** in
  `plain-render.ts` and `plain-event-renderer.ts` output at that level.
  `resolveStyle` keys off `chalk.level` only — no `--plain`-specific suppression
  is introduced, so `--plain` on a TTY remains colored as today.
- Step 2: the changed byte/name assertions are updated and enumerated.
- Step 3 (gate #1, AC7): the backlight-truncation-no-bleed fixture.
- AC9 label-retention spot-check (MIN-8): assert representative colored cells
  still contain their text label/symbol after coloring — e.g. an
  `status-panel.role.implementer` backlight cell still contains `implementer`,
  and a failed border/result case still renders `failed`. A step-2 edit that
  drops a label in favor of color alone trips this check.

Manual (gate #2, R7; not automatable):

- On one truecolor terminal (level 3): confirm `orange`/`purple`/`teal` hex render
  and are distinguishable; confirm the implementer backlight reads as green-fill /
  black-text; confirm no global bleed.
- On one 256-color terminal (level 2): confirm the hex approximations of
  orange/purple/teal remain distinguishable from each other and from red/green.
- Re-confirm the level-1 exact-byte match for the named-color baseline — the
  baseline is byte-identical at level 1 by construction, and the snapshot gate
  already proves this deterministically.

## Acceptance gates

- **Gate A (step 1, byte-identical):** `pnpm test status-panel terminal-accent
  theme` green **and** the status-panel + `--plain`-timeline before/after snapshot
  is byte-identical (time-frozen / no-in-flight so it is deterministic, MIN-4).
  This is the proof the plumbing is correct and non-behavioral.
- **Gate B (step 2, rich palette):** full `pnpm test` green with the enumerated
  byte/name assertion edits; `--plain`/level-0 uncolored; no `.ts` color change.
- **Gate C (step 3, no bleed):** the backlight-truncation fixture passes
  (gate #1). Gate #2 is a manual visual sign-off recorded in the step evidence.

## Spec-to-Plan Coverage

| Spec item | Plan step | Verification evidence |
| --- | --- | --- |
| AC1 — token catalog, fail-closed, no raw chalk | Step 0 (catalog/schema), Step 1 (wiring) | `tests/theme.test.ts`: unknown-token rejection at load; `panel.dim_row` routes the two `chalk.dim` sites and `import chalk` is dropped from `status-panel.ts` (MAJ-1) |
| AC2 — style-spec resolution | Step 0 | `tests/theme.test.ts`: `{ fg: cyan }` → `\x1b[36m`; hex/bg/composed; `{}` identity; composed byte order pinned in `terminal-accent.test.ts` (MIN-5) |
| AC3 — per-location themes | Step 0 (resolver), Step 1 (wiring) | `tests/theme.test.ts`: location beats defaults |
| AC4 — no-op baseline byte-identical | Step 1 | Gate A: snapshot byte-identical (deterministic, MIN-4); status-panel/terminal-accent green unchanged |
| AC5 — context border preserved | Step 1 | `panelBorderColor` delegates to `resolveBorderColor` (no color map in `.ts`, MAJ-3); shared `borderContext`; rendered border bytes + step-1 name assertions unchanged, default-context name folded into the step-2 enumerated edit |
| AC6 — rich palette | Step 2 | Gate B: full suite green; enumerated byte edits; one-file palette |
| AC7 — no background bleed | Step 3 | Gate C: backlight-truncation fixture (gate #1) |
| AC8 — level-0/non-TTY uncolored | Step 0, Step 1 | `tests/theme.test.ts`: level-0 identity; `--plain` path via `cli.ts:59` with `chalk.level = 0` pinned and zero SGR asserted in plain output (MIN-1) |
| AC9 — color never sole encoder | Steps 1–2 (constraint) | Label-retention spot-check: representative colored cells still contain their text label/symbol (e.g. an implementer backlight cell contains `implementer`; a failed case renders `failed`) (MIN-8) |
| AC10 — module-load isolation | Step 0 (lifecycle) | `loadTheme(fixturePath)` → `Theme`, no module state mutated (`config.test.ts` patterns); Theme lifecycle subsection (MAJ-2) |
| R1 — baseline fixes (m1, m2) | Step 1.1 | `role.unknown: { fg: gray }`; `panel.column_header: { fg: cyan }`; snapshot gate empty diff |
| R2 — boxen v8 hex border (m3) | Step 0 (border→name), config | boxen v8 accepts hex `borderColor`; named-color border tokens in both palettes |
| R3 — title routing (m4) | Step 1.3 | Title/headers stay on `emphasis.identity`; `panel.title` dropped from catalog + baseline |
| R4 — panel-style wrapper (m5) | Step 1.3 | `const panelStyle = (token) => resolveStyle(token, 'status-panel')` in `status-panel.ts`; also wraps `panel.dim_row` (MAJ-1) |
| R5 — `unclassified` own group | Step 0 (catalog) | No `status.unclassified`; `unclassified.{attention,idle}` |
| R6 — truecolor rich / named baseline | Steps 1–2, manual | Baseline named colors; rich palette hex; chalk auto-detection |
| R7 — two verification gates | Step 3 + manual | Gate #1 fixture; gate #2 manual truecolor/256/level-1 |
