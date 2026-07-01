# Roadmap

## Short checklist

Current pending work, grouped into recommended implementation batches.

**Batch 3 — Provider & Runtime Hardening**

- [ ] **30 — Add Antigravity provider (`agy`)**
- [ ] **31 — Add watchdog timeouts for `claude` and `codex`**
- [ ] **29 — Timeline state accuracy and interrupted-run handling**

**Batch 4 — Panel & Active-Loop Correctness**

- [ ] **32 — Review-loop active role labels in TUI**
- [ ] **34 — TUI "Next Step" line is loop-agnostic (plan-loop steps shown during the review loop)**

**Batch 5 — Interaction, Provenance & Docs**

- [ ] **8 — Prompt to extend iterations at max**
- [ ] **33 — Follow-up artifacts carry duplicate front-matter blocks**
- [ ] **35 — Implementation-ledger validator rejects non-passing rows but reports a misleading "missing table / confidence" error**
- [ ] **14 — docs canonicalization + broken plan reference fix**

**Batch 6 — CLI Integration and Timeout Hardening**

- [ ] **36 — Agent CLI connection hanging and follow-up validation gaps**

## Detailed checklist

Open work is listed below, with recently completed milestones retained where their outcome still provides context for the remaining batches.

## Architecture assumptions and implementation goal

Every checklist item below should be implemented against the same architectural standard:

- Prefer **clear module boundaries** over generic helper extraction. A new file is justified only when it owns a stable responsibility, shared domain rule, or testable contract.
- Prefer **small pure modules** for domain rules (`patterns`, next-step resolution, shared contracts) and keep orchestration in a small number of runtime entrypoints.
- Avoid vague catch-all files such as `helpers.ts`, `misc.ts`, or `common.ts`. If a module cannot be named by responsibility, it probably should not exist.
- Keep the runtime **incrementally evolvable**. Refactors should create seams for later features without forcing a top-down rewrite or a folder reorganization for its own sake.
- Keep abstractions **data-oriented and explicit**: structured events, typed contracts, single-source-of-truth rules, and adapter boundaries that separate provider-specific behavior from shared harness behavior.
- Preserve **behavioral stability** while refactoring. The goal is cleaner structure, not silent product changes, except where the checklist item explicitly adds user-facing behavior.

The implementation goal for this roadmap is a **clean, scalable, high-quality harness architecture**: fewer duplicated rules, fewer hidden couplings, smaller orchestration files, explicit runtime contracts, and only purposeful modules added where they improve clarity and long-term maintenance.

**Batch 3 — Provider & Runtime Hardening**

- [ ] **30 — Add Antigravity provider (`agy`).** Introduce Antigravity as a real runnable provider behind the existing adapter seam, invoked through the `agy` CLI. The implementation must follow the same provider contract as the existing real adapters: add a dedicated adapter module, register it only in the production registry, define its default model and any model-id validation rules, wire it into per-skill runner resolution and interactive selection, and add env-gated contract coverage. Document the autonomy/non-interactive file-writing requirements for `agy` explicitly if the provider requires its own bypass flag or equivalent. Keep provider-specific invocation, stderr parsing, and completion semantics in the adapter layer rather than leaking them into shared orchestration.
- [ ] **31 — Add watchdog timeouts for `claude` and `codex`.** Extend the harness timeout policy beyond `opencode` so long-running or internally looping `claude` and `codex` runs cannot hang a simple audit or follow-up step indefinitely. Preserve the provider adapter seam: shared process execution should own the generic timeout mechanism, while each adapter owns its invocation shape and any provider-specific timeout diagnostics. The outcome should define config/default ownership for both providers, integrate with existing structured timeout error handling, and add contract coverage proving the timeout reaches the real adapter call sites rather than existing only as dead config.
- [ ] **29 — Timeline state accuracy and interrupted-run handling.** Couple parent-interruption to child-process termination in the shared process runner, add an interrupted/quarantined state so late or partial artifacts cannot be mistaken for completed work, and extend timeline rendering to show interrupted runs as interrupted. Keep the fix in the shared lifecycle / artifact-validation path, not as a provider-specific workaround; coordinate the panel sub-task with #32 / #34 in Batch 4.

**Batch 4 — Panel & Active-Loop Correctness**

