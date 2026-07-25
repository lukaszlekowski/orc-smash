# Plan — Runner selection and continuity UX (follow-up batch 2)

**Confidence: 0.96**

This plan implements **Batch 2 — Runner selection and continuity UX** from
`docs/dev/archived/follow-up.md` (all **four** checklist items, including the
*Start suggested stage* editable-default labeling in D8). It changes runner
presentation and selection only; artifact-chain and pipeline identity, runtime
continuity policy, and all provider/adapter behavior are preserved.

## Status

Draft for the `plan` approval loop.

## Objective

1. **Continuation defaults:** *Continue current loop* preselects each skill's
   runner from the latest compatible provider/model/effort/session metadata in
   that exact chain; the configured profile remains a visible fallback.
   Recommendation labels state their scope ("recommended next action") and
   never imply a recommended model.
2. **Effort-only selection:** a configured default runner can change effort
   without re-selecting provider/model, while preserving the three-way
   distinction between *provider default*, *configured default effort*, and
   *operator effort*.
3. **Requested vs effective effort:** pre-spawn catalogue validation stays;
   provenance and status call the recorded value *requested* effort; a defined
   adapter contract surfaces a bounded mismatch warning when — and only when —
   a provider's structured stream reports the effective model or variant.
4. **Suggested-stage honesty (item 4):** *Start suggested stage* presents its
   displayed runners as **editable defaults** and makes explicit that runner
   selection happens **before execution** — for a one-skill successor and for a
   two-skill approval-loop pair alike — without implying that a custom
   provider/model/effort changes pipeline identity.

## Scope

- `src/interactive.ts` (`promptRunners` contract and menus, including the
  pre-selection preamble reworded in D8),
  `src/stage-menu.ts` (the `start-suggested-stage` action label in D8),
  `src/commands/smash.ts` (continuation flow and labels, the suggested-stage
  branch in D8, and the consolidated `runner.resolved` emitter in D4);
- one new pure module `src/continuation-runners.ts` owning the shared
  chain-candidate walk, runtime session-compatibility rule (moved, unchanged),
  and continuation preselection derivation;
- `src/runner.ts` attribution (`'session'` sources), `src/adapters/types.ts`
  (`RunResult` effective-telemetry fields), `src/adapters/completion.ts`
  (confirmation normalization), `src/provenance.ts` (two optional fields),
  `src/state.ts` + `src/artifact-index.ts` (so the new fields traverse
  `ArtifactMeta → Step → view`, per C2), `src/project-snapshot-view.ts`
  (requested-effort vocabulary);
- deterministic unit, interactive-flow, adapter-arg, provenance, and e2e
  regression tests.

## Non-goals

- No change to runtime continuity policy: the chain-walk boundary rules and
  tuple comparison behave exactly as today (the function is moved, not
  modified). Second opinions remain fresh. An incompatible runner change
  starts a fresh provider session, never a fresh artifact chain.
- No provider-specific menu logic: menus consume only catalogue
  (`models`, `modelEfforts`, `efforts`) and adapter-capability data.
- No non-interactive behavior change: `--loop`/`--task`/`--pipeline` and CLI
  runner overrides resolve exactly as today. Continuation defaults are an
  interactive-continuation feature only. (The consolidated `runner.resolved`
  emitter in D4 moves the emit call site out of `smash.ts` setup into the
  binding-run entry at `src/loops/binding-engine.ts:146`, where it still
  precedes every provider spawn and fires exactly once per skill; the
  *resolution* semantics — which runner is chosen, which overrides apply — are
  unchanged for every flow.)
- No stage-continuation **chain** preselection for *Start suggested stage*
  (M1 scope boundary). The follow-up scopes item-1 chain preselection to
  *Continue current loop* (`follow-up.md:161-163`), whose latest chain
  candidate is a **same-skill** prior record in the *active* chain. *Start
  suggested stage* begins a **new** `stage-continuation` chain from a
  predecessor of a **different** skill/phase, so there is no same-skill prior
  record in the predecessor chain to preselect. D8 therefore labels the
  suggested-stage displayed runner as an editable `configured profile` default
  (never a *Use defaults* label) and pins that both entry points surface their
  preselection *source* explicitly, so the chain-vs-profile difference is
  visible and tested rather than silent. Threading same-skill chain
  preselection into the suggested-stage path is deferred to a later batch.
- No scraping of terminal text, capture logs, debug output, or output-quality
  inference to determine effective effort. Provider catalogues remain
  maintained configuration.
- No effective-*model* persistence and no new adapter capabilities claims;
  model mismatch is warning-only like effort, and no production adapter
  declares effective-effort telemetry in this batch (verified absent — D7).
- No automatic downstream transitions; preselection never changes candidate
  eligibility, chain reduction, or pipeline lineage.
