# Research — Semantic, per-location color theming for orc-smash renderers

## Status

Research is complete enough to plan. The design is feasible against the current code,
the config-loading pattern, and chalk's capabilities. The v1 audit rejected it on five
reconciliation gaps — all resolved in this revision:

- **Byte-identity vs. the pinned test bytes.** Today's colors are chalk *built-in named
  colors* (cyan/yellow/magenta/…), and the suite asserts their exact 16-color ANSI bytes.
  The baseline now resolves through those same named colors so output is byte-identical
  (C1, M3).
- **The context-sensitive panel border.** `panelBorderColor(ctx)` is behavior (failed→red;
  kind-driven; else blue), not a single color. It is preserved as context logic; only its
  per-context color is themed (C2).
- **Token coverage.** Every helper the migration delegates now has a token home, including
  `kind`, `availability`, `stale`, and the unclassified row-count signal (M1).
- **Location taxonomy.** Location is a call-site property, not a property of the module a
  helper lives in; each renderer declares its location (M2).

Two implementation details remain deliberately deferred to the plan as verification gates:
(1) the interaction of background-fill styles with cli-table3 cell truncation, and
(2) the exact truecolor fallback behavior on the minimum-supported terminal (color level 1,
including the level-1 exact-byte match the suite pins). Neither blocks the architectural
decisions here.

## Research question

How can orc-smash move from its current hardcoded, globally shared color helpers to a
system that:

- defines color **by semantic role** in a single configuration file;
- allows the same semantic role to resolve to **different styles per location** (the status
  panel, the shared `terminal-accent` accents, the `--plain` timeline, and terminal
  logging);
- supports a **richer palette than today**, including a new **orange** and **background-fill**
  styles (e.g. an "implementer" role rendered as backlight green with black text); and
- produces a more aesthetically pleasing, less monochrome result than the current design,
  which leans heavily on a single shade of cyan/green?

## Executive conclusion

Introduce a three-layer theming system:

1. **Semantic tokens** — color is expressed by meaning (`role.implementer`, `result.fail`,
   `emphasis.identity`, …), never by raw color, at every call site.
2. **Style specs** — each token resolves to a spec of `{ fg, bg, bold, dim, underline,
   inverse }`, where `fg`/`bg` may be a **chalk built-in named color** (`cyan`, `yellow`, …),
   a named hue resolved through the `colors:` table, or a truecolor hex `#rrggbb`. This is
   the layer that adds orange and background fills.
3. **Per-location themes** — a YAML config (`config/theme.yaml`) maps tokens to specs under a
   `defaults` block, with optional per-location overrides (`status-panel`,
   `terminal-accent`, `plain-timeline`, `log`) that inherit and override.

A new `src/theme.ts` loads and validates the file (mirroring the existing `src/config.ts`
zod pattern, but with its own precedence and module-load-isolation decisions — see
*Module architecture*), exposes `resolveStyle(token, location) -> chalk`, and the existing
`terminal-accent.ts` helpers are refactored to delegate to it. **Location is passed at the
call site**: each helper gains an optional `location` argument (defaulting to the shared TUI
location) so existing single-arg callers and unit tests keep working unchanged, while the
status panel, `--plain` timeline, and event renderer pass their own location. The
context-sensitive `panelBorderColor(ctx)` is **kept as-is** — the theme only resolves the
per-context color name it returns.

The migration lands as a no-op first step: a `config/theme.yaml` whose `defaults`
reproduce today's exact colors using chalk's built-in named colors (so the output is
byte-identical and the existing `status-panel`/`terminal-accent` byte-and-name assertions
stay green). The new palette then lands as scoped per-location overrides with zero risk to
other renderers.

## Current implementation

All color is hardcoded in `src/terminal-accent.ts` as a set of shared helper functions, each
returning a chalk formatter (or, for `panelBorderColor`, a color *name* consumed by boxen):

- `roleAccent`, `kindAccent`, `statusAccent`, `resultAccent`, `emphasisAccent`,
  `availabilityAccent`, `unclassifiedAccent`, `staleAccent`, `eventLevelAccent`,
  `panelBorderColor`.

**Every color in use today is a chalk built-in named color** — cyan, green, red, yellow,
magenta, gray, blue — composed with `bold`/`dim`. There is no truecolor/hex, no background
fill, and no orange. This matters for verification: the test suite pins the exact 16-color
ANSI bytes these named colors emit (see *Verification implications*), so any baseline must
reproduce the *named colors*, not approximate them from hex.

