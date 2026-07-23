---
status: done
date: 2026-07-22
scope: operator-surface-semantics-and-prompt-contracts
confidence: 0.96
---

# Plan: Shared terminal semantics and inspectable prompt contracts

## Goal

Make every operator-facing surface easier to scan and make the configured
execution model inspectable before a run starts.

This plan has two related outcomes:

1. Introduce one shared semantic colour vocabulary for the interactive startup
   snapshot, interactive menus, the live ORC SMASH status panel, detailed
   project status, and plain-mode event output.
2. Extend **Display pipeline and project state** and `orc status` with a
   manifest-derived prompt contract for every configured loop and task. The
   contract shows how a prompt is assembled—role, skill, ordered inputs, target,
   output and validation—without printing the full role or skill contents.

Colour remains an enhancement rather than a source of truth. Every decision,
status, warning and unavailable reason must remain understandable after ANSI
codes are removed and when colour is disabled.

## Design decisions

The following decisions are normative for this plan and are audited as part of
the plan itself. This pipeline has no research stage, and a separate
`docs/dev/research.md` is not an execution or approval prerequisite.

- **Operator scanability (one shared vocabulary).** Every operator-facing
  surface should use one semantic colour vocabulary so status, warnings,
  results, and unavailability read consistently. Colour is enhancement; text is
  authoritative. *Rejected alternative:* a parallel per-renderer colour
  vocabulary.
- **Colour-off and redirected-output requirement.** Output must stay complete
  and understandable with ANSI stripped and colour disabled: the plain event
  writer emits zero ANSI when colour is unsupported (`NO_COLOR=1`, non-TTY, or
  piped), and the panel/interactive surfaces honour Chalk's terminal detection.
  *Rejected alternatives:* forcing a global Chalk level in production; injecting
  ANSI into redirected/log-file output.
- **Prompt-contract redaction (recipe, not dump).** Project status shows the
  prompt *recipe* — role/skill identity, ordered inputs, output contract — and
  never the role/skill/target/prior-artifact *contents*. Prompt-contract view
  construction and rendering perform no filesystem reads and never call
  `prompt-composer.ts`; the builder's only filesystem read is the pre-existing
  target-fingerprint computation (see B5d). *Rejected alternatives:* printing the
  composed prompt or any source file contents in `orc status`.
- **Generic manifest compatibility.** Prompt contracts and binding ordering
  must render in manifest declaration order for *any* valid v1 manifest ID,
  including integer-like IDs, so the feature is not coupled to this repository's
  binding names. *Rejected alternative:* relying on JavaScript object-key
  enumeration order.
- **No hidden execution dependencies.** Every configured `files:` mapping must
  be a declared input so the displayed prompt contract is the complete set of
  inputs the run actually consumes. *Rejected alternative:* allowing
  non-input `files:` keys that block a run without appearing in the contract.
- **Operator-menu and lifecycle boundaries preserved.** Do not fork or replace
  Inquirer, do not adopt a new TUI library, and do not change the
  alternate-screen lifecycle, event ordering, runner resolution, ownership
  admission, or prompt composition. *Rejected alternatives:* restyling by
  replacing the prompt/menu libraries or the panel lifecycle.

## Current state and problem

- `src/status-accent.ts` owns role, step-kind, lifecycle-status and panel-border
  colours, but these semantics are not shared by all operator surfaces.
- `src/project-snapshot-renderer.ts` renders compact and detailed snapshots
  without semantic colour hierarchy.
- `src/interactive.ts` renders recommended and unavailable menu choices without
  consistent accents.
- `src/plain-render.ts` already applies some status accents, but it must use the
  same vocabulary as the other surfaces rather than developing a parallel one.
- The detailed project snapshot shows bindings, artifact history and pipeline
  candidates, but it does not show the declarative execution contract that
  produces a prompt.
- The canonical prompt is assembled by `src/prompt-composer.ts` as
  `Role content -> Skill content -> ordered Inputs`. The status view should
  explain that recipe from the manifest; it must not reimplement prompt
  composition or claim that unresolved runtime values are resolved.

## Owned output surfaces (inventory)

Every operator-facing terminal surface orc-smash owns must consume the shared
semantic accent source. The inventory below is exhaustive; an unconverted owned
surface fails CI. It is grouped by the live path that produces each surface.
The "exhaustive surface coverage" test in the Verification strategy enumerates
this list verbatim.

**Interactive panel path — `createPanelCliOutput` (`src/cli-output.ts`)**, the
default TTY experience. Every one of these applies Chalk *directly* today and
must be routed through `src/terminal-accent.ts`, colouring only orc-smash-owned
prefixes/labels/semantic tokens — never raw agent payloads:

- `note` → `chalk.gray` (`cli-output.ts:124`)
- `warn` → `chalk.yellow` (`:129`)
- `error` → `chalk.red` (`:138`; also the pending-failure flush at `:191`)
- `stepStarted` → `ora(chalk.blue(...))` spinner (`:155`)
- `stepSucceeded` → `chalk.green` (`:160`, `:164`, `:167`)
- `stepFailed` → `chalk.red` (`:177`, `:180`)
- `finalSummary` → Harness Event Log header `chalk.cyan` (`:196`) and event
  lines `chalk.gray` (`:198`), success `chalk.bold.green` (`:204`), failure
  `chalk.bold.red` (`:206`), snapshot `chalk.cyan`/`chalk.gray` (`:209–210`)

Spinner lifecycle, alternate-screen enter/exit, pending-failure buffering, and
Harness Event Log **ordering and structure are unchanged** — only the semantic
accent source changes.

**Plain event path — `createPlainCliOutput` (`src/cli-output.ts`)**, the
`--plain` experience:

- `createPlainCliOutput.renderPanel` is intentionally a **no-op**
  (`cli-output.ts:290–292`); panel snapshots are replaced by chronological
  events. It is **not** a styled surface.
- The real `--plain` dispatch is `createPlainCliOutput.emit` →
  `renderRunEvent` → `EventWriter.write` (`src/plain-event-renderer.ts`).
