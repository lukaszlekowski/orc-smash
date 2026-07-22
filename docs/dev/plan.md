---
status: done
date: 2026-07-22
scope: operator-surface-correction
---

# Plan: Informative and Persistent Interactive Operator Surface

## Goal

Make the existing config-driven workflow understandable and usable from the
interactive CLI without changing its workflow engine. On entry, the operator
must see what project and configuration were scanned, what valid and invalid
workflow evidence exists, which runners produced the latest artifacts, and why
a loop or pipeline stage is suggested. Menus must retain a small stable
hierarchy, disabled actions must explain themselves clearly, and read-only
status must remain visible in ordinary terminal scrollback.

This is primarily a presentation and navigation correction over the completed
generic engine. It also includes one narrowly demonstrated reader/writer
consistency repair: descendants of a pipeline-start chain must survive a disk
rescan with the same classification they had during live execution. It must not
otherwise reinterpret artifacts, relax pipeline eligibility, infer pipeline
identity, or change execution and process-safety behavior.

## Confirmed Problems

1. `scanGlobalSnapshot()` runs before the top-level prompt, but its information
   is used mainly for availability checks and is not presented on entry.
2. Configured tasks are flattened into top-level actions such as
   `Execute one-off task: implement`; the intended generic action plus task
   chooser was not implemented.
3. Inquirer appends string-valued disabled reasons without punctuation, yielding
   ambiguous text such as `Start suggested stage No eligible ...`.
4. `Display pipeline and project state` renders through the alternate-screen
   panel and immediately returns to the prompt. The next draw replaces the
   panel, and alternate-screen output is unavailable in normal scrollback.
5. The loop submenu has the same ambiguous disabled-reason presentation.
6. Existing tests primarily inspect menu data objects. They do not adequately
   prove the text, hierarchy, persistence, and return navigation experienced by
   an operator.
7. Runner selection resolves the full evaluate/repair provider, model, effort,
   and session policy before execution, but the live panel receives an empty
   resolved-runner list and shows only the active runner. The operator therefore
   loses the configuration summary when execution enters the alternate screen.
8. A real pipeline-start loop completed successfully in memory, but a later
   status scan rejected its repair and second evaluation because the scanner
   incorrectly required every artifact carrying `chainMode: pipeline-start` to
   have a null parent. Only the chain root has a null parent; descendants must
   point to their immediate predecessor.

## Recommended Implementation Direction (Normative)

Treat the work as six ordered, reviewable slices. Do not combine it into a UI
rewrite. Each slice must leave typecheck and its focused tests green before the
next begins.

| Order | Slice | Required direction | Must remain untouched |
| ---: | --- | --- | --- |
| 1 | Characterization | Encode the demonstrated three-artifact rescan failure and current terminal/menu behavior before production edits. | Artifacts, providers, ownership |
| 2 | Scanner repair | Correct only the pipeline-start root/descendant invariant and surface existing unclassified reasons. | Fingerprints, eligibility rules, artifact writer |
| 3 | Snapshot model | Build one immutable global display model from one scan and pure derivations. | Scanner/classifier decisions |
| 4 | Static output | Add persistent normal-screen rendering and explicit return navigation. | Live-region event flow |
| 5 | Menus | Introduce the generic task chooser and common disabled-choice formatting. | Direct non-interactive dispatch |
| 6 | Live panel | Thread already-selected runners and already-resolved invocation continuity into the panel. | Runner and continuity resolution |

If a slice requires editing a provider adapter, `run-ownership.ts`,
`kill-gate.ts`, supervisor-contract code, signal handling, timeout policy, or
artifact-writing schema, stop and amend/re-audit the plan. Those changes are not
an acceptable incidental implementation technique.

### Source-of-truth data flow

Use these one-way flows; renderers and prompts never rediscover domain facts:

```text
Static project state
  loadConfig
    -> scanGlobalSnapshot (once)
    -> pure default-loop / in-progress / pipeline-candidate derivations
    -> ProjectSnapshotView
    -> compact or detailed text renderer
    -> CliOutput.writeStatic

Live run state
  promptRunners / resolveRunner
    -> immutable selected runner map
    -> binding engine resolves continuity for the current invocation
    -> executeLoopStep
    -> PanelContext { selected runners, active invocation }
    -> live panel renderer
```

Where current convenience wrappers rescan internally, extract or reuse a pure
core that accepts the already-built `GlobalSnapshot`; keep the public wrapper as
a delegating compatibility boundary if existing callers still need it. Do not
copy default-loop, candidate-eligibility, lineage, runner, or continuity logic
into a view module.

Concretely, the pipeline-suggestion evidence the detailed view must reproduce —
and that `tests/status-action.test.ts` covers today — is produced by
`allPipelineCandidates` / `pipelineSuggestions` (`src/next-step.ts:110,138`),
each of which calls `scanGlobalSnapshot` internally (`next-step.ts:114,142`) and
`buildTargetSnapshots` (`next-step.ts:88`) on top of the single scan the caller
already performed. The view module (`project-snapshot-view.ts`) must **not**
call those wrappers. Instead map the single scan's `snapshot.steps` to
`ArtifactRecord` and call the pure core `pipelineStageCandidates(artifacts,
manifest, targetSnapshots)` (`src/pipeline-state.ts:290`) directly;
`eligibleNextStages` (`pipeline-state.ts:278`) is the non-stale filter over the
same pure core. Compute `targetSnapshots` once via `buildTargetSnapshots`
against the same scanned state so staleness evidence is derived, not re-scanned;
if `buildTargetSnapshots` cannot be reached without rescanning, extract its body
into a pure helper that takes the already-scanned manifest/target facts. The
suggested-loop reason is likewise composed from the single passed
`GlobalSnapshot` via `recoverInProgressRun` (see Startup Project Snapshot
Contract) — `bindingHasInProgressChain` and `resolveDefaultLoop` rescan and must
not be called from the view.