The palette is small — **seven named chalk colors plus `bold`/`dim`**:

| Hue | Used for |
| --- | --- |
| cyan | identity headers (bold), binding text, `auditor` role, audit/evaluate kinds, **column headers** (`head: ['cyan']` in cli-table3) |
| green | `(recommended)`, pass results, `implementer` role, implement/task kinds |
| red | fail results, `failed` status, failed-step panel border |
| yellow | warnings, warn results, `planner` role, `running` status, follow-up/repair kinds |
| magenta | `reviewer` role, `interrupted` status |
| gray | unknown role, `done` status |
| blue | panel border (default) |
| dim | supporting/placeholder text, whole-row dimming of unrelated rows |

Two structural problems follow from this:

1. **The helpers are shared, not panel-scoped.** Every helper the status panel uses (except
   `panelBorderColor`) is imported by other renderers:

   | Helper | Also imported by |
   | --- | --- |
   | `emphasisAccent` | `interactive.ts`, `cli-output.ts`, `project-snapshot-renderer.ts` |
   | `resultAccent` | `cli-output.ts`, `plain-render.ts`, `project-snapshot-renderer.ts` |
   | `roleAccent` | `plain-render.ts` |
   | `statusAccent` | `plain-render.ts` |
   | `kindAccent` | `plain-render.ts` |
   | `panelBorderColor` | (status panel only) |

   Changing any shared helper to restyle the panel therefore also restyles the interactive
   menu headers, the ora spinner messages, the `--plain` timeline, and the `orc status`
   snapshot. **Panel-only color changes are impossible today** (except for the border).

2. **A single hue is spread across unrelated semantics.** Cyan alone is the identity header,
   the binding text, the `auditor` role, the audit/evaluate kinds, and the column headers;
   green is `recommended`, pass, `implementer`, and implement/task. There is no per-hue knob,
   and two of those cyan usages are not even in `terminal-accent.ts`: the column headers
   (`status-panel.ts` `head: ['cyan']` style literal) and the border (`panelBorderColor`,
   which is *context-sensitive*, not a flat color — see below).

`panelBorderColor(ctx)` is worth calling out explicitly because it is **not** a single color
it returns a color *name* (`'cyan' | 'yellow' | 'green' | 'red' | 'blue'`) chosen by context:
failed → `red`; in-flight or last-relevant-step → a **kind-driven** color
(audit/evaluate→cyan, follow-up/repair→yellow, implement/task→green); otherwise `blue`. That
name is handed to boxen's `borderColor` (`status-panel.ts:194`), which emits the chalk codes.
This is deliberate, tested UX behavior (a red border on failure), and the design must
preserve its context logic rather than flatten it to one token.

Config loading already follows a reusable pattern (`src/config.ts`): YAML files under
`config/`, parsed with the `yaml` package and validated by strict zod schemas with
`superRefine` cross-field checks, with a documented precedence (`--config <path>` →
project-local `.orc-smash.yaml` → packaged `config/`). The theme system mirrors the *shape*
of this pattern (YAML + strict zod + packaged→local precedence), with its own scoping
decisions called out in *Module architecture*.

## Technical enablers

### chalk (already a dependency, v5)

chalk composes styles and supports everything the design needs:

- **built-in named colors** and bright variants (`cyan`, `green`, `redBright`, …) — these
  emit the standard 16-color SGR codes (`[36m` for cyan) that today's tests pin. The
  baseline uses these directly so it is byte-identical to today;
- **truecolor** via `chalk.hex('#rrggbb')` and `chalk.rgb(r,g,b)` — used for the new, richer
  palette only;
- **background** via `chalk.bgName`, `chalk.bgHex('#rrggbb')`, `chalk.bgRgb`;
- modifiers: `bold`, `dim`, `italic`, `underline`, `inverse`, `strikethrough`;
- composition by chaining, e.g. `chalk.bgHex('#3fb950').hex('#000000').bold()` is exactly
  "backlight green with black text";
- automatic **color-level detection** (0 none / 1 sixteen-color / 2 256 / 3 truecolor) with
  graceful degradation — a hex spec is approximated to the nearest supported color on lower
  levels; a named color stays a named color. The project already relies on this auto-detection
  (it sets no level explicitly and honors `--plain`/non-TTY).

### Truecolor adoption

