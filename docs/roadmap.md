# Roadmap

## Short checklist

Ordered by recommended implementation batches. This is the top-level view: grouped, ordered, and status-only.

**Batch 1 — Core runtime cleanup**

- [x] **1 — structured error labeling fix**
- [x] **9 — `loop.ts` + spawner refactor**
- [x] **2 — pattern rendering/parsing centralization**
- [x] **4 — next-step decision centralization**
- [x] **16 — legacy provenance cleanup**
- [x] **17 — execution-completeness contract for streaming adapters**
- [x] **18 — state-scan dead-code cleanup**

**Batch 2 — CLI/runtime ergonomics**

- [x] **10 — logging layer**
- [x] **6 — Debug / non-graphical mode**
- [x] **11 — command flow cleanup (`process.exit` at the boundary)**
- [x] **19 — CI / typecheck workflow**
- [x] **20 — fake-adapter registry boundary**

**Batch 3 — Test and prompt-maintenance infrastructure**

- [ ] **12 — test helpers extraction**
- [ ] **13 — roles / skill-template consolidation**
- [ ] **21 — follow-up outcome contract centralization**

**Batch 4 — Config, docs, and product-shape decisions**

- [ ] **7 — Model registry config (single source of truth)**
- [ ] **14 — docs canonicalization + broken plan reference fix**
- [ ] **15 — orphan skills decision**

**Batch 5 — End-user loop enhancements**

- [ ] **8 — Prompt to extend iterations at max**
- [ ] **5 — Live status panel**

## Detailed checklist

Ordered by recommended implementation batches. This section is the execution order to use for planning → implementation work, and it now absorbs the relevant cleanup detail directly.

## Architecture assumptions and implementation goal

Every checklist item below should be implemented against the same architectural standard:

- Prefer **clear module boundaries** over generic helper extraction. A new file is justified only when it owns a stable responsibility, shared domain rule, or testable contract.
- Prefer **small pure modules** for domain rules (`patterns`, next-step resolution, shared contracts) and keep orchestration in a small number of runtime entrypoints.
- Avoid vague catch-all files such as `helpers.ts`, `misc.ts`, or `common.ts`. If a module cannot be named by responsibility, it probably should not exist.
- Keep the runtime **incrementally evolvable**. Refactors should create seams for later features without forcing a top-down rewrite or a folder reorganization for its own sake.
- Keep abstractions **data-oriented and explicit**: structured events, typed contracts, single-source-of-truth rules, and adapter boundaries that separate provider-specific behavior from shared harness behavior.
- Preserve **behavioral stability** while refactoring. The goal is cleaner structure, not silent product changes, except where the checklist item explicitly adds user-facing behavior.

The implementation goal for this roadmap is a **clean, scalable, high-quality harness architecture**: fewer duplicated rules, fewer hidden couplings, smaller orchestration files, explicit runtime contracts, and only purposeful modules added where they improve clarity and long-term maintenance.

**Batch 1 — Core runtime cleanup**

- [x] **1 — structured error labeling fix.** Make `structuredMessage` adapter-aware instead of hardcoding opencode wording for shared failure paths; move opencode-specific remediation behind an adapter hook; and update the tests that currently lock in the mislabel, including the assertions that pin literal `"opencode rejected model"` / `"opencode provider/credential error"` strings.
- [x] **9 — `loop.ts` + spawner refactor.** Extract stable runtime seams from `loop.ts` rather than scattering convenience helpers. Introduce focused responsibilities such as step execution, artifact persistence, render dispatch, and shared process execution only where they form clear reusable contracts. Use that refactor to close the adapter-parity gap and absorb surrounding duplication: the `loop.ts` god-function shape, duplicated `StepKind`, duplicated stderr-tail trimming, repeated `parseVerdict` classification logic, and the duplicated status-panel render path that item 6 will later branch.
- [x] **2 — Pattern rendering/parsing centralization.** Move the repeated `{n}` / `{agent}` path expansion and inverse regex logic into one small, pure, responsibility-named module so `loop.ts`, `prompt-composer.ts`, and `state.ts` use the same source of truth.
- [x] **4 — Next-step decision centralization.** Unify the repeated “what happens next?” logic currently split across `scan`, `loop`, and `status` behind one pure decision module so restart behavior and status messaging cannot drift. Resolve the dead `ScanResult.proposedNext` field at the same time by either deleting it or promoting it to the single source of truth.
- [x] **16 — legacy provenance cleanup.** Remove speculative back-compat parsing that the tool does not actually use today, specifically `parseProvenance` / `parseLegacyProvenance` support for legacy comment and `Auditor:` formats, unless a real migration source is identified.
- [x] **17 — execution-completeness contract for streaming adapters.** Promote meaningful adapter completion signals into the runtime contract where they prevent misclassification of truncated generations. In this repo, `stopReason` is currently verified only for `opencode`; codex and claude remain exit-code / structured-error based until similar support is explicitly proven and implemented.
- [x] **18 — state-scan dead-code cleanup.** Remove dead parameters and redundant filesystem work in state scanning, including the unused `baseDir` parameter in `getAllFiles()` and the double-read behavior where `scan()` re-reads each artifact during enrichment.