### Deliberate behavior changes versus preserved behavior

Only these behavior changes are authorized:

- interactive startup prints a compact project snapshot;
- interactive tasks move behind one `Execute one-off task` chooser;
- disabled reasons use explicit, grammatical labels;
- read-only status becomes persistent normal-screen output;
- the live panel displays the complete selected runner/session policy;
- valid non-root artifacts in a pipeline-start chain survive disk rescanning;
- unclassified artifacts expose the reason already determined by the scanner.

Everything else is preservation work. In particular, `--loop`, `--task`, and
`--pipeline` remain direct non-interactive dispatch paths; typed event schemas,
debug logging, prompt composition, runner precedence, session selection,
artifact contents, ownership admission, provider spawning, termination, and
exit-code mapping remain unchanged.

## Product Decisions

### 1. Inform the operator; never auto-advance

The startup view may recommend a loop and may show eligible pipeline-stage
suggestions, but it must not select or execute either automatically. Every
execution still requires an explicit operator action.

The startup view must distinguish these concepts:

- **Suggested loop:** the loop the existing default-loop resolver would place
  first/default in loop selection, together with a human-readable reason.
- **Eligible pipeline stage:** a successor returned by the existing pipeline
  eligibility rules, together with its evidence.
- **Unavailable suggestion:** no eligible candidate, or candidates invalidated
  by stale input, unclassified evidence, missing input, or another existing
  eligibility rule.

Do not describe a filename-only or unclassified artifact as workflow
completion. Historical artifacts that fail the current provenance contract
remain unclassified and cannot enable continuation, second opinion, or a
pipeline successor.

### 2. Static information belongs to the normal terminal screen

The terminal alternate screen is reserved for a genuinely live, repeatedly
updated execution region. The following are static and must render on the
normal screen so they remain in scrollback:

- the startup project snapshot;
- `Display pipeline and project state`;
- standalone `orc status`;
- menus and disabled reasons;
- errors and return-to-menu messages.

Displaying static status must not attach a timer or live region. Returning from
the detailed status view requires an explicit `Back`/Enter acknowledgement; the
application must not redraw the menu over the status immediately.

### 3. Tasks are bindings, not raw skills

The top-level action is always `Execute one-off task`. Selecting it opens a
chooser containing the configured task bindings. Do not list every raw skill:
a task is the executable contract that supplies its target, inputs, output
pattern, validator, and skill binding.

Each task choice must make these facts available before execution:

- task ID;
- bound skill ID;
- role;
- resolved skill-definition path;
- target;
- output pattern and contract;
- availability, with the exact missing-input reason when unavailable.

The concise selector label should contain the task ID, skill, and role. After a
task is selected, show its full detail and require `Run task` or `Back`. Runner
selection occurs only after `Run task` is confirmed. `Back` returns to the task
chooser, and the chooser has its own `Back to main menu` action.

### 4. Disabled choices use one explicit format

All interactive menus use the same presentation rule:

```text
Start suggested stage (unavailable: no eligible pipeline stage candidates)
Continue current plan loop (unavailable: no in-progress loop to continue)
Run second opinion for plan (unavailable: no completed loop to review)
```

The displayed choice name owns the explanatory text. Pass a boolean disabled
state to Inquirer rather than relying on Inquirer to concatenate a string
reason. Enabled choices do not include an unavailable suffix. Recommended
choices use a separate `(recommended)` suffix and must never be recommended
while disabled.

The same formatter is used by the top-level menu, loop submenu, task chooser,
pipeline launch-context chooser, suggested-stage chooser, runner capability
choices, and any other menu with a disabled reason.

### 5. Keep selected runner policy visible throughout a live run

Runner configuration and observed session outcome are different facts and must
not be collapsed into a single `Session` timeline cell:

- **Selected runner policy (known before execution):** skill, role, provider,
  exact model, effort (`provider default` when absent), and session strategy
  (`fresh-per-invocation` or `resume-per-skill`).
- **Current invocation mode (known immediately before spawn):** `fresh` with a
  reason, or `resumed` with the prior session ID. A fresh invocation may show
  `new session ID: pending` until the provider reports one.
- **Observed outcome (known after completion):** the actual session ID returned
  by the provider, or `none`.

The live panel adds a stable `Run configuration` section above the timeline,
with one row for every skill selected up front (for an approval loop, evaluate
and repair). It remains visible while either skill is active. The active-step
section additionally shows that invocation's resolved continuity mode:

```text
Run configuration
  Evaluate  plan-audit      claude · glm-5.2[1m]               default  resume per skill
  Repair    plan-follow-up  agy · Claude Opus 4.6 (Thinking)  default  fresh per invocation

Active invocation
  plan-audit v2 — resuming session *a5fb1
```

Use `session policy`, `fresh`, and `resumed`; do not label continuity merely
`on/off`. The existing timeline remains the historical record and shows the
session outcome after completion.

This change passes already-resolved runner and invocation facts into the live
view by reusing the existing `PanelContext.resolvedRunners` plumbing — it does
not add a parallel `selectedRunners` field, re-resolve runners, change
continuity selection, or wait until completion to decide whether an existing
session will be resumed. See "Live run configuration" for the exact type/field
reuse and the `resolveContinuity` return-type extension.

### 6. Pipeline-start describes the chain origin, not every artifact's position

`chainMode: pipeline-start` identifies how the chain was created and remains on
later evaluate/repair artifacts in that chain. Enforce the null-parent rule only
for the actual root artifact. Later same-chain artifacts must carry their
immediate predecessor's `artifactIdentity` and continue through the existing
structural and chain-order lineage validation.