24-bit color is now effectively universal: Linux terminals since ~2014, Windows since ~2016,
and recent macOS Terminal.app releases ship truecolor support. chalk's auto-detection
(`COLORTERM=truecolor`, escape probing) means a truecolor-first palette works everywhere
modern and degrades acceptably on legacy terminals. This justifies hex as the specification
form for the *new* palette, with chalk's built-in named colors retained as the byte-identical
baseline form and as convenient aliases.

### Accessibility

Truecolor enables controlled contrast, which matters most for background-fill styles: a
backlight fill must pair a background with a foreground that clears a sane contrast ratio
(black-on-green, white-on-red). Color must never be the sole encoder of meaning — the panel
already pairs every color with a text label or symbol (`auditor`, `failed`, `*`, `—`), so the
design must preserve that rather than encode state in color alone (important for color-blind
users and for the `--plain` no-color path).

## Proposed design

### Layer 1 — Semantic token catalog

All color decisions are made by naming a token from a fixed catalog. Tokens are grouped by
domain. Every helper the migration delegates has a home here:

- `role.{auditor,planner,reviewer,implementer,unknown}` — `roleAccent`
- `kind.{audit,follow-up,implement,evaluate,repair,task}` — `kindAccent` (today audit/evaluate
  share cyan, follow-up/repair share yellow, implement/task share green; the catalog keeps them
  distinct so they can diverge later)
- `status.{running,failed,done,interrupted}` — `statusAccent`
- `result.{pass,fail,warn,neutral}` — `resultAccent`; the domain result states
  (accepted/completed/approved/retry/failed/rejected/blocked/unknown/interrupted/valid) map to
  these four buckets by the existing `toResultState` switch, which stays in code (behavior, not
  style)