**Batch 2 — CLI/runtime ergonomics**

- [x] **10 — Logging layer.** Introduce a deliberately small output abstraction for the CLI surface so loop/command output is not hardwired to `console.log` + `chalk` + `ora`. Keep it thin: structured events in, renderer implementation out; no heavyweight logging framework, no global singleton, and no generic utility bucket.
- [x] **6 — Debug / non-graphical mode.** Add a plain, scrollback-preserving execution mode for `smash` on top of the refactored loop surface and thin output abstraction. Prefer a user-facing flag shape that reflects behavior (`--plain`, optionally with `--debug` as an alias), and keep interactive prompting semantics unchanged.
- [x] **11 — Command flow cleanup.** Refactor `smash.ts` / `status.ts` to return results and exit once at the CLI boundary instead of calling `process.exit()` throughout the command logic. Fold in the duplicated interactive vs non-interactive start-point / runner-resolution logic and replace the loose `any` config typing in the command layer while touching those flows.
- [x] **19 — CI / typecheck workflow.** Add explicit repository automation that runs `typecheck` and deterministic tests on push / PR, and define how env-gated real-provider checks participate in sign-off. The quality bar should be machine-enforced, not just described in docs.
- [x] **20 — fake-adapter registry boundary.** Make the boundary between production adapters and test-only infrastructure explicit. Keeping `fake` in the main registry is acceptable only if the contract is intentional, documented, and low-risk; otherwise isolate test adapters behind a separate registration path.

**Batch 3 — Test and prompt-maintenance infrastructure**

- [ ] **12 — Test helpers extraction.** Add shared test helpers (`createTempDir`, `withTempDir`, `runFakePlanLoop`, `makeMeta`, `makeErrorResult`) plus a `resetFakeAdapterState()` helper and test setup wiring. Keep these helpers narrowly scoped around test mechanics; do not hide core assertions or business behavior inside opaque mega-helpers. This batch should absorb the repeated temp-dir setup, repeated fake-runner setup, repeated `ArtifactMeta` builders, repeated adapter contract assertions, repeated `RunResult` test fixtures, and the missing `vitest.config` / shared setup-file support.
- [ ] **13 — Roles / skill-template consolidation.** Move the duplicated “best-practice / no-MVP-shortcuts” guidance into real role files and only extract truly invariant template blocks from the audit/follow-up skills. Include the duplicated follow-up/audit prompt sections, but preserve prompt self-containment where it materially helps prompt quality.
- [ ] **21 — follow-up outcome contract centralization.** Centralize the `## Follow-up Outcome` / `patched|blocked` wire format, which is currently defined in multiple skill files plus fake-adapter output and parser logic, so wording changes hit one source of truth instead of four.

**Batch 4 — Config, docs, and product-shape decisions**

- [ ] **7 — Model registry config (single source of truth).** Introduce one canonical registry of providers, allowed models, and defaults, then have workflow config reference that registry instead of hardcoding raw model strings in multiple places. Preserve useful per-skill runner choice by referencing named/default models from the registry rather than removing all per-skill configurability.
- [ ] **14 — Docs canonicalization + broken plan reference fix.** Make `docs/architecture/overview.md` the canonical architecture source, reduce duplicated architecture prose elsewhere, and fix or remove the broken `docs/dev/plan.md` references.
- [ ] **15 — Orphan skills decision.** Wire `00-simple-codebase-preload`, `20-simple-plan`, and `30-simple-implement` into loops, document them as standalone utilities, or remove them.

**Batch 5 — End-user loop enhancements**

- [ ] **8 — Prompt to extend iterations at max (consideration).** When the loop hits `max-iterations`, offer interactive users a controlled continuation choice without changing non-interactive behavior. Prefer bounded preset actions first (`stop`, `+1`, `+3`, `+5`) with optional custom input only if it proves necessary.
- [ ] **5 — Live status panel.** Replace the current static redraw model incrementally: first establish a stable render region, then layer in adapter lifecycle events, then add richer per-provider progress where the signal is trustworthy. Avoid a one-shot TUI rewrite.