The demonstrated valid sequence is:

```text
pipeline-start evaluate v1 REJECTED  parent=null
repair v1 COMPLETED                  parent=evaluate-v1
evaluate v2 APPROVED                 parent=repair-v1
```

After a fresh disk scan, all three must remain classified and preserve their
model, duration, decision/outcome, session policy, session ID, chain identity,
and parent identity. The final state must remain accepted. Do not rewrite or
migrate correctly stamped artifacts to repair this defect; correct the reader's
root-versus-descendant invariant.

Implement the invariant per `(pipelineId, pipelineRunId, chainId)`:

1. Every artifact whose chain was created by `pipeline-start` still belongs to
   the pipeline's configured first stage; preserve that check for roots and
   descendants.
2. The chain has exactly one root artifact with
   `parentArtifactIdentity: null`.
3. A non-root artifact must have a non-null parent that resolves to the
   immediate prior valid artifact in the same pipeline, run, stage, binding,
   and chain.
4. Root status is determined from lineage, not merely from `kind`, `version`,
   filename, or `chainMode`; later evaluations can have higher versions while
   remaining in the same pipeline-start chain.
5. Existing fixpoint and chain-order validation remain the authority for
   descendant linkage. Do not add a second permissive shortcut around them.

The preferred correction is to narrow/remove the unconditional null-parent
check in the first-pass pipeline-start validation and let the later lineage
passes distinguish roots from descendants. If those passes do not currently
enforce uniqueness and immediacy strongly enough, strengthen the existing pass
rather than adding a parallel validator.

## Startup Project Snapshot Contract

Render a compact snapshot before the first top-level prompt. Re-render it after
an execution completes and returns to the action menu, and after any action that
can change the scanned interpretation. The concrete re-render triggers are:

- returning to the top-level menu after a loop/task/stage execution completes
  (via `promptPostRunRecovery` in `src/commands/smash.ts`);
- selecting `Change loop` and completing the loop-selection prompt;
- selecting `Start suggested stage` and completing stage selection;
- returning from `Display pipeline and project state` (the snapshot may have
  been stale before the operator viewed the detail).

Ordinary navigation between menus (entering the task chooser, viewing task
detail, pressing Back) need not rescan or reprint the snapshot.

The header contains:

```text
Project:  /absolute/project/path
Config:   /absolute/path/to/orc-smash.yaml
Pipelines: default
Suggested loop: plan
Reason: no valid in-progress loop; plan is the configured first loop stage
```

Pipeline header behavior by configuration:

- **One pipeline:** show its ID (e.g. `Pipelines: default`).
- **Multiple pipelines:** list all configured IDs comma-separated
  (e.g. `Pipelines: default, canary`).
- **No pipelines configured:** show `Pipelines: (none configured)`.

The manifest has no "default pipeline" concept; `pipelines` is a plain
`Record<string, PipelineSpec>`. The header lists all configured pipeline IDs
from `Object.keys(manifest.pipelines)` in manifest order.

The suggested-loop reason is **composed** in the view module from the single
passed `GlobalSnapshot`: derive per-binding in-progress state from
`GlobalSnapshot.byBinding` with the pure `recoverInProgressRun` helper, then use
the interrupted marker, loop mtime ordering, and the manifest's first configured
loop. Do not call `bindingHasInProgressChain` or `resolveDefaultLoop` from the
view because those wrappers rescan. `resolveDefaultLoop` returns `{ loopName }`
only; the view module produces the human-readable reason from the same already
scanned facts.

If there is no configured pipeline or no defensible loop suggestion, say so
explicitly. Do not synthesize certainty from an empty or invalid history.

For every configured loop and task, in manifest order, show a compact state
summary:

- binding ID and kind (`loop` or `task`);
- target path;
- latest valid artifact for each applicable step (`evaluate`, `repair`, or
  `task`), or `none`;
- decision/outcome;
- provider, exact model, effort (`provider default` when absent), and session
  strategy/session ID when present;
- missing project inputs;
- count of matching unclassified artifacts for the binding.

The compact startup snapshot may summarize unclassified evidence by count. The
detailed status view must list each matching unclassified artifact with its path
and its per-artifact classification-failure reason sourced from
`Step.unclassifiedReason` (see "Surface classification reasons at the source"
below). This explains why visible historical files do not enable `Continue`,
`Run second opinion`, or a suggested stage.

### Surface classification reasons at the source

Add an optional `unclassifiedReason?: string` field to the `Step` interface in
`src/state.ts`. Capture it in `scanGlobalSnapshot` (`src/artifact-index.ts`) at
every code path that sets `unclassified = true`:

1. **Front-matter / identity-field validation failure** (line ~288): use
   `classifiedMeta.reason` — the `parseArtifactMetaClassified` function in
   `src/provenance.ts` already produces specific strings such as
   `"Missing required identity fields: chainId, artifactIdentity"`,
   `"Artifact has no v1 provenance front matter."`, and
   `"Artifact filename provider/version does not match provenance."`.
2. **Contract validation failure** (line ~329): set
   `unclassifiedReason = 'Output contract validation failed.'`.
3. **Parse / identity-verification exception** (line ~341 catch block): set
   `unclassifiedReason = err.message ?? 'Artifact identity verification failed.'`.
4. **Fixpoint structural lineage failure** (line ~413): the `invalidReason`
   local variable already contains a specific string (e.g.
   `"stage-continuation parent artifact '…' not found or is unclassified."`
   or `"Same-chain parent artifact '…' not found or has mismatched chainId."`);
   assign it to `step.unclassifiedReason`.