- `emphasis.{identity,binding,supporting,placeholder,recommended,warning}` — `emphasisAccent`
  (`binding` is the token for today's `binding-identity` enum value)
- `availability.{available,unavailable,missing-inputs}` — `availabilityAccent`
- `stale.{stale,fresh}` — `staleAccent`
- `unclassified.{attention,idle}` — `unclassifiedAccent(count)`: the **row-count** attention
  signal (`count > 0` → `attention`, else `idle`). This is deliberately **distinct from any
  status**: there is no `status.unclassified` status (the four real statuses are
  running/failed/done/interrupted), and `unclassified` is a *relevance/count*, not a step
  status. Keeping it in its own group removes the phantom `status.unclassified` token.
- `panel.title`, `panel.column_header`, `panel.dim_row` — panel chrome text
- `panel.border.{failed,audit,evaluate,follow-up,repair,implement,task,default}` — the
  **per-context** border colors. `panelBorderColor(ctx)` keeps its context logic (which path
  fires) and resolves *only* the color for the selected context through these tokens. Each
  resolves to a chalk built-in named color so boxen's `borderColor` accepts it and the
  byte/name assertions stay green (see C2).
- `log.{fail,warn,pass,info}` — `eventLevelAccent`

Tokens are validated against this catalog by the schema, so a typo is a config error, not a
silent unstyled cell. Unknown tokens fail closed at load time.

### Layer 2 — Style spec

A token resolves to a style spec:

```text
{ fg?: <color>, bg?: <color>, bold?: bool, dim?: bool, underline?: bool, inverse?: bool }
```

where `<color>` is one of:

- a **chalk built-in named color** — `cyan`, `yellow`, `magenta`, `green`, `red`, `blue`,
  `gray`, and their `*Bright` variants. This is the byte-identical baseline form: `{ fg: cyan }`
  resolves to `chalk.cyan` → `[36m`, exactly what today's code emits;
- a **named hue** resolved through the `colors:` table (which itself points at a named chalk
  color or a hex) — the indirection layer that lets the rich palette rename a hue in one place;
- a **literal `#rrggbb`** truecolor hex — used for new hues (orange) and precise tuning.

Examples:

- `{ fg: cyan }` — plain cyan text (byte-identical to today's cyan usage).
- `{ fg: "#e06c75", bold: true }` — truecolor red, bold.
- `{ bg: green, fg: black, bold: true }` — backlight green with black text (the implementer
  hero treatment).
- `{ dim: true }` — no hue, just dimmed (supporting text).
- `{}` — empty spec; the identity formatter (uncolored), used for `result.neutral` /
  `availability.available` / `stale.fresh`.

### Layer 3 — Per-location theme file (`config/theme.yaml`)

The file has two roles across the migration: a **baseline** (step 1, byte-identical to today)
and a **rich palette** (step 2, the new look). Both use the same schema; they differ only in
the resolved colors.

#### Step-1 baseline (reproduces today exactly — byte-identical)

The baseline uses chalk built-in named colors directly, so it emits today's exact ANSI bytes
and keeps every existing assertion green. No `colors:` aliases are needed because every hue is
a chalk built-in; `colors:` is reserved for the hex aliases introduced in step 2.

```yaml
# Step 1 — no-op baseline. Every color is a chalk built-in named color, so output is
# byte-identical to today and the status-panel / terminal-accent assertions stay green.
defaults:
  role:
    auditor:     { fg: cyan }
    planner:     { fg: yellow }
    reviewer:    { fg: magenta }
    implementer: { fg: green }
    unknown:     { fg: gray, dim: true }
  kind:
    audit:       { fg: cyan }
    evaluate:    { fg: cyan }
    follow-up:   { fg: yellow }
    repair:      { fg: yellow }
    implement:   { fg: green }
    task:        { fg: green }
  status:
    running:     { fg: yellow }
    failed:      { fg: red }              # today: chalk.red (no bold)
    done:        { fg: gray }
    interrupted: { fg: magenta }
  result:
    pass:    { fg: green }
    fail:    { fg: red }
    warn:    { fg: yellow }
    neutral: {}
  availability:
    available:      {}
    unavailable:    { dim: true }
    missing-inputs: { fg: yellow }
  emphasis:
    identity:    { fg: cyan, bold: true }
    binding:     { fg: cyan }
    supporting:  { dim: true }
    placeholder: { dim: true }
    recommended: { fg: green }
    warning:     { fg: yellow }
  unclassified:
    attention: { fg: yellow }
    idle:      { dim: true }
  stale:
    stale: { fg: yellow }
    fresh: {}
  panel:
    title:         { fg: cyan, bold: true }   # today the title routes through emphasis.identity
    column_header: { fg: cyan, bold: true }   # reproduces cli-table3 head: ['cyan']
    dim_row:       { dim: true }
    border:
      failed:    { fg: red }
      audit:     { fg: cyan }
      evaluate:  { fg: cyan }
      follow-up: { fg: yellow }
      repair:    { fg: yellow }
      implement: { fg: green }
      task:      { fg: green }
      default:   { fg: blue }
  log:
    fail: { fg: red }
    warn: { fg: yellow }
    pass: { fg: green }
    info: { fg: cyan }

status-panel: {}      # inherits defaults → byte-identical to today
terminal-accent: {}   # inherits defaults
plain-timeline: {}    # inherits defaults
log: {}               # inherits defaults
```

> Every baseline token above is matched to today's exact chalk chain (e.g. `status.failed` is
> `chalk.red`, not bold; `emphasis.identity` is `chalk.bold.cyan`). The before/after snapshot
> test is the proof: any token whose resolved bytes diverge from today is corrected in step 1 so
> the baseline stays byte-identical.

#### Step-2 rich palette (the new look)

```yaml
colors:
  teal:   "#4cc4d6"
  amber:  "#e5c07b"
  orange: "#ff8c42"      # NEW
  red:    "#e06c75"
  green:  "#3fb950"
  purple: "#c678dd"
  blue:   "#61afef"
  gray:   "#7f898f"

defaults:
  role:
    auditor:     { fg: teal }
    planner:     { fg: amber }
    reviewer:    { fg: purple }
    implementer: { fg: green }
    unknown:     { fg: gray, dim: true }
  kind:
    audit:       { fg: teal }
    evaluate:    { fg: teal }
    follow-up:   { fg: amber }
    repair:      { fg: amber }
    implement:   { fg: green }
    task:        { fg: green }
  status:
    running:     { fg: amber }
    failed:      { fg: red, bold: true }
    done:        { fg: gray }
    interrupted: { fg: purple }
  result:
    pass:    { fg: green }
    fail:    { fg: red }
    warn:    { fg: orange }     # was yellow; orange reads as "attention"
    neutral: {}
  availability:
    available:      {}
    unavailable:    { dim: true }
    missing-inputs: { fg: orange }
  emphasis:
    identity:    { fg: orange, bold: true }   # was bold cyan — breaks the cyan monoculture
    binding:     { fg: blue }
    supporting:  { dim: true }
    placeholder: { dim: true }
    recommended: { fg: green }
    warning:     { fg: orange }
  unclassified:
    attention: { fg: orange }
    idle:      { dim: true }
  stale:
    stale: { fg: orange }
    fresh: {}
  panel:
    title:         { fg: orange, bold: true }
    column_header: { fg: teal, bold: true }   # replaces the hardcoded head: ['cyan']
    dim_row:       { dim: true }
    border:
      failed:    { fg: red }
      audit:     { fg: teal }
      evaluate:  { fg: teal }
      follow-up: { fg: amber }
      repair:    { fg: amber }
      implement: { fg: green }
      task:      { fg: green }
      default:   { fg: blue }
  log:
    fail: { fg: red }
    warn: { fg: orange }
    pass: { fg: green }
    info: { fg: teal }

# Per-location overrides (inherit defaults, override specific tokens).
status-panel:
  role:
    implementer: { bg: green, fg: black, bold: true }   # backlight-green hero
  panel:
    border:
      default: { fg: orange }   # panel default border becomes orange in the rich palette

terminal-accent:
  # Shared TUI accents (interactive menu, ora spinner, snapshot). Inherits defaults;
  # override individual tokens here to diverge.

plain-timeline:
  # The --plain status timeline (plain-render.ts). Inherits defaults.

log:
  # Structured event rendering (plain-event-renderer.ts). Inherits defaults.
```

Two notes on the rich palette's border tokens. First, the per-context `panel.border.*`
tokens are still **selected by `panelBorderColor(ctx)`'s context logic** — the rich palette
only changes which *color* each context resolves to; the failed→red override and the
kind→color mapping are unchanged in behavior. Second, boxen's `borderColor` accepts chalk
built-in named colors directly; for hex border colors the loader maps the resolved spec to
the nearest boxen-supported name (or boxen's hex support, if available in the pinned
version) — the plan confirms which.

### Resolution algorithm

`resolveStyle(token, location)` walks **location override → defaults**, first match wins, and
returns a built chalk chain (cached by resolved spec so hot paths like the live panel do not
rebuild chains per cell). Unknown tokens fail closed at config-load time (zod error), never
silently unstyled.

There are two resolution shapes:

- **Cell text** (`role`, `kind`, `status`, `result`, `emphasis`, `availability`, `stale`,
  `unclassified`, `panel.title/column_header/dim_row`, `log.*`) → a chalk chain applied to
  text.
- **Border** (`panel.border.*`) → a color *name* (chalk built-in named color) handed to
  boxen's `borderColor`. `panelBorderColor(ctx)` runs first to pick the context (failed /
  in-flight-kind / historical-kind / default), then resolves that context's token to the
  name. This preserves both the failed→red contract and the byte/name assertions.