---

## 9 — `loop.ts` + spawner refactor

Goal: collapse the largest duplications in the runtime so the file is safe to change, every adapter has the
same error model, and items 5 / 6 / 8 land on a clean substrate.

**Why now:** `loop.ts` is the single file that 5 (live panel), 6 (debug render), and 8 (extend-iterations) all
touch, and it currently mixes rendering, step execution, artifact I/O, provenance, prompt composition, and
interactive prompts in one 334-line function built from two near-duplicate step blocks. Refactoring it first
prevents three future features from each re-implementing the same loop.

**Scope:**

- Extract `runStep(kind, …)` and `writeStepArtifact(…)` from the follow-up (`loop.ts:63-156`) and audit
  (`:158-224`) blocks; the `ArtifactMeta` object is rebuilt almost identically at `:139-145` and `:262-268`.
- Extract `renderStep(ctx)` from the 4 inline `renderStatusPanel` call sites (`:77,171,240,280`) — this is also
  the hook point for item 6's debug render.
- Unify `spawnAgentProcess` + `spawnOpencode` (`src/adapters/utils.ts`) into one spawner with
  `{ parseStream?, scanStderr?, timeoutMs? }`, and fix the `structuredMessage` adapter-mislabel bug
  (`src/adapters/errors.ts`) along the way.
- Define a shared execution-completeness seam so the loop can distinguish provider/process failure,
  generation truncation/interruption, and successful completion before artifact parsing begins.

**Effort:** M–L. Highest leverage of any item here; do it before 5/6/8, not alongside them.

---

## 6 — Debug / non-graphical mode

Goal: run the audit loop as a plain, scrollback-preserving text log — no status panel, no spinner, no
screen clears — for debugging and headless/CI runs.

> Current observation: every loop step renders the boxen **status panel** and runs an `ora` spinner,
> each preceded by `console.clear()`, so the run is a "graphical" TUI that wipes scrollback.

**Findings so far:** there is **no** existing debug/verbose/plain mode — grep for
`debug|verbose|silent|--no-|--plain` in `src/` returns nothing. The "graphical interface" is three
concrete pieces:

- `renderStatusPanel` (`src/status.ts:16`) — a boxen box + cli-table3 timeline, drawn in `src/loop.ts`
  before each follow-up (`:77`), audit (`:171`), on unknown verdict (`:240`), and after each iteration (`:280`).
- `ora` spinner (`src/loop.ts:112`, `:205`) running for the whole spawn, with `succeed`/`fail` callbacks.
- `console.clear()` before each of those renders (`src/loop.ts:77`, `:171`, `:240`, `:280`).

The only related flag is `isInteractive` (`src/commands/smash.ts:45`, set by `--loop`), which controls the
inquirer prompts, **not** the panel/spinner — so a non-interactive run is still fully graphical.

**Fix:**

- Introduce a plain-output execution mode for `smash`; prefer `--plain` as the behavior flag and support
  `--debug` only if you want an alias for discoverability. Thread the mode through `SmashOptions`
  (`src/commands/smash.ts`) → `LoopOptions` (`src/loop.ts`).
- Put mode-dependent rendering behind a small output/render interface: plain renderer for scrollback-safe logs,
  TUI renderer for panel mode. Keep the interface event-oriented so item 5 can reuse it.
- In plain mode, skip `console.clear()`, skip the panel, and replace long-lived spinners with deterministic
  step markers and terminal summaries. Preserve interactive prompts and exit semantics exactly as they work now.

**Effort:** S–M. Establishes the plain-render branch item 5's live panel should coexist with.

---

## 7 — Model registry config (single source of truth)

Goal: model names come from **one** dedicated config file that maps `provider → model(s)` plus the default
agent/model, as the single source of truth — selectable in the interactive picker and validated against a
known-good list. Model strings must not be spread across multiple files.

**Consolidation principle — one canonical registry, referenced elsewhere.** Today a model string can live in
_two_ places: `.env` (per-agent defaults) and `skills.yaml` (per-skill `model:`). The high-quality target is
not “remove all references outside one file,” but “one authoritative registry with references everywhere else.”
Instead:

- The new config file owns provider→model allow-lists and default selections.
- `skills.yaml` stays the _workflow manifest_ (roles / skills / loops / patterns) and stops hardcoding raw
  model strings; when a skill needs a non-default runner, it should reference a named/default model from the
  registry rather than inventing a new string.
- `.env` should stop carrying model defaults once the registry exists; environment variables can remain for
  true secrets or provider-specific runtime needs, not general model selection.