5. **Chain-order lineage validation failure** (line ~452): set
   `unclassifiedReason = 'Chain lineage invalid: parent artifact identity mismatch.'`.

Default to a stable generic phrase (`'Unclassified: does not satisfy current provenance contract.'`) for any boolean-only branch that lacks a specific
string.

The reason-field addition **surfaces already-computed reasons** without changing
classification. Test that addition independently from the deliberate
pipeline-start descendant correction in Product Decision 6: reason plumbing
alone must leave classified/unclassified path sets identical, while the focused
reader correction must change only the falsely rejected valid descendants in
its explicit regression fixture. Neither change modifies durable provenance or
relaxes eligibility for stale, foreign-run, wrong-stage, or malformed evidence.
`unclassifiedReason` is display-only `Step` state and must never be serialized
into artifact front matter.

The view module reads `Step.unclassifiedReason` and renders it; it does not
rescan, reclassify, or reconstruct the cross-step fixpoint.

For every eligible pipeline successor, show concise evidence:

- pipeline and pipeline-run ID;
- predecessor and successor stage;
- completion artifact path and identity;
- decision/outcome;
- result/input fingerprint validity.

Stale or otherwise ineligible candidates belong in the detailed view, with the
existing reason. The startup view can summarize them as an unavailable count.

## Detailed Project and Pipeline View

`Display pipeline and project state` and `orc status` consume the same immutable
view model. The detailed view contains:

1. project/config paths and scan time;
2. configured pipeline stages in order;
3. all loop/task binding summaries;
4. latest valid artifacts and their exact runner provenance;
5. unclassified artifacts, each with its `unclassifiedReason` from `Step`;
6. missing inputs scoped to their binding;
7. eligible and unavailable pipeline suggestions with evidence;
8. interrupted state, when present.

The live execution panel is a separate view over the same run facts. It shows
the complete selected runner policy for every skill plus the active invocation
mode; it must not substitute the read-only single-loop status panel for the
global project snapshot.

The interactive action prints this view persistently and then offers
`Back to main menu`. Standalone `orc status` prints it once and exits normally.
It must not enter the alternate screen and must not wait for input.

`orc status --all` retains its current global meaning. Any loop filter affects
presentation only; scanning remains global.

## Menu Hierarchy

The top-level menu is stable and independent of the number of configured tasks:

```text
Start loop
Execute one-off task
Change loop
Start suggested stage
Display pipeline and project state
Stop for manual review
```

Every action remains visible. When unavailable, it uses the standardized
`(unavailable: reason)` label.

`Execute one-off task` opens:

```text
implement — 30-simple-implement · implementer
update-docs — update-docs · documenter
Back to main menu
```

Unavailable tasks remain visible. Selecting an enabled task opens its detail
and `Run task` / `Back` confirmation.

`Start loop` keeps the current loop-selection behavior and then opens:

```text
Continue current <loop> loop
Start fresh <loop> loop
Run second opinion for <loop>
Back to main menu
```

The existing continuation, fresh-chain, second-opinion, pipeline-context, and
runner-selection semantics remain unchanged.

## Architecture and Ownership

### Project snapshot view model

Add a purpose-named, pure module such as `src/project-snapshot-view.ts`. It
builds a serializable display model from:

- `Config` and its resolved manifest/config paths;
- the existing `GlobalSnapshot`;
- existing default-loop resolution;
- existing eligible/stale pipeline-candidate resolution;
- interrupted-state information already exposed by the status scan.

It must not rescan files independently, classify artifacts, recompute
fingerprints, or implement a second eligibility algorithm. It reads
`Step.unclassifiedReason` as provided by the scan; it does not reconstruct
the classification logic. Callers perform one scan and pass the resulting facts
in. The model contains display facts, not ANSI codes or Inquirer choices.

### Static snapshot renderer

Add a purpose-named renderer such as `src/project-snapshot-renderer.ts` that
turns the view model into compact or detailed text. Rendering is deterministic
and independently testable. Color may be applied at the output boundary, but
tests must be able to assert a stable color-free representation.

Do not force the global multi-binding snapshot into the existing single-loop
`PanelContext`; that type is oriented around a live run. Reusing it would retain
the current mismatch between global project state and one detected loop.

### Live run configuration

Extend the live-run view model deliberately rather than reading configuration
from the renderer. `runBinding` (`src/loops/binding-engine.ts:81`) already
resolves every selected skill runner before the first provider call —
`resolveBindingRunners(skillIds, config, options, runners)` at
`binding-engine.ts:145` populates the `runners` map, and each step later reads
`runners[request.skillId]` (`binding-engine.ts:169`). Thread that immutable
runner map into `executeLoopStep` and `buildPanelContext` so the panel can show
every selected skill, not just the active one.

**Reuse the existing runner plumbing; do not add a parallel path.** The selected
runner rows are carried by the existing `PanelContext.resolvedRunners` field
(`src/status.ts:36`) and its element type `ResolvedRunnerDisplay`
(`src/status.ts:59-65`), which `status-panel.ts` already renders at
`src/status-panel.ts:33-40`. That renderer loop is currently dead because
`executeLoopStep` passes `[]` as the `resolvedRunners` argument
(`src/loops/execution.ts:164`) — exactly the "empty resolved-runner list" of
Confirmed Problem #7. Fix the defect at the source rather than beside it:

1. **Thread the `runners` map into `executeLoopStep`.** Today only the single
   active runner reaches `executeLoopStep` (the `runner` step arg at
   `binding-engine.ts:225`); add the immutable `runners` map (resolved once at
   `binding-engine.ts:145`) to `executeLoopStep`'s deps or step args so
   `buildPanelContext` can see every selected skill.