At color level 0 (`--plain`/non-TTY), `resolveStyle` returns the identity formatter, matching
today's `--plain` behavior. Named-color specs stay named colors at every level (so the
baseline is byte-identical at level 1 too); hex specs approximate downward.

### Why this is more aesthetically pleasing

- **Cyan is demoted.** It stops being the identity/binding/header/auditor/kind color
  simultaneously and becomes `teal`, scoped to `auditor`, the audit/evaluate kinds, and
  `log.info`. Headers move to **orange**, which is focal and warm and was entirely absent.
- **Orange is added** as a first-class hue for attention semantics (warn, warning,
  unclassified, stale, missing-inputs) and the panel title — the load-bearing "look at this"
  color, replacing the overloaded yellow+cyan.
- **Each role gets a distinct hue**: teal / amber / purple / green, so the Role column reads
  as four clearly different colors instead of four shares of two.
- **One hero background** — `implementer` as backlight green with black text — gives the
  "active actor" a physical, badge-like presence without flooding the table with fills
  (backgrounds are reserved; the rest stays foreground-only).
- **Truecolor hex** makes the palette consistent across terminals instead of depending on
  whatever the local 16-color palette happens to be.

The exact hues above are a defensible starting point; because they live in config, tuning them
later is a one-file edit with no code change.

### Module architecture