- `renderRunEvent` is currently **colourless by design** (no chalk import). A5
  *introduces* conditional colouring there, gated on colour support and guarded
  by the non-TTY zero-ANSI test. `EventWriter`'s line ordering is unchanged.

**Auxiliary plain-snapshot renderer — `renderPlainPanel`
(`src/plain-render.ts`)**:

- `renderPlainPanel` has **no `src/` callers**; it is a utility renderer for
  non-TTY/plain snapshot rendering and tests, already applying
  `kindAccent`/`roleAccent`/`statusAccent` (`plain-render.ts:96–102`, `:130`).
- **Decision:** it is a *supported auxiliary surface* (it ships in the package
  and emits accents) and must be reconciled to the shared vocabulary and kept
  colour-off-safe. The earlier framing that treated it as *the* plain-mode
  surface is corrected: the live plain surface is `renderRunEvent`, not
  `renderPlainPanel`.

**Interactive prompts and detail views (`src/interactive.ts`)**:

- `formatMenuChoice` (`interactive.ts:7`) builds Inquirer choice names; A3
  reconciles it and consumes the typed availability field from Major 1.
- The task-detail block writes directly via `console.log` (`interactive.ts:87–95`).
- Runner selection (`promptRunners`, `interactive.ts:176+`) writes "Default
  skill runners" and per-line detail via `console.log` (`:199`, `:204`) and
  builds effort/session choices through `formatMenuChoice` (`:288–325`).

These direct writes must be reconciled to the shared vocabulary (owned
labels/metadata only), and the typed availability field must drive disabled
category styling in both the action menus and the `promptRunners` choices.

**Snapshot renderers (`src/project-snapshot-renderer.ts`)**:
`renderCompactSnapshot` (A2) and `renderDetailedSnapshot` (A6 + Workstream B).

**Live status panel (`src/status-panel.ts`)**: `renderStatusPanel` and
`renderTimelineSection` (A4). `renderTimelineSection` currently has **inline**
  result colouring (`status-panel.ts:119–127`: accepted/completed→bold green,
  retry→bold red, blocked→bold yellow, falsy→empty); A4 moves this to the shared, exhaustive
  `resultAccent`.

## Design principles

1. **One meaning, one accent.** The same semantic state uses the same accent in
   every surface.
2. **Text remains authoritative.** Do not replace labels, decisions, reasons or
   symbols with colour-only indicators.
3. **Warnings remain prominent.** Missing inputs, non-zero unclassified counts,
   failures and blocked states must not be dimmed as secondary detail.
4. **No forced colour.** Respect Chalk's terminal detection and conventional
   `NO_COLOR` behavior. Do not set a global Chalk level in production.
5. **Pure rendering.** Build display-ready view data before rendering. Snapshot
   renderers must not read files, parse YAML, or independently resolve prompt
   inputs.
6. **Manifest remains authoritative.** Role, skill, input, output and pipeline
   descriptions come from the loaded manifest and existing canonical resolver
   rules.
7. **Recipe, not prompt dump.** Do not print role/skill file contents or a large
   generated prompt in project status.
8. **Be honest about unresolved data.** Before runner selection, values such as
   `{provider}` and the final output filename may be unresolved. Show the
   configured pattern and source mapping rather than inventing a value.

---

## Workstream A: Shared semantic terminal styling

### A1. Establish a shared semantic accent module

Evolve `src/status-accent.ts` into the single source of truth for terminal
semantics. If its broader responsibility makes the current name misleading,
rename it to the precise domain name `src/terminal-accent.ts` and update all
imports. A rename must update all three test importers
(`tests/status-accent.test.ts`, `tests/status-panel.test.ts`,
`tests/loop-live.test.ts`) in the same change alongside the two source importers
(`src/plain-render.ts`, `src/status-panel.ts`). Do not create a generic
`helpers.ts`, `common.ts` or `misc.ts` module.

Retain the existing role, kind, lifecycle-status and panel-border APIs, and add
small typed APIs for result, availability and display emphasis. The exact API
shape may be adjusted during implementation, but it must provide one canonical
mapping equivalent to:

```ts
resultAccent('accepted' | 'completed' | 'retry' | 'failed' | 'blocked' | 'unknown' | 'interrupted' | 'valid')
availabilityAccent('available' | 'unavailable' | 'missing-inputs')
emphasisAccent('identity' | 'supporting' | 'placeholder' | 'recommended')
```

**Exhaustiveness requirement (Major 5).** The accent API must cover the full
domain it claims to own — it must not leave any state to ad-hoc inline colouring
elsewhere. Concretely:

- **Applicable decision** (`accepted`, `retry`, `unknown`) — consumed from
  `Step.decision`.
- **Completion** (`completed`, `blocked`, `valid`) — consumed from
  `Step.completionOutcome` and the artifact contract; `valid` (a
  contract-satisfying artifact with no explicit result) must read as neutral,
  not as a warning.
- **Lifecycle** (`running`, `done`, `failed`, `interrupted`) — replacing the
  inline `chalk.bold.green/red/yellow` result logic in
  `src/status-panel.ts:119–127` and the separate `level()` mapping in
  `src/plain-event-renderer.ts:9–30`.
- **Availability** (`available`, `unavailable`, `missing-inputs`).
- **Unclassified** (zero vs non-zero) and **stale evidence**.

`resultAccent` must therefore accept `failed` and `interrupted` (previously
omitted) in addition to `accepted`, `completed`, `retry`, `blocked`, `unknown`,
and `valid`. A state with no canonical accent is a defect: the implementation
must either map it explicitly or fail typecheck.

Required semantics:

| Meaning | Treatment | Notes |
|---|---|---|
| accepted, completed | green | Successful terminal result |
| retry, failed | red | Negative result or execution failure |
| blocked, unknown, interrupted | yellow or magenta, consistently selected | Requires operator attention |
| valid without an explicit result | neutral/default | Must not look like a warning |
| running | yellow | Active work |
| unavailable | dim | The textual reason remains visible |
| missing inputs | yellow | Actionable execution blocker; never merely dim |
| unclassified count = 0 | dim | Informational zero state |
| unclassified count > 0 | yellow | Requires inspection |
| placeholder such as `(none)` | dim | Absence without an error |
| project identity/path | bold cyan | Primary context |
| pipeline/loop/binding identity | one consistent identity accent | Do not assign arbitrary colours per renderer |
| supporting paths and metadata | dim | Config path, runner metadata, session detail |
| recommended | green or bold cyan, consistently selected | Recommendation is still stated in text |