- Batch 3+ items (decision correction, configured tasks/commit skill,
  provider progress telemetry, blocked-ledger outcomes) are out of scope.

## Current behavior (verified root causes)

- **Continuation preselection.** The interactive *Continue current loop* path
  defers runner selection to `binding-engine.resolveBindingRunners` →
  `promptRunners`, whose defaults come from
  `resolveRunner(skillId, config, …)` — the configured profile. The
  `continueDetail` submenu label (`smash.ts:615-648`) resolves the same
  profile tuple. Compatible chain metadata (provider/model/effort/session in
  artifact provenance) is not consulted, and `ResolvedRunner`'s `'session'`
  source members and `inheritedSession` exist but are never assigned.
- **Recommendation label.** `interactive.ts:formatMenuChoice` appends
  `(recommended)`; nothing states that the recommendation scopes to the next
  workflow action, not the displayed runner.
- **Effort-only gap.** `promptRunners` asks one yes/no *customize* confirm;
  declining returns the configured runner immediately, so the configured
  model's `modelEfforts` are unreachable without re-selecting provider and
  model. There is also no way to explicitly request *provider default* when a
  configured default effort exists, because the default-accept path copies the
  configured effort.
- **Requested vs effective.** Provenance records the requested effort and the
  opencode adapter maps it to exactly one `--variant` (untested today). The
  opencode v1.18.4 `--format json` stream is source-verified to expose
  **neither** the effective model **nor** the effective variant
  (`step_start`/`step_finish`/`text`/`reasoning`/`tool_use`/`error` carry no
  such fields; the `message.updated` event that carries them is suppressed in
  JSON mode). Codex JSONL, Claude's final JSON, and AGY expose no parsed
  effort field either. Nothing in status or provenance distinguishes
  "requested" from "provider-confirmed".

## Normative decisions

### D1 — Recommendation labels are explicitly next-action-scoped (item 1)

**Design.** `formatMenuChoice` (`src/interactive.ts`) renders the suffix
`(recommended next action)` instead of `(recommended)`. This is the single
canonical change: every menu recommendation in the application is a workflow
action recommendation, so the global suffix stays honest everywhere. The
*Continue current loop* label additionally names the actual preselected
runner with its source (D3), so the label never reads as endorsing a model.

**File impact.** `src/interactive.ts`; suffix assertions in
`tests/stage-menu.test.ts`, `tests/interactive.test.ts`,
`tests/terminal-surfaces.test.ts`.

**Verification.**

- Menus render `(recommended next action)`; no surface renders a bare
  `(recommended)`.
- Tests distinguish "recommended next action" from any model recommendation;
  no label implies the displayed provider/model is recommended.

### D2 — One continuity seam: `src/continuation-runners.ts` (foundation)

**Design.** A new pure module owns per-skill continuation runner knowledge:

- `resolveContinuity` and its `ResumeRecord` walk move here from
  `src/loops/binding-engine.ts`, behavior-identical (same boundary stop at
  `accepted`, same chain scoping, same tuple/session/capability comparison,
  and the same three `freshReason` derivations). `binding-engine.ts` imports
  it.
- A shared `latestChainRunnerCandidate(history, chainId, skillId)` helper
  performs the one canonical chain walk (backwards, first same-skill record).
  The walk **stops** on a record whose `decision === 'accepted'` but does
  **not** stop on a `completion` record — a repair-completed artifact is part
  of the normal loop cycle, not a boundary — matching
  `src/loops/binding-engine.ts:798-802` verbatim. Both the runtime rule and
  the new preselection derivation (D3) use this one helper — no forked walk.

**File impact.** New `src/continuation-runners.ts`;
`src/loops/binding-engine.ts` (import instead of local definition);
`tests/continuation-runners.test.ts` (new direct unit tests).

**Verification.**

- Existing continuity suites (`tests/loop-continuity.test.ts`,
  `tests/loop-followup-runner.test.ts`) pass unmodified.
- A new direct unit test for `continuation-runners.ts` covers:
  the accepted-boundary stop (no resume across an accepted artifact);
  the completion-non-boundary case (a same-skill record past a completion is
  still found); the no-compatible-session case; and the provider-unsupported
  case. Today these are only exercised indirectly through the e2e suites; the
  extracted helper gets its own pinned tests so the boundary semantics cannot
  regress silently.

### D3 — Chain-derived continuation defaults with visible fallback (item 1)

**Design.** `continuation-runners.ts` also exports a pure derivation:

```ts
export interface RunnerPreselection {
  source: 'chain' | 'profile';
  agent: string;
  model: string;
  effort?: string;
  sessionStrategy?: string;
  sessionId?: string;          // chain only: resumable session recorded
  fromStep?: { phase: string; version: number };
  fallbackReason?: string;     // profile only: why no chain candidate won
}
export function continuationRunnerDefaults(input: {
  steps: Step[];               // binding-scoped steps from the global snapshot
  chainId: string;
  skillIds: string[];          // the complete upcoming pair for a loop
  config: Config;
  registry: AgentRegistry;
}): Map<string, RunnerPreselection>;
```

Per skill, the latest chain candidate (via D2's walk) is offered as the default
when **sensible**, and the configured profile is the visible fallback otherwise.
Two concerns are kept strictly separate so the continuity *prediction* can never
drift from the runtime rule (v2 M1):

1. **Continuity prediction — one source of truth.** Whether accepting a given
   runner resumes a session is computed by the **same** predicate at all three
   sites (preselection, the D4 summary recompute, spawn): the moved
   `resolveContinuity` rule (D2 — same-skill record via the canonical walk +
   non-empty `sessionId` + agent/model/effort **tuple match** + registered
   adapter with `capabilities.resumeSession`). Preselection and the summary
   *call* the moved function; spawn calls it. There is **no** separate
   compatibility gate on the prediction path, so for every model the harness
   permits — including a valid opencode model configured by namespace
   (`isOpencodeModelId`, `src/runner.ts:18-20`) that is **not** listed in the
   packaged `catalogue.models` — the predicted outcome equals the spawn outcome.
   (The v1 catalogue-membership gate is removed precisely because it forked this
   prediction from runtime `resolveContinuity`, which has no catalogue gate at
   `src/loops/binding-engine.ts:808-816`.)
2. **Default-vs-fallback filter — presentation only.** Which candidate is
   *offered* as the default, and the fallback reason, use a weaker filter that
   never touches the prediction: adapter registered (else `unknown adapter`);
   model valid per `isValidModelForAgent` (`src/runner.ts:22-32`) — the **same**
   validity the rest of the harness uses, not a stricter catalogue-membership
   gate, so a namespaced-but-unlisted opencode model is *valid* here (else, for
   a claude/codex/agy model id that no longer matches its prefix,
   `model no longer in catalogue`); and recorded effort (if any) validated by a
   **continuation-specific effort predicate that gates on catalogue membership**
   (v3 M1): if the model **is** listed in `catalogue.models`, validate the
   effort with `isValidEffortForModel` (`src/runner.ts:34-41`; else
   `effort no longer offered`); if the model is valid-by-namespace but **not**
   in `catalogue.models`, do **not** call `isValidEffortForModel` — its body
   returns `false` for any non-catalogue model at `src/runner.ts:38` before it
   ever checks effort levels, so calling it would silently re-introduce the
   catalogue gate the *model* check just removed. Instead the derivation
   **accepts the recorded effort** (the harness has no configured levels to
   validate a custom model against) and attaches the non-blocking note below.
   A candidate that passes is offered as the `Use chain runner` default; one
   that fails a check falls back to the configured profile with the matching
   bounded `fallbackReason` (`no chain step for this skill`, `unknown adapter`,
   `model no longer in catalogue`, `effort no longer offered`). Catalogue
   staleness that does **not** invalidate the model — a valid namespaced opencode
   model absent from `catalogue.models`, **whether or not it carries a recorded
   effort** — is surfaced as a **non-blocking note**
   (`note: model not in current catalogue`) on an otherwise-compatible
   preselection, **not** as a fallback trigger, so it cannot desync the offered
   default (or the prediction) from the runtime, which resumes such a model when
   its tuple matches. `RunnerPreselection.fromStep` records which chain step the
   preselection came from and is surfaced by the D4 resolved-runner summary
   (e.g. `from chain repair v3`); it is not an unused field.

Consumers (one computation, no drift): the *Continue current loop* branch in
`src/commands/smash.ts` computes the map once from the recovered chain
(`recoverResumableLoopChain` + binding-scoped steps) and uses it for (a) the
`continueDetail` submenu label — replacing today's profile-only
`resolveRunner` label — and (b) a new `continuationDefaults` field threaded
through `SmashRunSetup` → `LoopOptions`/`BindingEngineOptions` →
`resolveBindingRunners` → `promptRunners`. Second opinions, fresh loops,
suggested-stage starts (new chains), and non-interactive runs pass no
preselections.

Attribution: an accepted chain preselection resolves with
`agentSource`/`modelSource` = `'session'` (activating the reserved union
members), `effortSource`/`sessionStrategySource` gain `'session'`, and
`inheritedSession` is set when resumable. `promptRunners` recomputes expected
continuity for the *final* per-skill runner through the same D2 comparison
(runner tuple vs candidate tuple + session/capability) and keeps
`inheritedSession` only when the operator's choice still resumes — changing
agent, model, or effort drops it and the summary says why. Runtime
`resolveContinuity` re-derives the same outcome at spawn; the status panel's
*Active invocation* remains the authoritative pre-spawn display.

**File impact.** `src/continuation-runners.ts` (derivation),
`src/commands/smash.ts`, `src/runner.ts` (source unions),
`src/loops/binding-engine.ts` (options threading), `src/interactive.ts`
(preselection display), `src/loops/runtime.ts` (options type).

**Verification.**

- A compatible chain runner is preselected instead of the configured profile
  (pure-derivation tests with fixture chains; fake-registry capability cases).
- With no compatible chain runner, the configured profile is shown explicitly
  as a fallback with its reason — never silently under a generic *Use
  defaults* label.
- An incompatible operator override displays `fresh session` with a reason
  while the action still reads *continue current loop*; the artifact chain
  continues (existing continuity e2e semantics).
- A compatible unchanged runner displays the session ID that will be resumed.
- A chain candidate for a **catalogue-listed** model whose effort the current
  catalogue no longer offers falls back to the configured profile with the
  `effort no longer offered` reason.
- Reason-to-condition mapping is explicit and honest for every provider: a
  candidate whose model fails `isValidModelForAgent` (e.g. a claude/codex/agy id
  that no longer matches its prefix) yields `model no longer in catalogue`; a
  catalogue-listed model whose effort `isValidEffortForModel` rejects yields
  `effort no longer offered`. A valid namespaced opencode model absent from
  `catalogue.models` is **compatible** and carries the non-blocking note
  `model not in current catalogue` (it is *not* fallen back) — verified with
  **two** fixtures (v3 M1): one **without** a recorded effort and one **with**
  a recorded effort (e.g. `opencode-go/<custom>` previously run with `max`).
  Both are offered as the `Use chain runner` default with the note, neither
  fallen back — the with-effort case must not reach `isValidEffortForModel`
  (which would reject a non-catalogue model at `src/runner.ts:38`).
- The continuity **prediction never drifts from runtime** (v2 M1): for an
  **effort-only** override, an **agent/model** override, and a fixture with a
  **valid non-catalogue opencode model** (namespaced id not in
  `catalogue.models`, configured via profile), the preselection/summary-predicted
  `continuity.mode` / `sessionId` equals the `resolveContinuity`-produced
  outcome at spawn, for **both** skills of the pair. This holds because all
  three sites call the same moved `resolveContinuity` predicate — the
  default-vs-fallback filter (isValidModelForAgent / isValidEffortForModel) does
  not touch the prediction.
- Both loop skills receive preselections up front (complete pair; no
  re-prompt between steps).

### D4 — The resolved-runner summary shows source and predicted continuity (item 1)

**Design.** `promptRunners` gains a post-selection summary (printed once per
run, after all skills are chosen) **in addition to** — not replacing — the
reworded pre-selection preamble owned by D8. The two blocks have distinct jobs
(v2 M2): the preamble (`src/interactive.ts:204-212`, reworded by D8 to
`Runner defaults (editable before execution):`) is the editable *preview* before
selection (and the only preview on the `forceSelect` path, which has no
three-way menu); the post-selection summary is the separate committed-source /
continuity *readout* printed after every skill is chosen. Per skill the summary
shows: skill and role; provider; model; effort or provider default; choice
source (`chain metadata` / `configured profile` / `operator selection`); the
originating chain step when the source is chain metadata (e.g.
`from chain repair v3`, read from `RunnerPreselection.fromStep` — D3/m3);
continuity policy; and predicted outcome (`resumes session *a1b2c` or
`fresh session (reason)`).

**Single `runner.resolved` emitter (v1 M2).** `resolveBindingRunners`
(`src/loops/binding-engine.ts:472`, invoked for every loop/task run at line
146) becomes the **sole** `runner.resolved` emitter. `src/commands/smash.ts`
stops emitting — both the interactive-path emit at `smash.ts:311-322` and the
non-interactive-path emit at `smash.ts:336-344` are removed. The two `smash.ts`
branches differ and are stated separately (v2 m3): the **promptRunners-path**
(`smash.ts:297-329`, interactive suggested-stage / fresh) consumes the
`ResolvedRunner`s returned by `promptRunners`, `validateRunnerCapabilities`-
checks them directly, and assigns into `runners` (it does **not** call
`resolveRunner` — see D5); the **non-promptRunners-path** (`smash.ts:330-344`,
explicit `--loop`/`--task`/`--pipeline` / CLI overrides, which never call
`promptRunners`) keeps `resolveRunner` + `validateRunnerCapabilities` + assign.
Neither branch emits; the *resolution* is unchanged and only the emit call site
moves into the binding-run entry, where it precedes every provider spawn. (The
`validateRunnerCapabilities` retained in `smash.ts` is an intentional pre-run
fast-fail; `resolveBindingRunners` validates again as the emitter owner —
idempotent belt-and-suspenders, v2 m2.) Inside `resolveBindingRunners`, replace
the blanket `if (runners[skillId]) continue;` skip (`binding-engine.ts:484`)
with two distinct guards: (a) never re-resolve — do not call `resolveRunner`
for a skill already present in `runners`; (b) `validateRunnerCapabilities`-check
and emit each skill **exactly once**, tracked by an `emitted: Set<string>`. A
runner placed into `runners` by either `smash.ts` branch or by the internal
`promptRunners` call at `binding-engine.ts:480` (the Continue path) is
therefore emitted one time — closing the prompted-runner gap without any double
emit. The unified event carries `agentSource` / `modelSource` / `effortSource`
(including the new `'session'` members from D3) and `inheritedSession` (today
only the `smash.ts` emit included it), so every interactive flow emits one
fully-attributed `runner.resolved` per skill.

**File impact.** `src/interactive.ts`, `src/loops/binding-engine.ts`
(sole emitter + skip restructure), `src/commands/smash.ts` (emit removal),
`tests/interactive.test.ts`, `tests/model-efforts-regression.test.ts`.

**Verification.**

- The summary lists every field per skill (including the originating chain
  step when the source is chain metadata) and matches the actual pre-spawn
  continuity outcome for the first step.
- `runner.resolved` is emitted exactly once per skill for every interactive
  flow, with accurate source attribution (`session` vs `profile` vs
  `interactive`) — a single test counts the events per skill across all entry
  points (suggested stage, continue, fresh loop, second opinion, task) and
  asserts the count is `1` for each, with no double emit on the
  suggested-stage path that previously emitted in `smash.ts`.

### D5 — Per-skill three-way runner menu with an effort-only path (item 2)

**Design.** `promptRunners` gets a **contract rewrite** (not a minor tweak): its
return type changes from the stripped
`Record<string, { agent; model; effort?; sessionStrategy? }>` with no source
attribution (`src/interactive.ts:182-188,341-349`) to a map of fully attributed
`ResolvedRunner`s; it gains a new `preselections: Map<string, RunnerPreselection>`
input (D3); and its menu becomes the per-skill three-way choice below. Both call
sites must pass and consume preselections **identically**:
`src/commands/smash.ts:299` calls `promptRunners(skills, …)` with **all** loop
skills (the suggested-stage / fresh path), while
`src/loops/binding-engine.ts:480` calls `promptRunners(missing, …)` with
**only missing** skills (the Continue path). Preselection derivation (D3)
covers the complete skill pair in both cases: the all-skills call receives a
preselection for every skill and the missing-only call receives preselections
for the missing skills only, so each skill's first menu option reflects its
actual preselection source. Both consumers stop re-resolving the returned
runners: `smash.ts` validates them directly (and, per D4, no longer emits);
`binding-engine.ts` assigns them and the D4 sole emitter handles emission.
`tests/interactive.test.ts` and `tests/model-efforts-regression.test.ts` mock
sequences (e.g. the `select`/`confirm` chains assuming the old yes/no customize
flow) are deliberately rewritten to the new menu. When defaults exist and
`forceSelect` is not set, each skill gets the three-way choice from the
follow-up document, with the first option reflecting the actual preselection
source (D3):

```text
plan-audit (auditor): claude · glm-5.2[1m] — chain metadata, session *a1b2c
Choose runner configuration:
  Use chain runner (resumes session *a1b2c)
  Change effort only
  Customize provider, model, effort, and session
```

(`Use configured runner — no compatible chain runner: <reason>` in the
fallback case.) `forceSelect` keeps bypassing straight to full customization.
*Change effort only* retains the preselected provider/model and session
strategy, and lists `Provider default` plus exactly the levels configured for
that model (`modelEfforts[model] ?? efforts`), preselecting the currently
effective effort when one exists. Models without configured levels and agents
without effort capability keep `Provider default` available alongside a
disabled row explaining why (`no effort levels configured for model 'X'` /
`X does not support effort`).

**File impact.** `src/interactive.ts` (menu + return contract),
`src/commands/smash.ts` and `src/loops/binding-engine.ts` (consumption),
`tests/interactive.test.ts`, `tests/model-efforts-regression.test.ts`
(deliberately updated to the new flow).

**Verification.**

- A configured default model exposes its `modelEfforts` without
  provider/model reselection.
- The three-way menu renders per skill; `forceSelect` behavior is unchanged.
- Agent/model catalogues and profiles are never mutated by interactive
  selection (deep-equality assertion on `config.registry` across the prompt).

### D6 — Three effort states stay distinct end to end (item 2)

**Design.** The final `ResolvedRunner` preserves the three-way distinction:

- **Accept configured/chain runner:** the pre-resolved runner object is
  returned unchanged (effort present with its `profile`/`session` source when
  configured).
- **Operator effort:** `effortSource: 'interactive'` on the same
  provider/model; when the base was a chain preselection,
  agent/model keep `source: 'session'` and expected continuity is recomputed
  (D3) — an effort change predicts and produces a fresh session.
- **Explicit Provider default:** no `effort`/`effortSource` on the runner,
  even when a configured default effort exists, so the adapter emits no
  effort flag. This is structurally distinct from accepting a configured
  effort, and no path uses `undefined` to mean both.

Levels come from the catalogue menu, and the final runner is asserted against
`isValidEffortForModel` as a defensive check (validation through the existing
generic catalogue; no menu-specific rules).

**File impact.** `src/interactive.ts`, `src/runner.ts` (unchanged resolver;
consumed for the configured/customize paths).

**Verification.**

- Selecting `max` retains the default provider/model and invokes the adapter
  with `max` (arg-level assertion through the adapter `buildRun`).
- Selecting Provider default emits no effort flag even when a configured
  default effort exists (`--variant`/`--effort` absent from built args).
- Accepting the configured runner retains its configured effort and source.

### D7 — Requested-vs-effective effort contract with bounded mismatch surfacing (item 3)

**Design.**

- `RunResult` (`src/adapters/types.ts`) gains `effectiveModel?: string` and
  `effectiveEffort?: string`, documented as **structured provider telemetry
  only**. No production adapter populates them in this batch — opencode
  v1.18.4's JSON stream is verified to expose neither field, and codex,
  claude, and agy have no verified surface. The `fake` adapter can inject
  them for deterministic tests.
- `src/adapters/completion.ts` (the existing RunResult normalization home)
  gains a pure `resolveEffortConfirmation(runner, result)` with **four**
  outcomes (v2 m1 makes the "provider reported an effort with no corresponding
  request" case explicit instead of folding it into `confirmed`, which would
  read as confirming a request that was never made):
  reported-and-equal-to-the-request → `confirmed`;
  reported-and-different-from-the-request → `mismatch`;
  reported-but-no-effort-was-requested → `reported` (the provider confirmed
  what it *used*, but there was no request to confirm — distinct from
  `confirmed`, which means the *requested* effort was honored); nothing
  reported → `requested`. (This `reported` branch is reachable only via fake
  injection this batch; it is defined so the contract is honest the moment a
  real provider exposes the field.)
- After a completed provider step, `execution.ts` compares **both** effective
  fields (`effectiveEffort` and `effectiveModel`) against the resolved runner
  and, on any mismatch in either, emits a bounded warning via the **existing**
  `output.warn` + the existing `{ type: 'warning'; message: string }` run event
  (`src/cli-output.ts:29,126`; `src/run-event.ts:41`), containing only the two
  values — never provider text. No new `provider.effort-mismatch` /
  `provider.model-mismatch` event types are added: no downstream consumer (the
  status panel, the plain event log, provenance) keys off a typed
  effort-mismatch variant, and provenance already records the structured
  `effortStatus: 'mismatch'` (below) for any consumer that needs the typed
  signal. A mismatch is a warning, not a failure: the provider exited
  successfully and the artifact contract remains the terminal authority. The two
  mismatch paths persist asymmetrically by design (v3 m1): an **effort**
  mismatch persists `effortStatus: 'mismatch'` in `ArtifactMeta` (below); a
  **model** mismatch is **warning-only** and is *not* persisted — there is no
  `modelStatus` / `effectiveModel` in `ArtifactMeta` (the effective-model
  persistence Non-goal) — so the model-mismatch path is exercised only through
  the transient warning.
- Provenance: `ArtifactMeta` gains optional `effortStatus?:
  'requested' | 'confirmed' | 'mismatch' | 'reported'` and
  `effectiveEffort?: string`, written by `binding-engine.ts` from the same
  normalization. Both are excluded from `computeArtifactIdentity`; old artifacts
  simply lack them and read as requested. The front-matter `effort:` key (the
  requested value) is unchanged.
- Step pipeline (C2 — required for the vocabulary to render at all): the new
  fields must traverse `ArtifactMeta → Step → view`, not stop at provenance.
  The `Step` interface (`src/state.ts:18`, alongside `effort?` at line 56)
  gains `effortStatus?: 'requested' | 'confirmed' | 'mismatch' | 'reported'`
  and `effectiveEffort?: string`. Both Step builders in `src/artifact-index.ts`
  (the builder near lines 275-303 and the second builder near line 364)
  populate them from `meta.effortStatus` / `meta.effectiveEffort`. Both keys
  are added to the `optionalKeys` round-trip list in
  `src/provenance.ts:234-240` so `parseArtifactMeta` reads them back
  losslessly from written artifacts. Without these three edits the view change
  below does not typecheck and cannot render for any historical or scanned
  artifact — this is the compile-blocking omission the audit raised.
- Display vocabulary: `summarizeStep` (`src/project-snapshot-view.ts:117`,
  which today reads only `step.effort`) consumes `step.effortStatus` /
  `step.effectiveEffort` and renders `requested: <effort>` / `provider default`
  when unconfirmed, `confirmed: <effort>` on confirmation,
  `reported: <effort> (no request)` when the provider reported an effort with no
  request, and `requested <a> → effective <b>` on mismatch; detailed/compact
  renderers keep their structure and consume the view string.
- Catalogue + arg regressions: pin the packaged
  `opencode-go/deepseek-v4-flash` matrix to exactly `[default, high, max]`;
  an explicit unsupported value (`xhigh`) fails in `resolveRunner` before any
  spawn; the opencode adapter maps a supported explicit effort to exactly one
  `--variant` argument.

**File impact.** `src/adapters/types.ts`, `src/adapters/completion.ts`,
`src/adapters/fake.ts` (test injection), `src/loops/execution.ts` (reuses the
existing `output.warn` + `{ type: 'warning' }` event — **no** new event types),
`src/loops/binding-engine.ts` (meta), `src/provenance.ts` (two `ArtifactMeta`
fields + `optionalKeys` round-trip), `src/state.ts` (Step interface fields),
`src/artifact-index.ts` (both Step builders), `src/project-snapshot-view.ts`
(`summarizeStep`), `tests/adapters-args.test.ts`,
`tests/model-efforts-regression.test.ts` (or a packaged-catalogue test), and a
provenance round-trip / re-scan test asserting the new fields survive a
write → `parseArtifactMeta` → Step → view cycle.

**Verification.**

- The packaged DeepSeek Flash catalogue offers only provider default, high,
  and max; `xhigh` fails before provider spawn.
- OpenCode maps a supported explicit effort to exactly one `--variant`.
- A structured effective-variant mismatch (fake-injected) produces the
  bounded warning and `mismatch` provenance; an exact match produces
  `confirmed` and no warning.
- A structured **model** mismatch (fake-injected `effectiveModel` differing
  from the resolved model) produces the same bounded warning; unlike the effort
  case it is **not** persisted — assert the warning fires **and** that no model
  status / `effectiveModel` field is written to `ArtifactMeta` (per the
  effective-model Non-goal). (Fake-only this batch; no production adapter
  exposes `effectiveModel`.)
- Providers without telemetry retain `requested` provenance and requested
  vocabulary everywhere; nothing fabricates confirmation.
- A fixture `confirmed` / `mismatch` / `reported` artifact is written, then
  re-scanned through `parseArtifactMeta` → Step → `summarizeStep`, and the view
  renders `confirmed: <effort>` / `requested <a> → effective <b>` /
  `reported: <effort> (no request)` for the **re-scanned** step — not only a
  freshly-built in-memory step — proving the full pipeline (C2) round-trips the
  new fields for historical/scanned artifacts.
- Artifact identity digests are unchanged by the new optional fields
  (with/without equality test) and old artifacts still classify.

### D8 — Suggested-stage editable-default labeling and selection-before-execution (item 4)

**Design.** The *Start suggested stage* action surface must communicate that
its displayed runners are **editable defaults** and that runner selection
occurs **before execution** — for a one-skill successor and for a two-skill
approval-loop pair alike — without implying that a custom runner changes
pipeline identity (`follow-up.md:97-149`).

- **Action label (`src/stage-menu.ts:93-99`):** the `start-suggested-stage`
  `TopMenuAction` label carries the editable-default hint, e.g.
  `Start suggested stage (runner defaults editable before execution)`. The
  action stays in its existing group with the same availability /
  disabled-reason logic; only the human label and per-candidate detail wording
  change.
- **Candidate detail (`src/commands/smash.ts:495-529`):** in the
  `start-suggested-stage` branch, the candidate selection surface and the
  returned binding summary name the upcoming runner-selection step — e.g.
  `next: choose or confirm provider, model, effort, and session` — and, for a
  two-skill approval-loop successor, state that the complete evaluate/repair
  pair is chosen or confirmed before the first provider invocation. The branch
  still returns `chainMode: 'stage-continuation'` with the predecessor
  pipeline identity (`pipelineId`, `pipelineRunId`, `stageId`,
  `parentArtifactIdentity`) unchanged, so a custom runner still produces a
  `stage-continuation` artifact linked to the predecessor
  (`follow-up.md:140-144`).
- **Pre-selection preamble (`src/interactive.ts:204-212`):** the
  `Default skill runners:` block printed before the customize prompt is
  reworded so the heading reads as an *editable preview*, not a committed
  selection — e.g. `Runner defaults (editable before execution):` — and notes
  that selection happens before execution. The suggested-stage path resolves
  through the `promptRunners(skills, …)` call at `src/commands/smash.ts:299`
  (the all-skills call site); because a new `stage-continuation` chain has no
  same-skill prior record to preselect (M1 Non-goal), its preselection source
  is surfaced as `configured profile`, never a generic *Use defaults* label.

**File impact.** `src/stage-menu.ts` (action label),
`src/commands/smash.ts` (candidate-detail wording in the suggested-stage
branch), `src/interactive.ts` (pre-selection preamble),
`tests/stage-menu.test.ts`, `tests/interactive.test.ts`,
`tests/terminal-surfaces.test.ts`.

**Verification.** (mirrors `follow-up.md:182-198`)

- The *Start suggested stage* action surface labels displayed runners as
  editable defaults before the operator commits to the action.
- For a one-skill successor and for a two-skill approval-loop pair, the surface
  states that runner selection occurs before execution (and, for the pair, that
  the complete pair is resolved before the first provider invocation).
- The preamble never reads as a committed/locked choice; no label implies a
  custom runner changes pipeline identity.
- Customizing the suggested-stage runner preserves pipeline ID, pipeline run
  ID, successor stage ID, and predecessor artifact identity (the produced run
  is still `stage-continuation`).
- The suggested-stage path surfaces its preselection source as
  `configured profile` explicitly; the *Continue current loop* path surfaces
  `chain metadata` / `configured profile`. **Both entry points surface a source
  of truth** — pinning the chain-vs-profile asymmetry (M1) as visible and
  tested, not silent.

## Release boundaries

Each release is independently verifiable with `pnpm typecheck && pnpm test`.

### Release 1 — Continuation defaults and honest labels (D1–D4, D8)

- Continuity seam extraction (behavior-identical), continuation preselection
  derivation, chain-aware labels, the reworded editable-preview preamble (D8)
  **and** the separate post-selection summary (D4) — two distinct blocks, not
  one replacing the other (v2 M2) — `'session'` attribution, the consolidated
  single `runner.resolved` emitter (D4/v1-M2; the two `smash.ts` branches split
  per v2 m3), and the suggested-stage editable-default labeling (D8).
- Gate: new pure-derivation and interactive-flow tests green; the direct
  `continuation-runners.ts` unit tests (D2/m2) green; the per-entry-point
  `runner.resolved` exactly-once test (D4/M2) green; the D8 editable-default
  labeling tests green; existing continuity e2e unchanged and green.

### Release 2 — Effort-only selection (D5–D6)

- `promptRunners` `ResolvedRunner` contract, per-skill three-way menu,
  three-state effort distinction with arg-level adapter proof.
- Gate: updated interactive/model-effort suites green; catalogue
  non-mutation and provider-default-vs-configured distinction proven.

### Release 3 — Requested-vs-effective effort contract (D7)

- Telemetry fields, confirmation normalization, bounded mismatch warning
  (reusing the existing `warning` event — no new event types), provenance +
  Step-pipeline extension (`ArtifactMeta → Step → view`, C2), requested
  vocabulary, catalogue/`--variant` regressions.
- Gate: all D7 bullets green — including the re-scan bullet proving the
  vocabulary renders for historical/scanned artifacts (C2) and the identity
  non-change test; full suite green; doc-sync landed: `AGENTS.md` §2 gains the
  interactive continuation-default precedence and the requested/effective
  effort honesty contract, and `docs/architecture/overview.md` names
  `continuation-runners.ts` in its runner paragraph (README has no
  runner-precedence statement to change — re-verify during implementation).

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

All coverage is deterministic (fake adapter, fixture chains, mocked
`@inquirer/prompts`, adapter `buildRun` arg assertions). No real-provider gate
is required for selection/presentation: the batch changes selection/presentation
and defines a telemetry contract whose production values are verified absent
(D7). Because the mismatch-surfacing workflow cannot be exercised end-to-end
against a real provider this batch (no production adapter exposes the effective
field), the following **manual smoke is a Release-2 sign-off step, not merely
recommended**: one interactive *Continue current loop* on this repository
showing the chain preselection, the effort-only path, and the resolved-runner
summary; plus one interactive *Start suggested stage* (D8) showing the
editable-default label and the selection-before-execution wording, with the
produced run still `stage-continuation` and linked to the predecessor. The
mismatch-surfacing path itself remains contract-only until a provider's
structured stream exposes the effective field (a future batch).