- **New `src/theme.ts`** — owns the zod schema for `config/theme.yaml`, the loader, the token
  catalog, the `colors:` name resolution, the style-spec → chalk builder (and the border
  spec → boxen color name), the per-cell cache, and the `resolveStyle(token, location)` entry
  point. It honors `--plain`/non-TTY by returning the identity formatter at color level 0.

  *Mirroring `config.ts`, scoped.* The theme loader reuses the *shape* of `config.ts` (YAML +
  strict zod + `superRefine`), not its registry machinery. Specifically it must (a) make its
  own precedence decision — whether to support a `--theme <path>` flag and/or a project-local
  `.theme.yaml` override above the packaged `config/theme.yaml` (config.ts has a `--config`
  tier; the plan decides the theme equivalent), and (b) avoid `config.ts`'s trap of loading at
  **module-load time** (`DEFAULT_REGISTRY` is built at import in `config.ts:168`). The theme
  must be loadable on demand in tests (so a test can swap a fixture `theme.yaml` without
  process-wide side effects), reusing the module-load-isolation patterns already in
  `tests/config.test.ts`.

- **Refactor `src/terminal-accent.ts`** — each helper delegates to `resolveStyle(token,
  location)` instead of hardcoding chalk. **Location is a call-site property**: helpers gain
  an optional trailing `location` argument defaulting to the shared TUI location
  (`'terminal-accent'`), so existing single-arg callers and the `terminal-accent.test.ts` unit
  tests keep working unchanged. `terminal-accent` is a **location name**, not synonymous with
  the module.

- **`src/status-panel.ts`** — resolves its cell colors through `resolveStyle(...,
  'status-panel')` (passing the location explicitly at each call site). This is the location
  override that finally isolates panel colors. The hardcoded `head: ['cyan']` cli-table3 style
  is replaced by applying `panel.column_header` to the header cells. `panelBorderColor(ctx)`
  **stays context-sensitive**: its context logic is unchanged, and it resolves the selected
  context's `panel.border.*` token to a boxen color name. (See C2.)

- **`src/plain-render.ts`** (the `--plain` status timeline) resolves through
  `resolveStyle(..., 'plain-timeline')`.

- **`src/plain-event-renderer.ts`** (structured event log) resolves through
  `resolveStyle(..., 'log')`. Its `eventLevelAccent(level)` helper lives in `terminal-accent.ts`
  but gains a `location` argument defaulting to `'log'` (its domain), so it is no longer
  forced to inherit the module's location — removing the "one helper, two locations"
  contradiction.

- **`cli-output.ts`** (ora spinner / live run output) and **`project-snapshot-renderer.ts`**
  (`orc status` snapshot) resolve through `resolveStyle(..., 'terminal-accent')`, as does
  **`interactive.ts`** (inquirer menu headers).

Declared location map:

| Renderer / call site | Location |
| --- | --- |
| `status-panel.ts` (cells, header, border) | `status-panel` |
| `interactive.ts`, `cli-output.ts`, `project-snapshot-renderer.ts` | `terminal-accent` |
| `plain-render.ts` (`--plain` timeline) | `plain-timeline` |
| `plain-event-renderer.ts` (event log) | `log` |

No generic pipeline, runner, provenance, or adapter module needs to branch on color; the
change is contained to the rendering layer.

## Migration path (low-risk, incremental)