- [ ] **32 — Review-loop active role labels in TUI.** Fix the active-step role naming shown in the panel during the `review` loop. The current TUI can show `planner` / `auditor` in the active-step area even though the review loop roles should be `reviewer` and `implementer`. Preserve the existing correct timeline naming and scope the fix to the active/panel context derivation so the review loop's live labels match the configured review skills without regressing plan-loop labels.
- [ ] **34 — TUI "Next Step" line is loop-agnostic (plan-loop steps shown during the review loop).** The panel renders `nextStepMessage` verbatim, and that message is loop-agnostic: `assembleNextStepMessage` (`src/status.ts`) for the read-only view and the hardcoded per-stage strings in `src/loop.ts` (`Running audit for version N…`, `Executing follow-up…`) were written against the plan loop and never parameterized by the active loop, so during the review loop the Next Step line reads as plan-loop steps rather than the review loop's own `review` → `review-follow-up` sequence. Skill→role config is already correct (`skills.yaml`), and the review loop has no live panel coverage (`tests/loop-live.test.ts` runs only `plan`/`implement`). Parameterize the messaging by active loop, revisit `statusAction` loop detection, and add review-loop live panel tests; coordinate with #32.

**Batch 5 — Interaction, Provenance & Docs**

- [ ] **8 — Prompt to extend iterations at max (consideration).** When the loop hits `max-iterations`, offer interactive users a controlled continuation choice without changing non-interactive behavior. Prefer bounded preset actions first (`stop`, `+1`, `+3`, `+5`) with optional custom input only if it proves necessary.
- [ ] **33 — Follow-up artifacts carry duplicate front-matter blocks.** Follow-up docs (`review-followup-vN-*`, `plan-followup-vN-*`) end up with two YAML front-matter blocks: the agent writes its own and the harness prepends a second via `writeArtifactWithMeta` (`src/provenance.ts`) without stripping the first, because the follow-up skills lack the "harness owns metadata" note the audit skills carry. Strip any existing leading block before stamping (and/or mirror the audit-skill instruction) and add a one-block-per-artifact regression test.
- [ ] **35 — Implementation-ledger validator rejects non-passing rows but reports a misleading "missing table / confidence" error.** A real `claude` implementation wrote [`docs/dev/impl-v1-claude.md`](./dev/impl-v1-claude.md) with both required tables and `State overall confidence: 0.96`, yet the harness still terminated with the generic "missing evidence table / requirement coverage table / confidence declaration" message. The real mismatch is stricter: `src/implement-ledger.ts` currently requires every `Result` / `Status` cell in the required tables to match the passing-status allow-list, and this ledger contains non-passing rows such as `✅ (deterministic); env-gated pending` and `⏳ release-gate`. Decide one explicit contract for pending release-gate items, improve the runtime error in `src/loop.ts` so it reports the true failure reason, and add regression coverage for this exact ledger shape.
- [ ] **14 — Docs canonicalization + broken plan reference fix.** Make `docs/architecture/overview.md` the canonical architecture source, reduce duplicated architecture prose elsewhere, and fix or remove the broken `docs/dev/plan.md` references after the remaining runner/model, loop, and rendering changes have landed so the docs only need one final alignment pass. Intentionally sequenced last in this batch.

**Batch 6 — CLI Integration and Timeout Hardening**

- [ ] **36 — Agent CLI connection hanging and follow-up validation gaps.** Address cases where generic agent CLIs (`codex`, `agy`) hang indefinitely in certain execution environments (e.g. `codex` reading from a piped stdin, or `agy` waiting on blocked network/daemon connectivity) without completing. Under the default config where agent watchdog timeouts are disabled (`0`), these hangs block the loop indefinitely without output. Additionally, establish a validation check to ensure that the follow-up step actually writes the required report file before proceeding, preventing the loop from advancing silently without producing the follow-up artifact.

---

## Batch 1 notes

This batch is complete. It established the runtime correctness and provider-semantics baseline that the later UI, interaction, and documentation work now builds on.

---

## Batch 3 notes

