# Plan — Runner selection and continuity UX (follow-up batch 2)

**Confidence: 0.96**

This plan implements **Batch 2 — Runner selection and continuity UX** from
`docs/dev/archived/follow-up.md` (three checklist items). It changes runner
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

## Scope

- `src/interactive.ts` (`promptRunners` contract and menus),
  `src/stage-menu.ts`, `src/commands/smash.ts` (continuation flow and labels);
- one new pure module `src/continuation-runners.ts` owning the shared
  chain-candidate walk, runtime session-compatibility rule (moved, unchanged),
  and continuation preselection derivation;
- `src/runner.ts` attribution (`'session'` sources), `src/adapters/types.ts`
  (`RunResult` effective-telemetry fields), `src/adapters/completion.ts`
  (confirmation normalization), `src/provenance.ts` (two optional fields),
  `src/project-snapshot-view.ts` (requested-effort vocabulary);
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
  interactive-continuation feature only.
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
  `accepted`, same chain scoping, same tuple/session/capability comparison).
  `binding-engine.ts` imports it.
- A shared `latestChainRunnerCandidate(history, chainId, skillId)` helper
  performs the one canonical chain walk (backwards, stop at `accepted`
  boundary, first same-skill record). Both the runtime rule and the new
  preselection derivation (D3) use it — no forked walk.

**File impact.** New `src/continuation-runners.ts`;
`src/loops/binding-engine.ts` (import instead of local definition).

**Verification.**

- Existing continuity suites (`tests/loop-continuity.test.ts`,
  `tests/loop-followup-runner.test.ts`) pass unmodified.

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