1. **No-op baseline.** Add `src/theme.ts` and the step-1 `config/theme.yaml` shown above
   (chalk built-in named colors, reproducing today exactly). Refactor `terminal-accent.ts` to
   delegate, giving each helper an optional `location` arg (default `'terminal-accent'`); have
   the status panel pass `'status-panel'`, `plain-render.ts` pass `'plain-timeline'`, and
   `plain-event-renderer.ts` pass `'log'` (one-line wiring edits — no behavior change, since
   every location's baseline inherits the same `defaults`). Output is byte-identical; all
   existing tests stay green (the `status-panel` byte assertions, the `panelBorderColor` name
   assertions, and the `terminal-accent` strip-ANSI assertions all still hold). This proves the
   plumbing. **Proof:** `pnpm test status-panel terminal-accent` green, and a before/after
   snapshot of the status panel and the `--plain` timeline is byte-identical.
2. **New palette as overrides.** Flip `defaults`/`status-panel` to the richer palette above
   (orange, demoted cyan, distinct role hues). This *does* change the pinned bytes by design —
   it is the planned visual change — so the `status-panel` byte/name assertions are updated in
   this step as an acknowledged, enumerated edit (not a surprise). The change is scoped and
   reversible by editing one YAML file.
3. **Background hero.** Enable the `status-panel.role.implementer` backlight treatment and
   verify it against cli-table3 truncation (see Risks).

## Risks and mitigations

- **Background fills vs cli-table3 truncation.** cli-table3 truncates cells with `slice-ansi` /
  `cli-truncate`, which preserve ANSI codes across the cut but do **not** themselves emit a
  background reset. The bleed risk is a **dangling SGR sequence straddling the slice boundary**:
  a background-fill cell that is truncated mid-style can leave the background active past the
  cut, bleeding into the separator or next column. *Mitigation:* verify with a fixture row whose
  implementer cell exceeds its column width; if bleeding occurs, append an explicit reset at
  each styled-cell boundary, or restrict background fills to columns that never truncate
  (Role/Status). This is verification gate #1.
- **Truecolor on legacy terminals.** chalk approximates hex to the nearest 256/16 color; on a
  truly monochrome terminal (level 0) everything collapses to plain text. Named-color specs
  (the baseline) are unaffected — they stay named colors at every level, so the byte-identical
  baseline holds at level 1. *Mitigation:* acceptable for the rich palette — it matches today's
  `--plain` path — but the plan should confirm the `orange`/`purple`/`teal` hex approximations
  are still distinguishable at level 2, and re-confirm the **level-1 exact-byte match** for the
  baseline (the named-color path). Verification gate #2.
- **Config surface growth.** More knobs can drift. *Mitigation:* strict zod validation of
  tokens, colors, and specs; unknown keys rejected; a single canonical `config/theme.yaml`.
- **Color-blind safety.** Adding hues must not make color the sole encoder. *Mitigation:* keep
  the existing text labels and symbols on every colored cell; never drop a label in favor of
  color alone.
- **Per-location divergence confusion.** The same token meaning two colors in two places could
  surprise. *Mitigation:* `defaults` holds the canonical mapping; locations only override where a
  deliberate reason exists (documented inline in the YAML).
- **Module-load side effects.** Loading the theme at import time (as `config.ts` loads
  `DEFAULT_REGISTRY`) would make tests process-global and brittle. *Mitigation:* load on demand;
  reuse the `tests/config.test.ts` isolation patterns (see *Module architecture*).

## Verification implications

Deterministic tests can prove:

- config load + strict validation (good and bad `config/theme.yaml` fixtures, reusing the
  project's existing config-test patterns, including module-load isolation);
- token resolution order (location override beats defaults; unknown token rejected at load);
- style-spec → chalk correctness for **named chalk colors** (assert the exact 16-color bytes,
  e.g. `{ fg: cyan }` → `[36m`), hex, background, and composed specs;
- **the no-op baseline is byte-identical** to today's renderers — snapshot the status panel
  **and** the `--plain` timeline before and after step 1, and assert identical bytes (this is
  the gate that closes C1 and M3 together: both output paths use named chalk colors, so the
  pinned `status-panel.test.ts:112-132` byte assertions and the `--plain` chalk output both
  hold);
- **the panel border stays correct** — `tests/terminal-accent.test.ts` (the `panelBorderColor`
  name assertions, incl. failed→red and historical-failure) and `tests/status-panel.test.ts`
  (the border byte assertions) remain green after step 1 without weakening the failed→red
  contract (closes C2);
- `--plain` / color-level 0 returns uncolored output — tested as a **renderer path**
  (`plain-render.ts` still calls chalk formatters; `--plain` is selected at `cli.ts`, not solely
  by `chalk.level`), so test the path, not just the level;
- the implementer backlight cell truncates without background bleed (gate #1, mechanism above).

A manual visual check on at least one truecolor and one 256-color terminal covers gate #2 and
the overall aesthetics; this is not automatable.

## Out of scope

- Theming the inquirer picker widget itself (selected-row highlight, pointer, spinner). That is
  inquirer's own default theme, separate from `terminal-accent`; wiring it to this palette is a
  follow-up.
- Changing layout, column widths, truncation rules, or any non-color rendering behavior.
- Runtime theme hot-reload or per-user theme discovery beyond the documented config precedence.
- Migrating the helpers' **semantics** away from their current meaning — `eventLevelAccent`,
  `unclassifiedAccent(count)`, and `staleAccent` fold into the token catalog but keep their
  meaning (event level, row-count attention, staleness). Only their *colors* become
  configurable; the behavioral switches (`toResultState`, `panelBorderColor`'s context logic)
  stay in code.
- Introducing a light-mode / terminal-background-aware theme (the design does not preclude it,
  but auto-detecting light vs dark terminals is not part of this work).