Result: model definitions live in one authoritative place, while workflow files can still choose among
registered options without duplicating raw strings.

> Current observation: only three agents (opencode/codex/claude) are offered in the interactive picker,
> and the model field is free text — there is no list of "known models" to choose from.

**Findings so far — this partially exists already:**

- **Model strings are already free-form.** Any model name can be set via `.env`
  (`OPENCODE_DEFAULT_MODEL` / `CODEX_DEFAULT_MODEL` / `CLAUDE_DEFAULT_MODEL`, loaded in `src/config.ts:40-45`)
  or per-skill in `skills.yaml` (`model:` field, `src/manifest.ts:23`). Neither is checked against a list —
  only the loose per-agent regex/prefix in `isValidModelForAgent` (`src/runner.ts:3-17`).
- **The `.env` API keys are dead weight.** `config.apiKeys` is built (`src/config.ts:47-56`) and returned
  (`:62`) but consumed **nowhere** — every adapter spawns an installed CLI binary (`spawnAgentProcess` /
  `spawnOpencode` in `src/adapters/utils.ts`); there is no `fetch`/HTTP/SDK and no reader of
  `process.env.*_API_KEY`. `scanStderrForError` only _reads_ stderr for auth failures, it doesn't _use_ a key.
  So `.env`'s only live role is the default agent/model — which moves into the new config, making `.env`
  droppable now. (If HTTP adapters are added later, keys can be plain env vars read by those adapters
  directly — no need to restore `.env`.)
- **There is no model _registry_.** Grep for rcfile / config.json / toml / cosmiconfig in `src/` returns
  nothing.
- **The agent list is hardcoded** in three places: validation (`src/runner.ts:20` `allowedAgents`) and the
  two interactive pickers (`src/interactive.ts:67` and `:116`) — both show only opencode/codex/claude (no
  `fake`). So the "three" are really the three offered agents; a model is an open string per agent.