2. **Extend `ResolvedRunnerDisplay`** (`src/status.ts:59-65`) with the display
   facts it lacks. It already has `skillId`, `agent`, `model`, `source`, and
   `inheritedFrom`; add `role`, `phase`, `effort`, and `sessionStrategy`:
   ```ts
   interface ResolvedRunnerDisplay {
     skillId: string;
     agent: string;
     model: string;
     source: 'selected' | 'inherited' | 'configured';
     inheritedFrom?: { kind: StepKind; version: number; sessionId: string };
     // display-only additions:
     role: string;
     phase: 'evaluate' | 'repair' | 'task';
     effort: string | null;
     sessionStrategy: 'fresh-per-invocation' | 'resume-per-skill';
   }
   ```
3. **Populate `resolvedRunners`** in the `buildPanelContext` call
   (`src/loops/execution.ts:153-167`) from the now-threaded `runners` map
   instead of passing `[]`. The existing `status-panel.ts:33-40` block then
   becomes the "Run configuration" section. Do **not** introduce a second
   `selectedRunners` field next to `resolvedRunners`, and do not leave the
   existing loop as dead code.

The active invocation's resolved continuity is a distinct fact from the selected
runner policy, so it rides a **separate, clearly-named field on `PanelContext`**
(not a `resolvedRunners` element). Add one field, e.g.
`activeInvocation?: ActiveInvocationDisplay`, whose value is:

```ts
interface ActiveInvocationDisplay {
  skillId: string;
  version: number;
  sessionMode: 'fresh' | 'resumed';
  sessionId: string | null;
  freshReason?: 'policy' | 'no-compatible-session' | 'provider-unsupported';
  newSessionPending: boolean;
}
```

Build `activeInvocation` from the already-resolved `continuity` value.
`resolveContinuity` is called per step at `binding-engine.ts:196` and its result
is threaded into `executeLoopStep` at `binding-engine.ts:232`, so
`executeLoopStep` already has the continuity decision in scope when it builds
the panel context. `status-panel.ts` renders the "Run configuration" rows from
`resolvedRunners` and the "Active invocation" line from `activeInvocation`.

`freshReason` is a display fact derived where continuity is resolved, never
inferred from a missing session ID inside `status-panel.ts`. Today
`resolveContinuity` (`src/loops/binding-engine.ts:751-798`) returns only
`{ mode: 'fresh' | 'resumed'; sessionId?: string }` and discards which branch
chose `fresh`. **Extend that return type** to carry `freshReason` alongside
`mode`/`sessionId`, classified at each existing `return { mode: 'fresh' }` site
with no change to the mode-selection logic:

- `sessionStrategy === 'fresh-per-invocation'` (`:760`) → `'policy'`;
- no chain-scoped matching predecessor, or predecessor has no usable session id
  (`:780`, `:783`) → `'no-compatible-session'`;
- predecessor session exists but agent/model/effort differ (`:784-788`) →
  `'no-compatible-session'`;
- adapter lookup throws (`:792-793`) or the provider cannot resume sessions
  (`:795-797`) → `'provider-unsupported'`.

Thread the resulting `freshReason` (with `mode`/`sessionId`) through
`continuity` into the `activeInvocation` field so the renderer only displays it.

The live view must not invoke `resolveRunner`, inspect provider history, or
calculate continuity. Those decisions remain owned by the binding engine; the
renderer only displays the selected policy and resolved invocation facts. These
are display contracts, not new persisted state. This work threads
already-resolved runner and continuity facts; it does not re-resolve runners,
change continuity selection, or wait until completion to decide whether an
existing session will be resumed.

### Output lifecycle

Give `CliOutput` one explicit static-output operation (recommended name:
`writeStatic(text: string): void`) that writes persistent normal-screen content.
Do not overload `renderPanel`, emit fabricated lifecycle events for display
text, or make callers write escape sequences directly.

- Panel output (`createPanelCliOutput`) writes static text to the normal screen:
  `writeStatic` ensures no alternate screen is active (leaving it if one is),
  then writes once. Today a piped `orc status` goes through
  `createPanelCliOutput.renderPanel` → `panelDraw` (`src/cli-output.ts:90-93`),
  which emits `\x1b[?1049h` + `\x1b[H\x1b[2J` plus a boxen-wrapped panel; the
  current defect is therefore alt-screen escape corruption of programmatic
  output, not silence.
- Plain output (`createPlainCliOutput`) writes the same static text without any
  screen-control sequences. **`writeStatic` on the plain path is new behavior**:
  today plain mode's `renderPanel` is a no-op (`src/cli-output.ts:284-286`) and
  the plain path has no static-output operation at all.
- The new static-output operation must be implemented on *both*
  `createPanelCliOutput` and `createPlainCliOutput` so the two output kinds stay
  consistent. `orc status` always uses `createPanelCliOutput` (the status command
  has no `--plain` flag; `--plain` belongs only to the smash command at
  `src/cli.ts:52,58`), so `orc status` exercises the panel `writeStatic` path.
  The plain `writeStatic` is exercised by smash `--plain`, not by `orc status`.
- `attachLiveRegion`/`detachLiveRegion` continue to own alternate-screen live
  execution.
- Static rendering is not recorded as a fabricated lifecycle event. Canonical
  typed events and debug logging remain unchanged.

Terminal ownership rules:

- `attachLiveRegion` is the only operation allowed to enter/start refreshing
  the alternate screen.
- `detachLiveRegion` stops refresh activity; finalization restores the normal
  screen exactly once even after errors or interruption.
- `writeStatic` first ensures no live region/alternate screen is active, then
  writes once to the normal screen; it never starts an interval.
- `Display pipeline and project state` calls `writeStatic`, waits for one
  acknowledgement prompt, and returns via an explicit navigation result rather
  than the missing-input retry path.