This batch expands and hardens real-provider support and shared runtime resilience. Provider work (#30) stays adapter-local; runtime hardening (#31 watchdog timeouts, #29 interrupted-run handling) lives in the shared process runner and artifact-validation path. #29's panel sub-task (rendering interrupted state) touches the same surface as Batch 4 and should be coordinated with #32 / #34.

## 30 — Add Antigravity provider (`agy`)

Goal: add Antigravity as a fourth real provider, runnable through the `agy` CLI, without weakening the current per-provider adapter contract or reintroducing hardcoded runner assumptions into shared orchestration.

> Current observation: the harness currently supports only three real providers (`opencode`, `codex`, `claude`). Adding another provider is not represented in the roadmap even though the architecture and repo rules explicitly treat provider addition as a cross-cutting implementation task.

**Findings so far:**

- **Adding a provider is not a one-file change.** The repo rules require adapter implementation, registry wiring, per-agent default model handling, model-namespace validation, interactive exposure, contract tests, and documentation updates.
- **Provider-specific behavior must stay behind the adapter seam.** `agy` invocation shape, autonomy flags, structured stderr parsing, and any completion signal should remain provider-local rather than branching shared loop logic ad hoc.
- **Production and testing registries must stay explicit.** `agy` belongs in the production registry once real support exists; test-only infrastructure should remain isolated in the testing registry.
- **Real-provider sign-off must cover the new path.** The quality bar in this repo requires an env-gated contract test for every real provider path.

**Fix:**

- Add a dedicated Antigravity adapter that runs the `agy` binary and implements the shared `AgentAdapter` contract.
- Register `agy` in the production adapter registry, add its default model/config wiring, and define any provider-specific model-id validation needed by `runner.ts`.
- Expose `agy` in interactive runner selection and ensure per-skill/run-wide override precedence still behaves correctly when switching agents.
- Add env-gated contract coverage for the Antigravity path.
- Update `AGENTS.md`, `README.md`, and `docs/architecture/overview.md` so the real-provider set and verification requirements stay synchronized.

**Effort:** M–L.

---

## 31 — Add watchdog timeouts for `claude` and `codex`

Goal: prevent `claude` and `codex` from running indefinitely on simple audit/follow-up tasks by extending the harness watchdog model beyond `opencode`.

> Current observation: `claude` and `codex` currently run through the generic spawn path with no harness-owned timeout, so a provider can continue consuming time and context long after a step should have been considered stuck.

**Findings so far:**

- **Only `opencode` has a harness timeout today.** The current config/docs and spawn plumbing treat timeout policy as `opencode`-only.
- **`claude` and `codex` use the generic spawn path.** That path captures stdout/stderr and spawn failures, but it does not currently enforce a watchdog deadline.
- **This is a provider-hardening concern, not just UX.** A hung or wandering provider run delays loops, obscures operator intent, and weakens the harness guarantee that simple steps fail fast when the provider is not converging.
- **The timeout contract must be observable in tests.** Config-only support is not enough; the registry and adapter call sites need coverage proving the value is actually applied.

**Fix:**

- Generalize the shared process runner so `claude` and `codex` adapters can opt into the same watchdog mechanism already used for `opencode`.
- Define timeout ownership and precedence for `claude` and `codex` in config/docs, keeping the rules explicit and provider-scoped.
- Preserve provider-local diagnostics and structured error reporting so timeout failures still name the correct provider and surface useful context.
- Add env-gated and/or adapter-level contract tests proving the timeout reaches the real `claude` and `codex` spawn paths.

**Effort:** M.

---

## 29 — Timeline state accuracy and interrupted-run handling

Goal: make interrupted and in-flight runs observable and state-safe, so late or partial artifacts cannot be mistaken for completed work.

> Current observation: in a real Claude implement-loop repro, killing the harness did not immediately stop the provider process. A delayed `impl-v1-claude.md` artifact appeared afterward with mixed / corrupted content, which means a child process can outlive the harness and write a late invalid artifact after cancellation.

**Findings so far:**

- **Parent interruption and child termination are not tightly coupled.** Stopping the harness does not yet guarantee the spawned provider process is terminated promptly.
- **Late artifacts can appear after cancellation.** A provider can continue writing `docs/dev/impl-v{n}-{agent}.md` after the operator thinks the run is dead.
- **The current artifact model is too binary for interrupted runs.** Files are either present or absent, but there is no first-class interrupted/quarantined state for late or partial outputs.
- **Timeline semantics are incomplete for interruption.** The user-facing state does not clearly distinguish "running", "interrupted but child still alive", and "artifact written after cancellation".

**Fix:**

- Treat interruption as a first-class lifecycle path in the shared process runner: when the harness is interrupted, explicitly terminate the child provider process and wait for a bounded shutdown outcome.
- Add interrupted-run artifact handling in the shared validation path: if a late artifact appears after cancellation, delete it, quarantine it, or mark it as interrupted so it cannot be mistaken for a valid completed implementation.
- Extend timeline/state rendering so interrupted runs are visible as interrupted rather than silently disappearing or looking completed.
- Keep this fix in the shared process lifecycle / artifact-validation path, not as a provider-specific workaround for Claude.

**Effort:** M.

---

## Batch 4 notes

This batch fixes the two panel-context bugs where the review loop surfaces plan-loop role labels and next-step wording. Both items share one root cause — panel context built without active-loop awareness — and should ship behind a single active-loop-aware panel-context derivation rather than two independent fixes.

## 32 — Review-loop active role labels in TUI

Goal: make the active-step role labels in the panel reflect the actual review-loop skills instead of reusing plan-loop role names.

> Current observation: during the `review` loop, the active-step area in the TUI can display `planner` and `auditor`, even though the configured review-loop roles are `implementer` and `reviewer`. The timeline naming is already correct; the mismatch is in the active-step panel labeling.

**Focus:**

- Trace where the active panel context derives role/skill labels for the currently running step in the `review` loop.
- Ensure the live active-step labels come from the resolved review skill/role mapping rather than a plan-loop assumption or reused label path.
- Preserve the current correct timeline rendering and avoid changing persisted artifact naming or loop semantics.

**Effort:** S.

---

## 34 — TUI "Next Step" line is loop-agnostic (plan-loop steps shown during the review loop)

Goal: make the panel's "Next Step" line reflect the active loop's actual skill sequence, so the review loop (and its implementer / follow-up stage) stops reading as if it were the plan loop.

> Current observation: during the review loop the TUI "Next Step" line shows plan-loop-style next steps. The messages were written against the plan loop and never parameterized by the active loop, so the review loop's distinct steps (`review` → `review-follow-up`) are not represented in the Next Step text.

**Findings so far:**

- **The "Next Step" line is fed by loop-agnostic strings.** The panel renders `context.nextStepMessage` verbatim (`src/status-panel.ts:27`, `src/plain-render.ts:58`). In the read-only `orc status` view that message comes from `assembleNextStepMessage` (`src/status.ts:62`) — e.g. `Proposed next: follow-up then audit version N` — and during a live run it is a hardcoded per-stage string in `src/loop.ts` (`Running audit for version N…`, `Executing follow-up on version N-1 rejection…`, `Completed iteration N with verdict: …`). Neither path names the active loop's skills.
- **The skill→role config is already correct.** `skills.yaml` maps `review`→`reviewer` and `review-follow-up`→`implementer`, distinct from `plan-audit`→`auditor` and `plan-follow-up`→`planner`. So this is a messaging / derivation gap, not a configuration mistake — the same conclusion #32 reached for the active-step role labels.
- **The read-only view can also pick the wrong loop.** `statusAction` detects the loop with the most audit history (`src/commands/status.ts:48-58`), so when plan artifacts outnumber review artifacts, `orc status` reports plan-loop next steps even when the operator is working on the review loop.
- **The review loop has no live panel coverage.** `tests/loop-live.test.ts` exercises only the `plan` and `implement` loops (every `runLoop` call passes one of those); the `review` loop's panel and Next Step rendering are unguarded, which is why this drift went unnoticed.
- **Sibling of #32.** #32 tracks the active-step role labels (`planner`/`auditor` vs `reviewer`/`implementer`); this item tracks the Next Step line content specifically. Both stem from panel context being built without enough active-loop awareness and should share a single active-loop-aware derivation.

**Fix:**

- Parameterize the next-step messaging by the active loop so the review loop's Next Step references its own skills and semantics (`review`, `review-follow-up`) rather than the plan-loop wording.
- Revisit `statusAction`'s loop detection so `orc status` reports the intended loop's next step (or surfaces both) instead of silently defaulting to whichever loop has the most history.
- Add live panel coverage for the `review` loop in `tests/loop-live.test.ts`, asserting the Next Step line and active labels reflect review-loop skills.
- Coordinate with #32 so the role-label and next-step fixes share one active-loop-aware panel-context derivation.

**Effort:** S–M.

---

## Batch 5 notes

This batch is lower-risk interaction, provenance, and documentation cleanup. #33 (duplicate front-matter) is a small, independent correctness fix that can be slotted in anytime. #14 (docs canonicalization) is intentionally last: it performs one final alignment pass after the provider/runtime (Batch 3) and rendering (Batch 4) changes have landed.

## 8 — Prompt to extend iterations at max (consideration)

Goal: when the loop reaches `max-iterations`, instead of a hard stop, offer the interactive user a choice —
extend by N more iterations, or stop — so a run that's converging isn't cut off just because the up-front
guess was too low.

> Current observation: after the iteration budget is exhausted the app fully stops with
> `hit max-iterations, awaiting human`. There is no chance to continue without re-running.

**Findings so far:**

- **It is a hard stop today.** `src/loop.ts` falls out of the `while (iteration < options.maxIterations)` loop and returns `hit max-iterations, awaiting human` in both interactive and non-interactive modes.
- **A similar prompt already exists** at the other decision point: on `APPROVED`, interactive mode already asks stop vs second-opinion. `promptMaxIterations` also already asks for the count up-front, so this change mirrors existing interaction patterns.
- **Extending is mechanically cheap.** `maxIterations` lives on `LoopOptions`, so extending is a local control-flow change rather than a state-model rewrite.
- **Must be interactive-only.** CI and `--loop` runs should keep the current exit behavior.

**Fix (to consider):**

- Add a dedicated continuation prompt to `src/interactive.ts`, but prefer bounded preset actions first (`stop`, `+1`, `+3`, `+5`) over free-form numeric input.
- Restructure the loop-exit branch so interactive continuation happens before the function returns, rather than by relying on awkward post-loop state mutation.
- Guard against accidental infinite prompting with bounded continuation rules or a clear "ask once per limit hit" policy.
- Keep non-interactive behavior and exit codes byte-for-byte identical.

**Effort:** S. This is a localized control-flow change in the loop termination path.

---

## 33 — Follow-up artifacts carry duplicate front-matter blocks

Goal: ensure every loop artifact (audit, follow-up, implement) carries exactly one harness-owned metadata block, so provenance is unambiguous and the agent cannot leave a stale, hallucinated second block on disk.

> Current observation: the follow-up docs in `docs/dev/` (`review-followup-vN-opencode.md`, `plan-followup-v11-opencode.md`) each carry **two** YAML front-matter blocks (4 `---` fences), while audit docs and `impl-v1-opencode.md` carry only one. The second block is agent-written and dead — nothing reads it.

**Findings so far:**

- **Two independent writers each emit a block.** The follow-up agent writes its own front matter when it writes the report, then the harness prepends a canonical block on top via `writeArtifactWithMeta` (`src/provenance.ts:27-32`), which does `buildFrontMatter(meta) + body` without stripping any front matter already present in `body`. The follow-up stage reads the agent-written file and re-stamps it (`src/loop.ts:583-587`).
- **The follow-up skills lack the "harness owns metadata" instruction.** The audit skills carry an explicit note — _"Document metadata … is written as YAML front matter by the orc-smash harness. Do not write metadata headers yourself"_ (`skills/40-simple-review/SKILL.md:138`, `skills/21-simple-plans-audit/SKILL.md:95`) — but `skills/42-simple-review-follow-up/SKILL.md` and `skills/22-simple-plans-follow-up/SKILL.md` do not, so the follow-up agent emits its own block.
- **The two blocks disagree, confirming distinct authors.** In `review-followup-v4-opencode.md` the harness block (top) has `loop: review` + `role: implementer` + a real-precision timestamp from `new Date().toISOString()`, while the agent block (lower) has `loop: review-follow-up`, no `role`, and a round synthetic `.000Z` timestamp.
- **Only the first block is ever read.** `parseArtifactMeta` → `extractFrontMatter` (`src/provenance.ts:35-38`) is a `^`-anchored non-greedy regex that matches only the leading block, so the agent's lower block is silently ignored dead metadata carrying hallucinated values. The duplicate is cosmetic today but becomes a latent correctness bug if write-ordering ever flips or a reader parses the wrong block.
- **Audits and the implement ledger are clean by contrast.** Audit skills tell the agent not to write metadata (one block), and the implement skill's output shape is a ledger table with no front matter (one block); only follow-ups hit both writers at once.

**Fix:**

- Make `writeArtifactWithMeta` robust: strip any leading `---\n…\n---\n` block from `body` before prepending the canonical block, so a second writer can never produce a duplicate regardless of skill wording.
- And/or add the "metadata is written by the harness; do not write metadata headers yourself" instruction to the two follow-up skills so the agent stops emitting its own block (consistent with the audit skills).
- Add a regression test asserting every emitted artifact (audit, follow-up, implement) contains exactly one leading front-matter block after the harness stamps it.

**Effort:** S.

---

## 35 — Implementation-ledger validator rejects non-passing rows but reports a misleading "missing table / confidence" error

Goal: make implementation-ledger validation truthful and contract-aligned, so a provider-written ledger that structurally contains both required tables and a confidence line fails for the real reason and the skill/runtime contract stays in sync.

> Current observation: a real `claude` implementation run wrote [`docs/dev/impl-v1-claude.md`](./dev/impl-v1-claude.md) with both required tables and `State overall confidence: 0.96`, yet the harness terminated with `Ledger at docs/dev/impl-v1-claude.md is missing the required evidence table, requirement coverage table, and/or confidence declaration`. The actual mismatch is in row status semantics, not missing sections.

**Findings so far:**

- **The validator is stricter than the error text.** `src/implement-ledger.ts` requires both tables, a confidence line, and every `Result` / `Status` cell to match the passing-status allow-list. A ledger can therefore fail even when the tables and confidence declaration are present.
- **The observed Claude ledger failed on non-passing row values, not on structure.** In [`docs/dev/impl-v1-claude.md`](./dev/impl-v1-claude.md), rows such as `✅ (deterministic); env-gated pending` and `⏳ release-gate` do not match the current `PASSING_STATUS` contract, so `isCompleteImplementLedger(...)` returns `false`.
- **The runtime error hides the real cause.** `src/loop.ts` collapses every non-empty invalid ledger into the same catch-all message about missing tables / confidence, which sends debugging effort in the wrong direction.
- **The skill and validator need one explicit contract for release-gate items.** If pending env-gated verification is allowed but not implementation-blocking, it should not be encoded as a failing row in the two required gate tables unless the validator is intentionally widened to model that state.

**Fix:**

- Decide one source-of-truth contract for non-blocking release-gate items: either keep the two required tables strictly pass/fail and move pending release-gate items into a separate prose section, or explicitly add a supported pending status shape with clear gating semantics.
- Replace the catch-all invalid-ledger message in `src/loop.ts` with reasoned diagnostics that distinguish missing evidence table, missing coverage table, missing confidence declaration, blank required cells, and non-passing status cells.
- Add regression tests in `tests/implement-ledger.test.ts` and implement-loop gate tests for the real Claude ledger shape, including at least one case with structurally present tables plus pending/release-gate cells.
- If the skill contract changes, update `skills/30-simple-implement/SKILL.md` so provider outputs stop drifting into unsupported ledger states.

**Effort:** S.

---

## Completed work (retained for context)

## 25 — Provider execution contract hardening

Status: shipped in the current codebase.

Goal: make real-provider implementation runs trustworthy by tightening the harness/runtime contract where recent failures exposed gaps.

> Current observation: `codex` can report a clean implementation run yet fail to produce the required `docs/dev/impl-v{n}-codex.md` ledger, while `opencode` can be terminated by the harness timeout before output is generated.

**Findings so far:**

- **`codex` non-interactive autonomy is under-specified in the adapter.** Local `codex exec --help` verification showed the relevant autonomy flag is `--dangerously-bypass-approvals-and-sandbox`, but the current adapter invocation does not pass it.
- **Implementation-stage success is too weakly defined for providers that exit `0`.** Today a provider can look successful at process level and still fail the run only at the post-hoc ledger existence check.
- **The implementation-stage ledger contract is not strongly enough enforced at prompt/contract-test level.** The real-provider codex contract test proves a trivial audit file write, not the implementation ledger flow.
- **`opencode` timeout handling is harness-owned and currently policy-light.** The default watchdog exists at the adapter layer, but the roadmap still needs an explicit decision about whether timeout policy should be global, provider-specific, stage-specific, or primarily operator-configured.

**Fix:**

- Update the `codex` adapter invocation so headless file-writing runs use the correct autonomy mode for this harness.
- Strengthen implementation-stage contract tests so real-provider verification includes the required `docs/dev/impl-v{n}-{agent}.md` artifact path and not just trivial audit-file writes.
- Tighten implementation prompting and/or runtime checks so “process exited successfully” does not masquerade as “implementation execution completed” when the required artifact contract was not actually met.
- Define and document the intended timeout policy ownership for `opencode`: fixed default, config-driven default, per-stage override, or some combination.

**Effort:** M. This is core runtime hardening work for real-provider implementation reliability.

---

## Batch 2 notes

Status: shipped. This batch was about operator-facing output; its items belong together because they all depend on the same rendering surface: live status updates, cleaner TUI chrome, and readable plain-mode output.

## 5 — Live status panel

"Re-render on an interval" is the cheap framing. Accurate live status needs an event-driven adapter lifecycle and a stable render path.

> Current observation: when audit v2 is running, the panel only shows step 1 — as if not updating, not refreshing, or later updates aren't visible.

**Root cause:** the panel is rendered once before each spawn, then a static spinner runs for the whole spawn. v2 is appended to history only after it completes, so during the run the table shows only v1. `console.clear` reprints also flicker and discard scrollback.

**Fix:**

- Ship this incrementally. First establish a stable render region and clean renderer boundary on top of the output abstraction; only then add richer lifecycle/progress updates.
- Expose a small, provider-agnostic lifecycle model (`started`, `message`, `completed`, `failed`) and map provider-specific output into it only where the signal is trustworthy. Avoid inventing fake precision just to make the panel feel busy.
- Add richer per-adapter progress parsing gradually, starting with providers that already expose structured events well. Reuse existing stream parsing where appropriate rather than forcing every adapter into the same richness level on day one.
- Disambiguate iteration, version, and step index in the UI model before adding more live behavior.

**Effort:** L.

---

## 23 — TUI border simplification

Goal: reduce unnecessary visual density in the panel so the terminal UI uses less width and is easier to scan.

> Current observation: the current panel uses layered borders and a table-heavy presentation that consumes space without adding much information value.

**Focus:**

- Remove unnecessary table borders and grid lines.
- Re-evaluate whether the outer panel border needs a separate visual treatment from the timeline.
- If borders remain, use stable color/state signaling that helps distinguish stages directly from the chrome.

**Effort:** S.

---

## 24 — Plain mode multiline readability

Goal: make `--plain` output readable in narrow terminals and mobile terminal apps instead of collapsing state into dense one-line records.

> Current observation: the current plain renderer is scrollback-safe, but it compresses too much panel and timeline state into single lines.

**Focus:**

- Emit loop, iteration, active runner, and next-step fields on separate lines.
- Render timeline entries as stacked records rather than comma-dense summaries.
- Let long values such as model names wrap naturally.
- Prefer clear visual separators between records.

**Effort:** S–M.

---

## Batch 6 notes

Status: proposed. This batch focuses on identifying and hardening execution integration points for `agy` and `codex` CLIs, preventing infinite hangs on connection/stdin issues, and enforcing follow-up artifact validation.

## 36 — Agent CLI connection hanging and follow-up validation gaps

Goal: Prevent loops from hanging indefinitely due to external CLI issues and prevent the loop from silently proceeding when a follow-up step produces no output file.

**Findings:**
- **External CLI Hanging:** 
  - `codex exec` waits indefinitely for input on stdin (`Reading additional input from stdin...`) when stdin is piped but not closed (which happens in certain script execution environments).
  - `agy` hangs indefinitely when it is unauthenticated or when its local daemon/network connectivity is blocked/unavailable.
- **Harness Watchdog Deficiencies:** Because config-only timeouts for `claude`, `codex`, and `agy` default to `0` (disabled) in [orc.config.yaml](file:///Users/lukasz/softDev-temp/orc-smash/orc.config.yaml), the harness never terminates these stuck runs, causing them to stall silently forever without writing any new files.
- **Follow-up Validation Gap:** In [loop.ts](file:///Users/lukasz/softDev-temp/orc-smash/src/loop.ts#L628-L632), the follow-up step runner doesn't assert that the follow-up report (`docs/dev/review-followup-v{n}-{agent}.md`) is created on disk. If it's missing (due to an agent failure or hang), the harness silently defaults `followUpOutcome` to `'patched'` and proceeds to the next audit, leaving no follow-up file.

**Fix:**
- Enable a default/fallback watchdog timeout for all config-only agents (or ensure the harness warns about `0` timeout limits).
- Modify [spawnAgentProcess](file:///Users/lukasz/softDev-temp/orc-smash/src/adapters/utils.ts#L262-L331) to explicitly handle piped stdin situations by closing stdin or redirecting to avoid hangs.
- Add a validator in the loop orchestration to assert that the follow-up report file was written before advancing the state machine (analogous to the implement ledger verification).

**Effort:** M.