**Industry-standard format (decision point):** a single discoverable config file **is** the convention for
CLI tools (git's `.gitconfig`, npm's `.npmrc`, aider's `.aider.conf.{yml,toml,json}`); no exotic alternative
is needed. Recommend **one YAML file** (e.g. `orc.config.yaml` / `~/.config/orc/config.yaml`) — `yaml` is
already a dependency (`src/manifest.ts`), so this adds no parser, and YAML supports comments. If discovery
flexibility matters, adopt the **cosmiconfig** search convention (`.orcrc`, `orc.config.{js,json,yaml}`, an
`orc` key in `package.json`). Shape:

```yaml
providers:
  opencode: [opencode-go/deepseek-v4-flash, opencode/deepseek-v4-flash-free]
  claude: [claude-sonnet-4-6]
defaults:
  agent: opencode
  model: opencode-go/deepseek-v4-flash
```

**Fix:**

- Add a canonical config file for provider → model allow-lists plus default selections; load it in
  `src/config.ts`, replacing `.env` for model-default resolution. Define a clear search order
  (project-local first, then user-global).
- Replace raw per-skill `model:` strings in `skills.yaml` with references into the registry when a skill needs
  a non-default runner. Keep the workflow manifest expressive without letting it become a second uncontrolled
  source of raw model names.
- Feed registered providers/models into `promptRunners` / `promptSecondOpinionRunner` (`src/interactive.ts`)
  so selection is registry-backed. If a custom model escape hatch exists, it should be explicit and validated,
  not the default path.
- Make validation consult the registry first and use prefix/regex checks only as a fallback migration aid, not
  the long-term source of truth.
- Remove dead `.env` model-default plumbing and dead `apiKeys` plumbing from `config.ts`; keep env vars only
  for actual secret/runtime concerns. Document the new registry and migration path in the README.
- Out of scope but still true: adding new _agents/providers_ still requires a real adapter under
  `src/adapters/`; the registry governs model choices for existing providers, not provider creation itself.

**Effort:** M. Decide the config-file format, search path, and skills.yaml model-removal migration first.

---

## 17 — execution-completeness contract for streaming adapters

Goal: ensure the harness can distinguish “the process exited” from “the model completed cleanly enough to trust
artifact inspection.”

> Current observation: `opencode` can expose a completion reason like `stop`, `tool-calls`, or `length`, but
> the harness mainly treats exit-code success as execution success. Equivalent support is not yet verified for
> codex or claude in this repo.

**Why this matters:** if a model stops because of truncation or interruption, the process can still exit `0`.
Without a completion contract, the loop falls through into artifact parsing and misclassifies a generation or
infrastructure problem as “the model failed to write a valid verdict.”

**Fix:**

- Treat `stopReason` as an owned runtime signal for adapters that can provide it. In Batch 1, that means
  `opencode` specifically.
- Add a small shared execution-completeness check in the runtime path before artifact inspection:
  - success with trustworthy completion
  - unknown / terminal due to truncation or interruption
  - process / transport failure
- Keep provider-specific mapping in the adapter layer. The loop should not hardcode raw vendor semantics beyond
  consuming a normalized completion signal.
- Trim or de-emphasize other parsed opencode payload fields (`finishReasons`, `tokenUsage`, `unparsed`) unless
  they are intentionally promoted into the runtime contract.
- Preserve compatibility for adapters that do not expose a verified completion signal yet: they continue to rely
  on exit code + structured error handling until similar support is intentionally added.

**Effort:** S–M. This belongs in Batch 1 because it changes correctness and diagnostics in the core run loop.

---

## 8 — Prompt to extend iterations at max (consideration)

Goal: when the loop reaches `max-iterations`, instead of a hard stop, offer the (interactive) user a choice —
extend by N more iterations, or stop — so a run that's converging isn't cut off just because the up-front
guess was too low.

> Current observation: after the iteration budget is exhausted the app fully stops with
> `hit max-iterations, awaiting human`. There is no chance to continue without re-running.

**Findings so far:**

- **It is a hard stop today.** `src/loop.ts:327-333` — the `while (iteration < options.maxIterations)` loop
  (`src/loop.ts:62`) falls out and returns `{ success: false, verdict: 'REJECTED', message:
'hit max-iterations, awaiting human', lastAuditPath }`, in **both** interactive and non-interactive modes.
- **A similar prompt already exists** at the other decision point: on `APPROVED`, interactive mode already
  calls `promptSecondOpinionDecision` (`src/interactive.ts:88`, invoked at `src/loop.ts:294`) to ask stop vs.
  second-opinion. And `promptMaxIterations` (`src/interactive.ts:20`) already asks for the count up-front. So
  this mirrors both: a stop/extend decision plus an amount.
- **Extending is mechanically cheap.** `maxIterations` is `options.maxIterations` (`LoopOptions`,
  `src/loop.ts:16`), mutable in place, so extending is `options.maxIterations += N` then resume. At the
  exit point the latest audit is `REJECTED` and `pendingFollowUp` is already `true` (set on REJECTED at
  `src/loop.ts:322-324`), so resuming naturally runs follow-up → audit with no state fixup.
- **Must be interactive-only.** Gate on `options.interactive` (set by `isInteractive = !options.loop`,
  `src/commands/smash.ts:45`) so CI and `--loop` runs still exit with the existing `REJECTED` verdict / exit
  code.

**Fix (to consider):**

- Add a dedicated continuation prompt to `src/interactive.ts`, but prefer bounded preset actions first
  (`stop`, `+1`, `+3`, `+5`) over free-form numeric input. A custom amount can remain an escape hatch if the
  extra complexity proves worthwhile.
- Restructure the loop-exit branch so interactive continuation happens before the function returns, rather than
  by relying on awkward post-loop state mutation.
- Guard against accidental infinite prompting with bounded continuation rules or a clear “ask once per limit
  hit” policy.
- Keep non-interactive behavior and exit codes byte-for-byte identical.

**Effort:** S. Shares the `loop.ts` termination branch with item 5 — minor merge surface, not a dependency.

---

## 5 — Live status panel

"Re-render on an interval" is the cheap framing. Accurate live status needs an event-driven adapter
lifecycle and a stable render path.

> Current observation: when audit v2 is running, the panel only shows step 1 — as if not updating, not refreshing, or later updates aren't visible.

**Root cause:** the panel is rendered _once_ before each spawn (`console.clear` + `console.log` in `src/loop.ts`), then a static spinner runs for the whole spawn. v2 is appended to history only after it completes, so during the run the table shows only v1. `console.clear` reprints also flicker and discard scrollback.

**Fix:**

- Ship this incrementally. First establish a stable render region and clean renderer boundary on top of the
  output abstraction from item 10; only then add richer lifecycle/progress updates.
- Expose a small, provider-agnostic lifecycle model (`started`, `message`, `completed`, `failed`) and map
  provider-specific output into it only where the signal is trustworthy. Avoid inventing fake precision just to
  make the panel feel busy.
- Add richer per-adapter progress parsing gradually, starting with providers that already expose structured
  events well. Reuse existing stream parsing where appropriate rather than forcing every adapter into the same
  richness level on day one.
- Disambiguate iteration, version, and step index in the UI model before adding more live behavior.

**Effort:** L (depends on 3's stream parsing and 4's step model).