Existing role and step-kind distinctions must remain stable unless tests and
all consuming surfaces are deliberately updated together.

### A2. Apply semantics to the compact interactive snapshot

Update `renderCompactSnapshot` in `src/project-snapshot-renderer.ts`:

- emphasize the project root as the primary identity;
- dim the config path and supporting reason text;
- accent pipeline, suggested-loop and binding identities consistently;
- apply shared result accents to evaluate, repair and task results;
- dim runner/model/effort/session metadata;
- dim `(none)` placeholders;
- render missing inputs as warnings;
- dim zero unclassified counts and warn on non-zero counts;
- add one blank line between binding blocks, with no leading or trailing blank
  block for a single binding.

Do not remove or abbreviate any currently displayed information as part of the
styling change.

### A3. Apply semantics to interactive menus

Update `formatMenuChoice` and related menu presentation in
`src/interactive.ts`:

- unavailable choices remain present and include
  `(unavailable: <reason>)`;
- unavailable choices are visually subdued without obscuring the reason;
- `(recommended)` uses the shared recommendation accent;
- enabled choices remain at normal intensity;
- colour must not change choice values, disabled state, default selection, or
  navigation behavior.

If Inquirer's own styling conflicts with pre-styled choice names, resolve the
conflict through the narrowest supported choice presentation seam. Do not fork
or replace Inquirer for this plan.

#### A3a. Typed availability category (Major 1)

The current choice model cannot deterministically distinguish an ordinary
unavailable choice (dim) from a missing-input blocker (yellow): `TopMenuAction`,
`LoopSubmenuItem`, and `TaskMenuItem` in `src/stage-menu.ts` expose only a prose
`disabledReason`, and `formatMenuChoice` (`src/interactive.ts:7`) is generic over
`{ label; disabledReason?; recommended? }`. Inferring the category from reason
text (e.g. `Missing project input...`) would make presentation depend on
diagnostic wording and breaks the typed-semantic intent.

Add a typed presentation/availability field and propagate it end to end:

- add `availability: 'available' | 'unavailable' | 'missing-inputs'` to
  `TopMenuAction`, `LoopSubmenuItem`, and `TaskMenuItem` in `src/stage-menu.ts`;