- standalone `orc status` calls `writeStatic` once and exits without any prompt.
- do not add a new `status --plain` flag as part of this plan; both output
  implementations support `writeStatic` so programmatic/plain callers remain
  consistent, while the public status command retains its current CLI surface.

Avoid a generic `helpers.ts` or `common.ts`. Keep view construction, text
rendering, menu construction, and terminal lifecycle as distinct
responsibilities.

### Menu presentation

Keep semantic menu items (`label`, `disabledReason`, `recommended`) separate
from their Inquirer representation. One presentation function maps the semantic
item to a choice with the standardized visible label and boolean disabled flag.
Use it across all applicable prompts.

The shared formatter applies to every menu, but the `(recommended)` suffix is
emitted only for items that carry a `recommended: true` flag. That flag exists
today only on `LoopSubmenuItem` (`src/stage-menu.ts:27`); `TopMenuAction`
(`stage-menu.ts:16-21`) does **not** carry `recommended`, so no top-level choice
is ever marked recommended — the top-level loop suggestion is conveyed by the
startup snapshot header, not a menu suffix. Do **not** add `recommended` to
`TopMenuAction` in this plan. The recommended+disabled exclusion is therefore
asserted only where `recommended` exists (the loop submenu); it holds trivially
at the top level because no top-level item is ever recommended.

Add task-specific semantic menu/detail types rather than overloading loop menu
types.

Model interactive navigation as navigation, not setup failure. `Back`, status
acknowledgement, cancelled candidate selection, and returning from task detail
must remain inside the menu state machine and must not increment the outer setup
retry counter. Only a genuine preflight retry may reach that counter.

## Expected Files

The implementer should confirm exact names during implementation, but the
expected scope is:

- `src/state.ts` — add `unclassifiedReason?: string` to the `Step` interface;
- `src/artifact-index.ts` — capture `unclassifiedReason` at every code path
  that sets `unclassified = true` (see "Surface classification reasons at the
  source" above), and correct the pipeline-start root check so valid descendants
  with immediate parents survive rescanning;
- `src/project-snapshot-view.ts` — global display-model construction; reads
  `Step.unclassifiedReason`;
- `src/project-snapshot-renderer.ts` — compact/detailed persistent rendering;
- `src/stage-menu.ts` — stable top-level actions and task-menu/detail models;
- `src/interactive.ts` — task chooser, task confirmation, status acknowledgement,
  and common disabled-choice presentation;
- `src/commands/smash.ts` — scan/render at entry, navigate task submenu, refresh
  after runs, and display detailed static status;
- `src/commands/status.ts` — replace the `buildPanelContext(...) +
  output.renderPanel(panelCtx)` pair (`status.ts:125-138`) with view-model
  construction + `output.writeStatic(text)`, building and printing the shared
  detailed static view;
- `src/loops/binding-engine.ts`, `src/loops/execution.ts` — thread the immutable
  `runners` map (resolved once at `binding-engine.ts:145`) into `executeLoopStep`
  and populate `PanelContext.resolvedRunners` from it in the `buildPanelContext`
  call (`execution.ts:153-167`) instead of `[]`; build the separate
  `activeInvocation` field from the already-resolved `continuity`
  (`binding-engine.ts:196`, threaded at `:232`); extend `resolveContinuity`
  (`binding-engine.ts:751-798`) to return `freshReason` — all without changing
  runner resolution or continuity-selection semantics;
- `src/status.ts`, `src/status-panel.ts`, `src/plain-render.ts` — extend
  `ResolvedRunnerDisplay` (`status.ts:59-65`) with `role`/`phase`/`effort`/
  `sessionStrategy`, add the `activeInvocation?: ActiveInvocationDisplay` field
  to `PanelContext`, and render the existing `resolvedRunners` loop
  (`status-panel.ts:33-40`) as the "Run configuration" section plus the
  "Active invocation" line (do not add a parallel runner field);
- `src/cli-output.ts` — explicit normal-screen static-output lifecycle on both
  `createPanelCliOutput` and `createPlainCliOutput`;
- `src/cli.ts` — only if status output construction needs wiring changes;
- `tests/helpers/mock-output.ts` — add a `writeStatic` capture (recording the
  last static text) plus a base `writeStatic: () => {}` stub, so the
  `tests/status-action.test.ts` migration can assert against rendered static
  text;
- focused unit and command-level interaction tests, including the full rewrite
  of `tests/status-action.test.ts` onto the `writeStatic`-capture harness (see
  "Migration of existing status assertions");
- `README.md` and `docs/architecture/overview.md` — document the corrected
  menus, snapshot, status behavior, and alternate-screen boundary.

Do not modify the manifest schema merely to support display. All required task,
skill, role, target, output, and runner information already exists in `Config`.

## Implementation Review Checkpoints

The implementation agent should present the change in the same six slices (or
commits) where practical. The reviewer should reject the implementation if any
checkpoint fails:

1. **Characterization first:** the real failure shape is captured before the
   scanner fix; fixtures use valid computed identities rather than hand-waved
   placeholder digests.
2. **Scanner containment:** the diff in classification logic is localized and
   negative validation remains exercised; no artifact is rewritten.
3. **One-scan snapshot:** one command/menu refresh performs one global scan;
   pure derivations consume that snapshot.
4. **Terminal containment:** no static path enters the alternate screen and no
   live path loses cleanup/restoration.
5. **Navigation containment:** menu Back/cancel/display paths do not reach
   ownership admission, provider spawn, or the setup retry budget.
6. **Display-only runner data:** selected runner and active continuity records
   flow from the engine to the panel; UI modules contain no runner/session
   decision logic.
7. **Headless compatibility:** explicit `--loop`, `--task`, and `--pipeline`
   runs do not see startup menus, task-detail confirmation, or acknowledgement
   prompts.
8. **No framework expansion:** no React, Ink, OpenTUI, Blessed, or other TUI
   dependency is introduced.

When reporting completion, the implementation artifact must identify which
tests prove each checkpoint and explicitly list any production file changed
outside the Expected Files section. An unexplained change outside that boundary
requires review before acceptance.

## Verification

### View-model and renderer tests

- Empty history shows every configured binding with `none`, not a fabricated
  completion.
- Latest valid evaluate/repair/task artifacts show path, normalized result,
  provider, exact model, effort/default, and session facts.
- Matching unclassified artifacts are counted per binding in compact mode and
  listed with their path and `unclassifiedReason` in detailed mode. The test
  must assert that the reason distinguishes the actual failure cause (identity
  field mismatch vs. pattern mismatch vs. lineage invalid vs. contract failure);
  a generic/fabricated reason must not pass.
- A regression assertion verifies that adding `unclassifiedReason` does not
  change classification outside the separately specified pipeline-start
  descendant correction.
- Direct scan-level fixtures cover every `unclassifiedReason` capture path:
  missing/malformed identity, contract failure, identity verification exception,
  structural lineage failure, and chain-order failure. Each asserts the
  cause-specific reason rather than a generic fallback.
- Artifact-writing tests assert that `unclassifiedReason` never appears in
  durable front matter.
- Missing inputs appear only on the affected binding.
- Eligible and stale suggestions reuse existing candidate evidence and render
  distinct availability/reasons.
- Suggested-loop text includes a composed reason (derived from
  the one passed snapshot via `recoverInProgressRun`, interrupted marker, loop
  mtime ordering, and the manifest's first configured loop), never claims
  automatic execution, and performs no additional project scan.
- Compact and detailed output are stable without color.

### Menu tests

- The top-level menu contains exactly one `Execute one-off task` action whether
  zero, one, or many tasks are configured.
- With no tasks, that action remains visible and displays
  `(unavailable: no tasks configured in manifest)`.
- The task chooser lists configured tasks, not unbound skills.
- Task details resolve role and skill paths against `manifestRoot`, while target
  and output paths remain project-root based.
- A missing-input task remains visible and cannot be selected for execution.
- Task `Back` navigation does not consume the setup retry budget and never
  admits ownership or spawns a provider.
- Every disabled top-level, loop, task, pipeline, suggestion, effort, and session
  choice uses the explicit standardized label and boolean disabled state.
- Recommended and unavailable cannot appear on the same choice.

### Static-output and command tests

- Interactive startup prints the compact snapshot before the first prompt.
- `Display pipeline and project state` prints detailed state on the normal
  screen, waits for acknowledgement, and then returns to the main menu.
- Re-entering the menu does not erase the detailed view from captured output.
- `orc status` writes no alternate-screen enter/exit or cursor-clear sequences,
  prints once, and exits without prompting.
- Live execution still enters the alternate screen only through the live-region
  lifecycle and restores the main screen on success, failure, interruption, and
  thrown errors.
- **Plain-path static output** (new behavior): a direct
  `createPlainCliOutput.writeStatic(text)` unit test in
  `tests/cli-output.test.ts` asserts the written text is non-empty and contains
  no `\x1b[?1049h`, `\x1b[?1049l`, or `\x1b[H\x1b[2J` sequences. This exercises
  the plain `writeStatic` introduced for smash `--plain`; `orc status` always
  uses the panel output and is covered by the no-ANSI assertion above, so do not
  label this test "plain orc status" (that CLI mode does not exist).
- Plain mode remains append-only and receives static snapshot/status text
  without screen-control sequences.
- Interaction tests exercise actual prompt choice objects and captured terminal
  output, rather than only testing semantic menu arrays.
- Explicit `--loop`, `--task`, and `--pipeline` command tests assert that no
  interactive top-level/task/status acknowledgement prompt is called.
- Existing typed-event sequences for a successful loop, provider failure,
  timeout, interruption, and ownership loss remain identical except for static
  display calls, which are not events.

### Live runner and continuity display tests

- Before the first provider call, the live panel lists every selected skill with
  role, provider, exact model, effort/default, and session policy.
- The "Run configuration" rows are carried by the existing
  `PanelContext.resolvedRunners` field (the extended `ResolvedRunnerDisplay`),
  populated from the already-resolved `runners` map in `executeLoopStep` — not a
  parallel `selectedRunners` field. Assert `resolvedRunners` is non-empty during
  a live multi-skill (evaluate + repair) run.
- While evaluate runs, the repair selection remains visible, and vice versa.
- A resumable matching predecessor renders `resumed` and its prior session ID
  before spawn completes; a new invocation renders `fresh` plus the applicable
  `freshReason` (sourced from the extended `resolveContinuity` return value,
  never inferred inside the renderer) and `new session ID: pending` where
  appropriate.
- After completion, the timeline records the provider-reported session ID or
  `none` without changing the selected policy row.
- The display path receives continuity already resolved by the binding engine;
  tests prove the renderer does not call runner or continuity resolution.

### Pipeline-start rescan regression

- Build a real three-artifact pipeline-start chain: evaluate v1 `REJECTED`,
  repair v1 `COMPLETED`, evaluate v2 `APPROVED`.
- Persist and rescan it through `scanGlobalSnapshot`; all three artifacts remain
  classified and retain provider, exact model, duration, decision/outcome,
  session strategy, session ID, chain/run/stage identity, and immediate parent.
- Status resolves the final state as accepted, not
  `latest evaluation is unparseable`, and the completed stage is eligible under
  the existing pipeline rules.
- Negative fixtures remain rejected: non-first-stage forged pipeline starts,
  roots with non-null parents, descendants with missing/wrong-chain parents,
  stale fingerprints, foreign runs, and wrong-stage bindings.

### Migration of existing status assertions

This plan retires the **entire** `renderPanel`-capture harness in
`tests/status-action.test.ts`, not just the pipeline-suggestion lines. All eight
tests in that file capture state through a single `renderPanel` override
(`tests/status-action.test.ts:16-18`, where the module-level `panel` variable is
assigned only inside `renderPanel`) and assert on `panel.loopName`,
`panel.readOnly`, `panel.timeline`, and `panel.nextStepMessage`. Under this plan
`statusAction` stops building a `PanelContext` and stops calling
`output.renderPanel`; it builds the new view model and calls
`output.writeStatic(text)` instead (the `buildPanelContext(...) +
output.renderPanel(panelCtx)` pair at `src/commands/status.ts:125-138` is
replaced by view-model construction + `output.writeStatic`). The shared mock
`tests/helpers/mock-output.ts` has **no `writeStatic` capture** today
(`mock-output.ts:16` stubs only `renderPanel: () => {}`), so without the changes
below `panel` stays `null` and every one of the eight tests fails — not only the
two the migration used to name.

The implementer must:

1. Add a `writeStatic` capture to `tests/helpers/mock-output.ts` that records
   the last static text written (mirroring the existing `renderPanel` override
   pattern at `mock-output.ts:16`), and add a base `writeStatic: () => {}` stub
   so non-status tests keep typechecking.
2. Rewrite **all eight** tests to assert against the rendered static text (or
   against the new `ProjectSnapshotView` model directly), preserving exactly
   this coverage:
   - fresh next-step text (`plan-audit`, `version 1`, read-only);
   - retry as repair then the next evaluation (`plan-follow-up`, `version 2`);
   - accepted evaluation as completed;
   - `--all` task visibility (the `implement` binding appears);
   - interrupted-marker text and the interrupted timeline step;
   - eligible pipeline-suggestion evidence (stage, run id, predecessor,
     completion artifact, artifact identity, decision/outcome, fingerprint
     validity);
   - stale pipeline-suggestion drift (recorded vs current fingerprint);
   - concurrently eligible runs in stable order.
3. Replace the `buildPanelContext(...) + output.renderPanel(panelCtx)` pair in
   `src/commands/status.ts` (`:125-138`) with view-model construction +
   `output.writeStatic(text)`.

Name `tests/helpers/mock-output.ts` and `src/commands/status.ts` in Expected
Files for this work. The eligibility/stale-drift/stable-ordering coverage is
**migrated, not silently dropped**; the migration must be called out in the
implementation PR.

### Regression gates

Run:

```bash
pnpm run typecheck
pnpm run build
pnpm test
git diff --check
```

The existing deterministic pipeline identity, artifact classification,
continuity, runner selection, timeout, interruption, ownership, and kill-gate
tests must remain green. The pipeline-start correction requires the focused
persist/rescan regression above but no real-provider or macOS supervisor gate:
it changes neither provider execution nor shared launcher/ownership boundaries.
If implementation expands into one of those boundaries, the corresponding gate
becomes mandatory.

Explicitly note two deliberate output changes. (1) `orc status` today uses
`createPanelCliOutput.renderPanel` → `panelDraw` (`src/cli-output.ts:90-93`),
which emits `\x1b[?1049h` + `\x1b[H\x1b[2J` plus a boxen-wrapped panel even when
piped; after this plan it calls `writeStatic`, so piped `orc status` becomes
plain normal-screen text with no escape sequences. (2) Smash `--plain` gains a
`writeStatic` operation it did not have (its `renderPanel` was a no-op). Both
are **deliberate new behaviors**, not regressions. The regression gates must
include the no-ANSI captured-stdout assertions (see Static-output and command
tests above) so these changes are reviewed, not accidental.

## Acceptance Criteria

The work is complete only when a manual run against a project with a mixture of
valid, absent, and unclassified artifacts demonstrates all of the following:

1. The first screen identifies the project and config and summarizes every
   configured binding's latest evidence and exact runner.
2. Any loop suggestion is accompanied by a reason and is not auto-executed.
3. `Execute one-off task` opens a task chooser and task detail before runner
   selection.
4. Disabled actions are visibly and grammatically separated from their reasons.
5. Detailed project state remains in terminal scrollback after returning to the
   menu.
6. Standalone `orc status` is persistent, non-interactive, and free of alternate
   screen escape sequences.
7. Historical/unclassified artifacts are explained with a per-artifact
   classification-failure reason (sourced from `Step.unclassifiedReason`,
   distinguishing the actual cause — identity mismatch, pattern mismatch,
   lineage invalid, contract failure) and do not unlock workflow actions.
8. Live provider execution, events, logging, ownership, and process safety are
   behaviorally unchanged.
9. The live panel continuously shows both selected skill runners, including
   exact models, effort/default, and session policies, and separately identifies
   the active invocation as fresh or resumed before it finishes.
10. A completed pipeline-start evaluate/repair/evaluate chain rescans as the
    same valid accepted chain; status does not replace descendant metadata with
    `unknown` or report the latest evaluation as unparseable.

## Non-goals

- Replacing Inquirer or adopting a full TUI framework in this change.
- Changing artifact provenance, fingerprints, or eligibility, or changing
  classification beyond the explicitly demonstrated pipeline-start descendant
  reader correction.
- Migrating or blessing historical artifacts.
- Automatically selecting or starting a suggested loop/stage.
- Adding new task or skill definitions.
- Changing runner/model/effort/session resolution.
- Changing plain event schemas, debug logging, provider adapters, timeouts,
  interruption handling, ownership, the supervisor contract, or signal logic.