Per skill, the latest chain candidate (via D2's walk) wins when **compatible**:
adapter registered, model valid per `isValidModelForAgent`, and recorded
effort (if any) valid per `isValidEffortForModel` against the *current*
catalogue (a chain effort the catalogue no longer offers — e.g. a corrected
matrix — loses with reason `effort no longer offered`). A compatible candidate
is preselected even when not resumable; it is **resumable** when it also has a
session ID and the adapter declares `resumeSession`, in which case
`sessionId` is carried for display and predicted continuity. Otherwise the
configured profile is the preselection with a bounded `fallbackReason` (`no
chain step for this skill`, `unknown adapter`, `model no longer in catalogue`,
`effort no longer offered`).

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
- A chain candidate whose effort the current catalogue no longer offers falls
  back with the `effort no longer offered` reason.
- Both loop skills receive preselections up front (complete pair; no
  re-prompt between steps).

### D4 — The resolved-runner summary shows source and predicted continuity (item 1)

**Design.** `promptRunners` gains a post-selection summary (printed once per
run, after all skills are chosen) replacing the pre-selection-only *Default
skill runners:* block. Per skill it shows: skill and role; provider; model;
effort or provider default; choice source (`chain metadata` / `configured
profile` / `operator selection`); continuity policy; and predicted outcome
(`resumes session *a1b2c` or `fresh session (reason)`). In addition,
`resolveBindingRunners` emits the existing `runner.resolved` event (with
sources and `inheritedSession`) for prompt-resolved runners too, closing the
event-stream gap for interactive non-candidate flows, and validates them via
`validateRunnerCapabilities`.

**File impact.** `src/interactive.ts`, `src/loops/binding-engine.ts`,
`tests/interactive.test.ts`, `tests/model-efforts-regression.test.ts`.

**Verification.**

- The summary lists all six fields per skill and matches the actual
  pre-spawn continuity outcome for the first step.
- `runner.resolved` is emitted exactly once per skill for every interactive
  flow, with accurate source attribution (`session` vs `profile` vs
  `interactive`).

### D5 — Per-skill three-way runner menu with an effort-only path (item 2)

**Design.** `promptRunners` returns fully resolved, attributed
`ResolvedRunner`s (it already resolves internally; both consumers stop
re-resolving — `smash.ts` validates/emits the returned runners directly,
`binding-engine.ts` keeps assigning them and gains D4's emission). When
defaults exist and `forceSelect` is not set, each skill gets the three-way
choice from the follow-up document, with the first option reflecting the
actual preselection source (D3):

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
  gains a pure `resolveEffortConfirmation(runner, result)`:
  reported-and-equal (or reported while no effort was requested) →
  `confirmed`; reported-and-different → `mismatch`; nothing reported →
  `requested`.
- After a completed provider step, `execution.ts` compares both effective
  fields against the resolved runner and, on any mismatch, emits a bounded
  warning (`output.warn` + a `provider.effort-mismatch` /
  `provider.model-mismatch` run event) containing only the two values — never
  provider text. A mismatch is a warning, not a failure: the provider exited
  successfully and the artifact contract remains the terminal authority.
- Provenance: `ArtifactMeta` gains optional `effortStatus?:
  'requested' | 'confirmed' | 'mismatch'` and `effectiveEffort?: string`,
  written by `binding-engine.ts` from the same normalization. Both are
  excluded from `computeArtifactIdentity`; old artifacts simply lack them and
  read as requested. The front-matter `effort:` key (the requested value) is
  unchanged.
- Display vocabulary: `project-snapshot-view.ts`'s step summary renders
  `requested: <effort>` / `provider default` when unconfirmed,
  `confirmed: <effort>` on confirmation, and
  `requested <a> → effective <b>` on mismatch; detailed/compact renderers
  keep their structure and consume the view string.
- Catalogue + arg regressions: pin the packaged
  `opencode-go/deepseek-v4-flash` matrix to exactly `[default, high, max]`;
  an explicit unsupported value (`xhigh`) fails in `resolveRunner` before any
  spawn; the opencode adapter maps a supported explicit effort to exactly one
  `--variant` argument.

**File impact.** `src/adapters/types.ts`, `src/adapters/completion.ts`,
`src/adapters/fake.ts` (test injection), `src/loops/execution.ts`,
`src/loops/binding-engine.ts` (meta), `src/provenance.ts`,
`src/project-snapshot-view.ts`, `src/run-event.ts` / `src/cli-output.ts`
(warning events, if new types are needed), `tests/adapters-args.test.ts`,
`tests/model-efforts-regression.test.ts` (or a packaged-catalogue test).

**Verification.**

- The packaged DeepSeek Flash catalogue offers only provider default, high,
  and max; `xhigh` fails before provider spawn.
- OpenCode maps a supported explicit effort to exactly one `--variant`.
- A structured effective-variant mismatch (fake-injected) produces the
  bounded warning and `mismatch` provenance; an exact match produces
  `confirmed` and no warning.
- Providers without telemetry retain `requested` provenance and requested
  vocabulary everywhere; nothing fabricates confirmation.
- Artifact identity digests are unchanged by the new optional fields
  (with/without equality test) and old artifacts still classify.

## Release boundaries

Each release is independently verifiable with `pnpm typecheck && pnpm test`.

### Release 1 — Continuation defaults and honest labels (D1–D4)

- Continuity seam extraction (behavior-identical), continuation preselection
  derivation, chain-aware labels and summary, `'session'` attribution,
  `runner.resolved` for prompted runners.
- Gate: new pure-derivation and interactive-flow tests green; existing
  continuity e2e unchanged and green.

### Release 2 — Effort-only selection (D5–D6)

- `promptRunners` `ResolvedRunner` contract, per-skill three-way menu,
  three-state effort distinction with arg-level adapter proof.
- Gate: updated interactive/model-effort suites green; catalogue
  non-mutation and provider-default-vs-configured distinction proven.

### Release 3 — Requested-vs-effective effort contract (D7)

- Telemetry fields, confirmation normalization, bounded mismatch warnings,
  provenance extension, requested vocabulary, catalogue/`--variant`
  regressions.
- Gate: all D7 bullets green; full suite green; doc-sync landed:
  `AGENTS.md` §2 gains the interactive continuation-default precedence and
  the requested/effective effort honesty contract, and
  `docs/architecture/overview.md` names `continuation-runners.ts` in its
  runner paragraph (README has no runner-precedence statement to change —
  re-verify during implementation).

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

All coverage is deterministic (fake adapter, fixture chains, mocked
`@inquirer/prompts`, adapter `buildRun` arg assertions). No real-provider gate
is required: the batch changes selection/presentation and defines a telemetry
contract whose production values are verified absent. Recommended manual
smoke after Release 2: one interactive *Continue current loop* on this
repository showing the chain preselection, the effort-only path, and the
resolved-runner summary.