- set it in `buildTopLevelMenu`, `buildLoopSubmenu`, and `buildTaskMenu`:
  `missing-inputs` when the binding's `missingInputs`/`loopMissingInputs` is
  non-empty (today's `Missing project input...` builders), `unavailable` for
  every other disabled reason (e.g. `no loops configured`, `no in-progress
  loop`, provider-capability reasons), and `available` otherwise;
- give the effort and session-strategy choices built in `promptRunners`
  (`src/interactive.ts:288–325`) the same explicit category —
  `unavailable` for `${agent} does not support effort` /
  `does not support session resumption`, never `missing-inputs`;
- consume the field in `formatMenuChoice`: a `missing-inputs` choice is
  yellow/warning (prominent), an `unavailable` choice is dim, an `available`
  choice is normal intensity. `value`, `disabled`, default selection, and
  navigation behavior must be unchanged.

`disabledReason` text is retained verbatim for the operator and must survive
ANSI stripping; only the *category* that selects the accent is typed.

### A4. Reconcile the live status panel

Update `src/status-panel.ts` to consume the shared semantic mappings while
preserving its current layout, stage-driven border behavior, timeline data and
live refresh behavior.

- role, kind, running, done, failed and interrupted states must use the shared
  vocabulary;
- the **inline** result colouring in `renderTimelineSection`
  (`src/status-panel.ts:119–127`, which hand-maps accepted/completed→bold green,
  retry→bold red, blocked→bold yellow, falsy→empty) must be replaced by the shared,
  exhaustive `resultAccent` so every result state is decided in one place;
- border colour and active-row meaning must remain consistent;
- no panel fields may be removed;
- do not introduce a new TUI library or change the alternate-screen behavior in
  this plan.

### A5. Reconcile plain mode

Update `src/plain-render.ts`, `src/plain-event-renderer.ts`, and any narrow
shared event-formatting call sites. `src/plain-event-renderer.ts` is currently
colourless by design — it imports no chalk and emits colourless lines. A5
**introduces** conditional colouring there (gated on colour support, with the
non-TTY zero-ANSI test below as the guard). `src/plain-render.ts` already applies
accents and must be reconciled to the shared vocabulary.

Plain mode means line-oriented, durable terminal output; it does **not** mean
colourless output. Apply shared semantic accents when the output supports
colour, while preserving:

- one event per emitted line/milestone;
- existing text and event ordering;
- readable redirected/log-file output with no required ANSI interpretation;
- errors, warnings, lifecycle events and results as explicit text;
- existing logging and error-handling behavior.

Do not colour raw agent payloads or arbitrary model text. Colour only
orc-smash-owned prefixes, labels and semantic tokens.

**Surface distinction (per the inventory).** The live `--plain` dispatch is
`createPlainCliOutput.emit` → `renderRunEvent` → `EventWriter.write`
(`src/plain-event-renderer.ts`); `createPlainCliOutput.renderPanel` is a no-op.
`renderPlainPanel` (`src/plain-render.ts`) is an auxiliary utility renderer with
no `src/` callers; reconcile it to the shared vocabulary and keep it
colour-off-safe, but do not treat it as the live plain path.

**Style after layout (Minor 1).** `wrapField` (`src/plain-render.ts:18–38`) and
the timeline wrapping in `renderPlainPanel` compute visible width with string
`.length` and slice against `resolveTerminalWidth()`. Applying ANSI styling
*before* those length checks corrupts wrapping and column math. Apply accents
*after* layout, or route every visible-width calculation through an ANSI-aware
visible-width helper. The implementation must add a `COLUMNS=40`,
`chalk.level = 1` case proving the stripped lines retain the intended wrapping
and text.

### A6. Detailed status styling

Apply the same restrained semantics to `renderDetailedSnapshot`:

- section titles and configured identities may be emphasized;
- success, retry, blocked, stale, missing-input and unclassified states use the
  shared mappings;
- long supporting paths and fingerprints may be dimmed;
- content and ordering remain legible without ANSI colour.

### A7. Reconcile direct presentation writes (cli-output and interactive)

The interactive panel path (`createPanelCliOutput`, `src/cli-output.ts`) and the
interactive detail/prompt writes (`src/interactive.ts`) currently apply Chalk or
`console.*` directly, outside any shared vocabulary (see the inventory). Route
them through `src/terminal-accent.ts`:

- `note`, `warn`, `error`, `stepStarted` spinner text, `stepSucceeded`,
  `stepFailed`, and the `finalSummary` success/failure/event-log/snapshot lines
  use the shared result/warning/identity accents;
- the task-detail block (`interactive.ts:87–95`) and the `promptRunners`
  summary/detail lines (`interactive.ts:199`, `:204`) use shared identity and
  supporting accents for owned labels and metadata;
- style only orc-smash-owned prefixes/labels/tokens; never style raw agent
  payloads, model text, or operator-entered values;
- preserve spinner lifecycle, alternate-screen enter/exit, pending-failure
  buffering, Harness Event Log ordering, and all `value`/`disabled`/default
  behavior unchanged.

The newly coloured `createPanelCliOutput` writers are covered by the
`NO_COLOR=1` and piped-subprocess zero-ANSI tests in the Verification strategy.

---

## Workstream B: Manifest-derived prompt contracts

### B1. Add prompt-contract data to the snapshot view model

Extend `ProjectSnapshotView` with display-ready contract data for every loop and
task binding. The view builder may use the loaded manifest and existing input
label/resolution rules; renderers must receive already-normalized data.

Use purposeful view types equivalent to:

```ts
interface BindingInputAvailability {
  target: 'available' | 'missing';
  files: Record<string, 'available' | 'missing'>;
}

interface PromptInputContractView {
  label: string;
  source: string;
  resolutionKind: 'target' | 'runtime' | 'configured-file';
  configuredKey?: string;
  configuredValue?: string;
  status: 'available' | 'missing' | 'runtime-resolved';
  note?: string;
}

interface PromptStepContractView {
  phase: 'evaluate' | 'repair' | 'task';
  roleId: string;
  rolePath: string;
  skillId: string;
  skillPath: string;
  inputs: PromptInputContractView[];
  outputPattern: string;
  outputContract: string;
  decision?: {
    heading: string;
    accepted: string;
    retry: string;
  };
  validator?: string;
}

interface BindingPromptContractView {
  bindingId: string;
  bindingKind: 'loop' | 'task';
  targetPath: string;
  targetKind: 'file' | 'worktree';
  composition: 'Role content -> Skill content -> ordered Inputs';
  steps: PromptStepContractView[];
}
```

These are design-level shapes, not a requirement to use these exact names.
Avoid duplicating manifest parsing or the behavioral rules in
`prompt-composer.ts`. If a shared pure resolver is needed for input labels or
configured file mappings, extract the narrow domain rule and use it from both
the prompt path and snapshot-view path.

`roleId` and `rolePath` for each step are derived from the manifest as
`manifest.skills[step.skill].role` → `manifest.roles[role]`. The contract view
never invents a role independent of the manifest; `roleForKind`
(`src/state.ts:9–13`) is a fallback for synthesized/interrupted steps only and
must not be used for prompt-contract display.

Build prompt-contract views through a pure, independently-invocable helper (e.g.
`buildBindingPromptContracts(manifest, snapshot)`) so the scoped no-read test in
B5d can stub `readFileSync`/`composePrompt` around just that helper rather than
around the full `buildProjectSnapshotView` (which performs the pre-existing
fingerprint read).

#### B1a. Manifest completeness: no hidden file dependencies (Major 2)

Today `V1ManifestSchema` permits a `files:` key that is never referenced by any
entry in `inputs` (`FilesSchema`/`FileMapValueSchema` at `src/manifest.ts:56–57`;
the binding schemas reference `files:` at `:88–108`; `validateInputSource` at
`:314–327` only checks the converse). Yet every configured file is consumed at execution:
`buildInputFingerprint` digests `binding.files` wholesale
(`src/loops/binding-engine.ts:535`, `captureFileDigests` at `:545`),
`scanGlobalSnapshot` checks each file's existence (`src/artifact-index.ts:147,
151, 157, 161`), and `bindingMissingInputs` (`src/commands/smash.ts:133`) blocks
on it. A hidden mapping can therefore block a run without appearing in the
displayed prompt contract.

**Contract decision:** make `V1ManifestSchema` **reject unreferenced `files:`
keys**. In `validateFilesMap` (or a sibling refinement) add an issue for any
`files:` key that is not the `source` of at least one declared `inputs` entry on
the same binding. This makes the displayed prompt contract the complete,
faithful set of inputs the run consumes, for *any* generic v1 manifest. The
repository's own `config/orc-smash.yaml` already references every `files:` key
(`planPath` is an input source on `review` and `implement`), so this is
non-breaking for the packaged manifest; it is a documented compatibility
decision that a previously-silent misconfiguration now fails loudly at load
time rather than silently blocking a run.

Do **not** adopt the alternative of merely rendering hidden files in the view:
that leaves a confusing class of inputs that affect execution and fingerprinting
but are not operator-declared. Rejecting them is the source-of-truth fix.

#### B1b. Manifest declaration order (Major 3)

The plan must render bindings in manifest declaration order for *any* valid v1
ID. `SAFE_ID_REGEX` (`src/manifest.ts:137`) permits integer-like IDs such as
`"10"` and `"2"`, and JavaScript enumerates integer-like string keys in numeric
order, not insertion order. `buildProjectSnapshotView` currently iterates
`Object.entries(manifest.loops)` (`src/project-snapshot-view.ts:140`) and
`Object.entries(manifest.tasks)` (`:164`), so a manifest declaring loop `10`
then loop `2` would render `2` before `10`. `YAML.parse` returns a plain object,
so declaration order is already lost before the schema sees it.

**Contract decision:** capture declaration order from the YAML mapping *before*
it becomes a plain object, and have the view consume that representation rather
than `Object.entries`.

- In `loadManifest` (`src/manifest.ts:362`), parse with `YAML.parseDocument`
  and record the key order of `loops`, `tasks`, and `pipelines` from the
  document mapping's `items`. Expose that order as a narrowly named
  `ManifestDeclarationOrder` type in `src/manifest.ts`, returned from
  `loadManifest` alongside `V1Manifest`.
- In `loadConfig` (`src/config.ts:178–183`), carry
  `ManifestDeclarationOrder` through `Config` as a precisely named
  `manifestDeclarationOrder` field (`Config.manifestDeclarationOrder`),
  added to the `loadConfig` return value alongside the existing `manifest`
  field.
- `buildProjectSnapshotView` (`src/project-snapshot-view.ts`) consumes
  `config.manifestDeclarationOrder` to iterate bindings in captured order
  (loops first, then tasks, each in declaration order) instead of
  `Object.entries`.
- The ordered representation is the single source consumed by both the view
  builder and the `Prompt Contracts` renderer.

Rejecting integer-like IDs is explicitly **not** chosen: it would shrink the
generic v1 contract and is unnecessary once declaration order is captured.

### B2. Input presentation rules

For every declared input, show:

- the final display label (`input.label` or the canonical default label);
- its manifest source;
- the resolution kind (`target`, `runtime`, or `configured-file`);
- for `configured-file`: the file-map key and its resolved path;
- whether it is currently available, missing, or resolved only when execution
  begins.

Examples:

```text
Target document <- target                          [file: docs/dev/plan.md]
Version         <- version                         [resolved at execution]
Prior artifact  <- priorArtifact                   [resolved from chain state]
Output path     <- outputPath                       [pattern + selected provider]
planPath        <- planPath                        [file: docs/dev/plan.md]
missingFile     <- missingFile                     [file: not/found.txt; missing]
```

The bracket annotation carries resolution kind and `{key}: {value}` pairs.
Renderers build the annotation from typed fields — they never infer kind from
the `source` string.

The display must preserve manifest input order because that is the order used
by `composePrompt`.

Every input carries typed fields that the renderer uses to build the bracket
annotation deterministically. The annotation is assembled from `resolutionKind`,
`configuredValue`, `status`, and `note` — it is never inferred from the `source`
string alone.

| Source | Status | Bracket annotation (built from fields) |
|---|---|---|
| `target` (file-kind, exists) | `available` | `[file: <path>]` |
| `target` (file-kind, absent) | `missing` | `[missing target]` |
| `target` (worktree-kind) | `available` | `[worktree: .]` |
| `version` | `runtime-resolved` | `[resolved at execution]` |
| `priorArtifact` | `runtime-resolved` | `[resolved from chain state]` |
| `outputPath` | `runtime-resolved` | `[pattern + selected provider]` |
| `files.<key>` (exists) | `available` | `[file: <path>]` |
| `files.<key>` (missing) | `missing` | `[file: <path>; missing]` |

Input availability must be computed once during `scanGlobalSnapshot` and carried
as structured data in a dedicated domain shape (e.g. `BindingInputAvailability`,
defined in B1). The scan performs each existence check once, then derives the
existing operator-facing `missingInputs` messages from that structured result
(preserving current behavior). `buildProjectSnapshotView` consumes the
structured snapshot data directly. Renderers must perform no filesystem access
and must not parse diagnostic strings. If a small pure module is extracted, it
must own the stable responsibility of binding-input availability — invoked by
the scan once per snapshot, not by individual callers.

Do not read and print the contents of target, role, skill or prior-artifact
files. The renderers are filesystem-free and `prompt-composer.ts`-free; the
builder's only filesystem read is the pre-existing target-fingerprint computation
(see B5d). The new prompt-contract additions introduce no further content reads
and never call `prompt-composer.ts`. See the purity and redaction contract in B5d
and its sentinel/scoped no-read tests.

### B3. Output and decision presentation rules

For each step show:

- configured output pattern exactly as declared;
- output contract;
- decision heading plus accepted/retry tokens when configured;
- validator when configured;
- an explicit marker when the provider-dependent final path is not resolved.

Do not substitute a guessed provider into `{provider}` before runner selection.

### B4. Render contracts in detailed project state

Add a `Prompt Contracts` section to `renderDetailedSnapshot`. It must appear in
both:

- interactive **Display pipeline and project state**; and
- `orc status --project <path>`.

Place it after `Configured Pipelines` and before historical artifact details so
the view reads in this order:

1. project and suggestion summary;
2. configured pipeline structure;
3. configured execution/prompt contracts;
4. observed binding/artifact state;
5. unclassified artifacts and pipeline candidates.

**Binding ordering rule:** The `Prompt Contracts` section iterates
`view.bindings` in manifest declaration order (loops first, then tasks, each in
the order declared in the manifest). This order is produced by
`buildProjectSnapshotView` from the **captured declaration-order representation**
of B1b — *not* from `Object.entries` (which would mis-order integer-like IDs
such as `"10"` before `"2"`; the previous `Object.entries` at
`src/project-snapshot-view.ts:140` and `:164` is replaced). It is guarded by the
"Multiple pipelines and bindings preserve manifest order" snapshot contract
test and the `10`-then-`2` ordering test below.

### Required operator-facing example

With the repository's current manifest, the rendered information must be
structurally equivalent to the following. Exact alignment and ANSI styling may
vary, but no listed field may be omitted. Bindings appear in manifest
declaration order: loops (`plan`, `review`) then tasks (`implement`).

```text
Prompt Contracts:

  [loop] plan
    Target: docs/dev/plan.md [file]
    Prompt recipe:  Role content -> Skill content -> ordered Inputs
    Result contract: Pattern -> contract -> decision/validator

    Evaluate:
      Role:   auditor -> roles/auditor.md
      Skill:  plan-audit -> skills/21-simple-plans-audit/SKILL.md
      Inputs:
        Target document <- target              [file: docs/dev/plan.md]
        Version         <- version             [resolved at execution]
        Prior artifact  <- priorArtifact       [resolved from chain state]
        Output path     <- outputPath           [pattern + selected provider]
      Result contract:
        Pattern:  docs/dev/plan-audit-v{version}-{provider}.md
        Contract: decision-artifact
        Decision: heading=Verdict, accepted=APPROVED, retry=REJECTED

    Repair:
      Role:   planner -> roles/planner.md
      Skill:  plan-follow-up -> skills/22-simple-plans-follow-up/SKILL.md
      Inputs:
        Target document <- target              [file: docs/dev/plan.md]
        Version         <- version             [resolved at execution]
        Prior artifact  <- priorArtifact       [resolved from chain state]
        Output path     <- outputPath           [pattern + selected provider]
      Result contract:
        Pattern:  docs/dev/plan-followup-v{version}-{provider}.md
        Contract: completion-artifact

  [loop] review
    Target: . [worktree]
    Prompt recipe:  Role content -> Skill content -> ordered Inputs
    Result contract: Pattern -> contract -> decision/validator

    Evaluate:
      Role:   reviewer -> roles/reviewer.md
      Skill:  review -> skills/40-simple-review/SKILL.md
      Inputs:
        planPath       <- planPath             [file: docs/dev/plan.md]
        Target document <- target              [worktree: .]
        Version        <- version              [resolved at execution]
        Prior artifact <- priorArtifact        [resolved from chain state]
        Output path    <- outputPath            [pattern + selected provider]
      Result contract:
        Pattern:  docs/dev/review-v{version}-{provider}.md
        Contract: decision-artifact
        Decision: heading=Verdict, accepted=APPROVED, retry=REJECTED

    Repair:
      Role:   implementer -> roles/implementer.md
      Skill:  review-follow-up -> skills/42-simple-review-follow-up/SKILL.md
      Inputs: same ordered binding inputs shown explicitly
      Result contract:
        Pattern:  docs/dev/review-followup-v{version}-{provider}.md
        Contract: completion-artifact

  [task] implement
    Target: . [worktree]
    Prompt recipe:  Role content -> Skill content -> ordered Inputs
    Result contract: Pattern -> contract -> validator

    Task:
      Role:   implementer -> roles/implementer.md
      Skill:  30-simple-implement -> skills/30-simple-implement/SKILL.md
      Inputs:
        planPath       <- planPath             [file: docs/dev/plan.md]
        Version        <- version              [resolved at execution]
        Prior artifact <- priorArtifact        [resolved from chain state]
        Output path    <- outputPath            [pattern + selected provider]
      Result contract:
        Pattern:   docs/dev/impl-v{version}-{provider}.md
        Contract:  required-artifact
        Validator: implement-ledger
```

Do not literally print `same ordered binding inputs shown explicitly`; the real
renderer must list every input. That abbreviation exists only to keep this plan
example readable.

### B5. Keep execution and display semantics aligned

The display is descriptive and read-only. It must not affect next-step
selection, runner resolution, session continuity, artifact scanning, pipeline
eligibility, or prompt generation.

Add two independently named parity tests targeting the correct runtime
boundaries. Implementation must not add decision, contract or validator
parameters to `composePrompt` merely to satisfy display parity.

#### B5a. Prompt-composition parity

Prove that the displayed prompt recipe reports the same values that `buildPrompt`
(`src/loops/binding-engine.ts:508`) and `composePrompt`
(`src/prompt-composer.ts:68`) consume:

- role ID and role file;
- skill ID and skill file;
- target declaration;
- ordered input labels and literal manifest sources;
- configured `files:` mappings;
- output pattern used by `outputPath` resolution.

#### B5b. Artifact-result-contract parity

Prove that the displayed result contract matches the manifest/runtime values
consumed at the artifact-result boundary after provider execution:

- output contract;
- decision heading;
- accepted and retry tokens;
- validator when configured.

Prefer testing shared normalized data over matching two separate hand-built
strings.

#### B5c. Execution-time preflight parity (Major 2)

A snapshot is necessarily stale by the time an operator starts a binding: a
file present at scan time can disappear before execution. The displayed
availability must therefore never authorize a run. `bindingMissingInputs`
(`src/commands/smash.ts:133`) already reruns the existence check at execution
time (`smash.ts:230`) and returns/retries *before* runner resolution
(`smash.ts:280`), ownership admission, and provider spawn. This ordering is a
required invariant, not incidental.

Preserve and assert it:

- `bindingMissingInputs` is invoked once, immediately before runner resolution,
  using the same narrow availability rule as the display scan (the shared
  existsSync-against-project-root rule), never a cached snapshot result;
- when inputs are missing at execution, the run emits the concrete
  `input.missing` event and the `Project inputs missing: …` error and reaches
  **neither** runner resolution, **nor** ownership admission, **nor** provider
  spawn;
- add a scan-then-delete regression: build a binding whose inputs exist at
  snapshot/scan time, render the contract as available, then remove the file
  and invoke the run path — assert the concrete missing-input error and that no
  `runner.resolved`, ownership, or spawn event occurs.

#### B5d. Display purity and redaction (Major 4)

The **renderer** (`renderDetailedSnapshot` in `src/project-snapshot-renderer.ts`,
which today imports only the view type) is and stays filesystem-free and
`prompt-composer.ts`-free — a partial implementation that calls `composePrompt`
or `readFileSync` to derive display text would silently leak contents while
passing field-presence tests.

The **builder** (`buildProjectSnapshotView`, `src/project-snapshot-view.ts`)
performs exactly one, pre-existing class of filesystem read: the
target-fingerprint computation via `buildTargetSnapshots` (`src/next-step.ts:88`
→ `src/target-snapshot.ts:157`) used for pipeline stale-detection. That read
happens through `captureTargetSnapshot` which hashes target contents
(`sha256(readFileSync(...))` at `target-snapshot.ts:35`) and never surfaces them
in the view. This read remains unchanged and does not invalidate the purity
boundary.

The **new prompt-contract view additions** must introduce no further content
reads and must never call `composePrompt` or read role, skill, prior-artifact, or
target *contents* beyond the pre-existing fingerprint path. `renderDetailedSnapshot`
and all prompt-contract view construction must stay free of filesystem calls and
`prompt-composer.ts` calls.

Assert purity directly: in `tests/project-snapshot.test.ts` and
`tests/status-action.test.ts`, use a project-local manifest whose role, skill,
target, and prior-artifact files each contain a distinct sentinel string; after
the scan, assert the detailed interactive/status text contains the paths and
declared metadata but **none** of the sentinels. Add a focused no-read assertion
**scoped to prompt-contract view construction and rendering** (stub `readFileSync`
and `composePrompt` around prompt-contract view construction and rendering, not
as a blanket stub over the full `buildProjectSnapshotView` call, which internally
reads target files for fingerprinting). A future content read in the
prompt-contract path fails the test; the pre-existing fingerprint path is
unaffected. Keep the sentinel-content assertion as the primary redaction guard.

---

## Workstream C: Canonical documentation synchronization

Update canonical documentation in the same implementation change so agents and
operators see the shipped behavior rather than stale constraints:

- `README.md` — describe the shared semantic colour behavior, colour-off and
  redirected-output guarantees, and the manifest-derived Prompt Contracts
  section available through interactive project state and `orc status`;
- `docs/architecture/overview.md` — document the one-way data flow from
  manifest plus structured `GlobalSnapshot` availability into
  `ProjectSnapshotView`, the no-filesystem/no-prompt-content rendering boundary,
  and the separate execution-time missing-input preflight;
- `AGENTS.md` — review the repository invariants and update them only where the
  implementation changes a durable invariant. It must not introduce a
  `research.md` prerequisite: the configured pipeline contains plan,
  implementation, and review stages only.

Documentation must distinguish prompt-recipe metadata from prompt or file
contents, and must not imply that plain output is necessarily colourless.

---

## Verification strategy

### Semantic accent tests

- Force `chalk.level = 1` only inside focused tests and restore the previous
  value in cleanup.
- Assert representative ANSI accents for results, warnings, unavailable states,
  roles and lifecycle states.
- Strip ANSI codes and assert the complete meaningful text is unchanged.
- Run a colour-disabled case and assert output remains fully understandable.
- Test zero and non-zero unclassified counts separately.
- Test missing inputs as a warning rather than dim supporting text.
- Test recommended and unavailable menu choices without changing their values,
  disabled state or default behavior.
- **Exhaustive surface coverage:** add a test that enumerates every
  orc-smash-owned terminal surface from the inventory independently and verifies
  each one with real ANSI output (not just import presence) at `chalk.level = 1`,
  then strips ANSI and asserts the complete meaningful text remains present. An
  unconverted surface must fail CI. The enumerated surfaces are:
  1. `renderCompactSnapshot`;
  2. `renderDetailedSnapshot`;
  3. live `renderStatusPanel` (including the timeline result column now driven
     by `resultAccent`, replacing the inline logic at `status-panel.ts:119–127`);
  4. `createPanelCliOutput` direct writers — `note`, `warn`, `error`,
     `stepStarted`/`stepSucceeded`/`stepFailed`, and `finalSummary` (incl. the
     Harness Event Log) via `tests/cli-output.test.ts` and
     `tests/cli-output-live.test.ts`;
  5. `renderRunEvent` (the live `--plain` path);
  6. `renderPlainPanel` (auxiliary utility renderer);
   7. `formatMenuChoice` plus the interactive direct writes (task-detail and
     `promptRunners`) via `tests/interactive.test.ts`.
  The enumeration is hand-maintained: when a new owned surface is added, the
  test must be updated in lockstep. Optionally reinforce this by also asserting
  against the dynamic set of `chalk.` call sites in `src/` so the enumeration
  cannot silently drift.
- **State-by-surface ANSI matrix (Major 5):** "representative" samples do not
  prove the same-state/same-colour guarantee. Add a matrix test that, for each
  surface above, exercises every domain state through the exhaustive accent API
  and asserts the colour level and the stripped text:

  | Domain | States | Expected accent class |
  | --- | --- | --- |
  | Applicable decision | `accepted`, `retry`, `unknown` | green / red / attention |
  | Completion | `completed`, `blocked`, `valid` | green / attention / neutral |
  | Lifecycle | `running`, `done`, `failed`, `interrupted` | attention / neutral / red / attention |
  | Availability | `available`, `unavailable`, `missing-inputs` | normal / dim / yellow |
  | Unclassified | count `0` vs `> 0` | dim / yellow |
  | Stale evidence | stale vs fresh | attention / neutral |

  Each applicable state must resolve to one accent in every surface that renders
  it; a state with no mapping fails. `resultAccent` must accept `failed` and
  `interrupted` (previously omitted).
- **Colour-off subprocess tests (Major 5):** assert zero ANSI in real
  non-colour environments, not only at `chalk.level = 0` in-process. Add:
  - a `NO_COLOR=1` child process running `smash --plain` and `orc status`,
    asserting the captured stdout contains no ANSI escape codes; and
  - a piped (non-TTY) child process for the same commands, asserting zero ANSI.
  Cover the newly coloured `createPanelCliOutput` writers, `renderRunEvent`, and
  `renderPlainPanel` independently in `tests/plain-render.test.ts`,
  `tests/cli-output.test.ts`, and `tests/e2e/plain-compiled.test.ts`. Also keep
  the in-process `chalk.level = 0` / `isTTY === false` zero-ANSI case for unit
  speed.
- **Inquirer rendering fixture (Major 1 / Major 5):** a unit test of only
  `formatMenuChoice` is insufficient. Add a real Inquirer rendering fixture (or
  the supported choice-presentation seam) that renders both disabled categories
  — a `missing-inputs` choice and an ordinary `unavailable` choice — at
  `chalk.level = 1`, and asserts the missing-input choice is yellow, the
  ordinary unavailable choice is dim, all reason text survives ANSI stripping,
  and `value`, `disabled`, and default selection are unchanged.
- **ANSI-aware width (Minor 1):** add a `COLUMNS=40`, `chalk.level = 1` case in
  `tests/plain-render.test.ts` proving `renderPlainPanel` stripped lines retain
  the intended wrapping and text after accents are applied post-layout.

### Snapshot contract tests

- A loop with distinct evaluate/repair roles and skills renders both contracts.
- A task renders its role, skill, ordered inputs, output contract and validator.
- Custom input labels override default labels.
- A `files:` input displays its configured path and missing/available state.
- A `files:` input for a missing file shows an explicit text marker (`[file: <path>; missing]`) that survives ANSI stripping and colour-off output.
- Runtime-only inputs are explicitly described as runtime-resolved.
- Decision tokens are manifest-driven, not hardcoded to
  `APPROVED`/`REJECTED` in TypeScript.
- Multiple pipelines and bindings preserve manifest order.
- **Declaration order for integer-like IDs (Major 3):** in
  `tests/manifest.test.ts` and `tests/project-snapshot.test.ts`, declare loops
  (and tasks) in `10`-then-`2` order and assert the rendered `Prompt Contracts`
  (and binding list) appear in that exact declaration order — proving the view
  consumes the captured order, not `Object.entries`.
- **No hidden file dependencies (Major 2):** in `tests/manifest.test.ts`, assert
  `V1ManifestSchema` *rejects* a binding whose `files:` map contains a key that
  is not the `source` of any declared `inputs` entry, with a clear issue path.
  Also assert the packaged `config/orc-smash.yaml` still loads (every `files:`
  key is referenced).
- **Execution preflight survives a disappeared input (Major 2):** in
  `tests/smash-action.test.ts`, scan a binding whose inputs exist (contract
  renders available), delete one file, then run — assert the concrete
  `Project inputs missing: …` error / `input.missing` event and that no
  `runner.resolved`, ownership, or provider-spawn event occurs (see B5c).
- **No content leakage (Major 4):** in
  `tests/project-snapshot.test.ts` and `tests/status-action.test.ts`, scan a
  manifest whose role/skill/target/prior-artifact files contain distinct
  sentinels and assert the detailed text shows paths and metadata but none of the
  sentinels; the focused no-read assertion (stub `readFileSync`/`composePrompt`
  scoped to prompt-contract construction and rendering, not as a blanket stub
  over the full `buildProjectSnapshotView` call) fails if the prompt-contract
  path reads role, skill, prior-artifact, or target contents beyond the
  pre-existing fingerprint read (see B5d).
- A `plan` binding whose target file (`docs/dev/plan.md`) does not exist renders
  the target input (and the binding-level `Target:` line) as missing/prominent,
  not silently available.
- Invalid/unclassified artifacts do not alter the configured contract display.
- The detailed interactive view and `orc status` use the same renderer/view
  data and therefore show the same contracts.
- **Full-manifest Prompt Contracts assertion:** add a test that calls
  `renderDetailedSnapshot` against the full packaged `config/orc-smash.yaml`
  manifest and asserts a `Prompt Contracts` entry for every binding and phase:
  `plan` evaluate, `plan` repair, `implement`, `review` evaluate, and `review`
  repair (five entries total). A partial conversion must fail CI. **Note:**
  the five-entry list must be updated in lockstep with manifest binding/phase
  changes. Prefer parameterizing the assertion over every manifest binding ×
  phase so the test tracks the manifest automatically rather than requiring
  manual synchronization.
- **Inquirer disabled-choice behavior:** add a case in
  `tests/interactive.test.ts` that asserts (at `chalk.level = 1`) that an
  unavailable choice's reason text is fully present after ANSI stripping, that
  `disabled === true`, and that `value` and default behavior are unchanged.

### Regression verification

Run:

```bash
pnpm run typecheck
pnpm run build
pnpm test
git diff --check
```

Also perform narrow manual checks in a colour-capable terminal:

```bash
./bin/orc.js smash -p /Volumes/projects/orc-smash
./bin/orc.js status --project /Volumes/projects/orc-smash
NO_COLOR=1 ./bin/orc.js status --project /Volumes/projects/orc-smash
```

Confirm that plain mode remains line-oriented and readable both interactively
and when redirected to a file.

---

## Non-goals

- Do not add or migrate to a new TUI library.
- Do not redesign the live status-panel layout or alternate-screen lifecycle.
- Do not change pipeline eligibility or suggested-stage selection.
- Do not change loop/task state transitions, verdict parsing or follow-up gates.
- Do not change runner selection, model/effort options or session continuity.
- Do not change prompt composition or reorder manifest inputs.
- Do not print full role, skill, target or artifact file contents.
- Do not add user-configurable themes in this change.
- Do not force ANSI colours into redirected output or log files.
- Do not remove existing fields merely to make the display shorter.

## Acceptance criteria

1. All orc-smash-owned terminal surfaces use one shared semantic accent source.
2. The same state has the same colour meaning in compact, detailed, panel and
   plain output.
3. Output remains complete and understandable with ANSI removed or colour
   disabled.
4. Missing inputs and non-zero unclassified counts are visually prominent.
5. Interactive menu recommendation/unavailability styling does not affect menu
   behavior.
6. Detailed project status shows the configured prompt contract for every loop
   phase and task.
7. Each contract includes target, role ID/path, skill ID/path, ordered input
   mappings, output pattern/contract, decision tokens and validator when
   applicable.
8. Runtime-dependent values are marked as unresolved rather than guessed.
9. Interactive **Display pipeline and project state** and `orc status` show the
   same contract information.
10. Prompt generation, execution state, continuity, logging, errors and
    pipeline behavior are unchanged for manifests that pass validation, apart
    from the explicitly specified rejection of unreferenced `files:` keys and
    preservation of manifest declaration order.
11. Focused colour, no-colour, view-model and prompt-contract parity tests pass.
12. Typecheck, production build, deterministic test suite and diff checks pass.
13. `README.md`, `docs/architecture/overview.md`, and `AGENTS.md` are reviewed
    and synchronized with the implemented operator-surface and snapshot
    contracts, without adding a research-stage prerequisite.
