# Roadmap

## Short checklist

Current pending work, grouped into recommended implementation batches.

**Batch 5 — Artifact Integrity & Operator UX**

- [ ] **33 — Follow-up artifacts carry duplicate front-matter blocks**
- [ ] **8 — Prompt to extend iterations at max**

**Batch 6 — Runtime Contract and CLI Hardening**

- [ ] **36 — Agent CLI connection hanging and follow-up validation gaps**
- [ ] **35 — Implementation-ledger validator rejects non-passing rows but reports a misleading "missing table / confidence" error**

**Batch 7 — Docs Canonicalization**

- [ ] **14 — docs canonicalization + broken plan reference fix**
- [ ] **37 — Escalation stage after repeated rejected audits/reviews**

**Batch 8 — Unified Action Menu follow-up**

- [ ] **Menu — CONTINUE silently uses the manifest-default model when no prior session exists for the step kind**

## Detailed checklist

Open work is listed below.

> **Verification status (2026-07-02).** Every item was re-checked against the current
> source — **none have been fixed; all remain open.** Corrections from that pass:

> - **#33 / #35** evidence anchors are **stale**: the cited `docs/dev/*` artifacts
>   (`review-followup-vN-*.md`, `plan-followup-v11-*.md`, `impl-v1-claude.md`) were
>   deleted by the recent "Clean roadmap and remove stale plan doc" commit (`docs/dev/`
>   now holds only `.DS_Store`). The code-behavior claims still hold; the reproducers do not.
> - **#36** "piped stdin" sub-issue is **already mitigated**: every spawn uses
>   `stdio: ['ignore', 'pipe', 'pipe']` (`src/adapters/utils.ts:107`), so stdin is
>   `/dev/null`. The watchdog-default and follow-up-validation gaps remain real.
> - **#14** is **worse than stated**: the same cleanup commit left **live broken
>   links** to the now-deleted `docs/dev/plan.md` in `README.md:72,103` and
>   `AGENTS.md:15,115`. Consider doing this sooner than "last."
> - **Post-verification update (2026-07-07):** the unified-action-menu feature
>   shipped after the 2026-07-02 pass. It **removed `promptSecondOpinionDecision`**
>   (so #8's "stop vs second-opinion" note is obsolete — the menu's
>   `promptStageAction` is the current prompt to mirror) and `docs/dev/plan.md`
>   was **re-created** (so #14's "deleted / live broken links" framing no longer
>   applies — the links resolve, but the link *text* is now stale). #33/#35/#36
>   are unaffected and remain open; #37 is unaffected.

## Architecture assumptions and implementation goal

Every checklist item below should be implemented against the same architectural standard:

- Prefer **clear module boundaries** over generic helper extraction. A new file is justified only when it owns a stable responsibility, shared domain rule, or testable contract.
- Prefer **small pure modules** for domain rules (`patterns`, next-step resolution, shared contracts) and keep orchestration in a small number of runtime entrypoints.
- Avoid vague catch-all files such as `helpers.ts`, `misc.ts`, or `common.ts`. If a module cannot be named by responsibility, it probably should not exist.
- Keep the runtime **incrementally evolvable**. Refactors should create seams for later features without forcing a top-down rewrite or a folder reorganization for its own sake.
- Keep abstractions **data-oriented and explicit**: structured events, typed contracts, single-source-of-truth rules, and adapter boundaries that separate provider-specific behavior from shared harness behavior.
- Preserve **behavioral stability** while refactoring. The goal is cleaner structure, not silent product changes, except where the checklist item explicitly adds user-facing behavior.

The implementation goal for this roadmap is a **clean, scalable, high-quality harness architecture**: fewer duplicated rules, fewer hidden couplings, smaller orchestration files, explicit runtime contracts, and only purposeful modules added where they improve clarity and long-term maintenance.

**Batch 5 — Artifact Integrity & Operator UX**

- [ ] **33 — Follow-up artifacts carry duplicate front-matter blocks.** Follow-up docs (`review-followup-vN-*`, `plan-followup-vN-*`) end up with two YAML front-matter blocks: the agent writes its own and the harness prepends a second via `writeArtifactWithMeta` (`src/provenance.ts`) without stripping the first, because the follow-up skills lack the "harness owns metadata" note the audit skills carry. Strip any existing leading block before stamping (and/or mirror the audit-skill instruction) and add a one-block-per-artifact regression test.
- [ ] **8 — Prompt to extend iterations at max (consideration).** When the loop hits `max-iterations`, offer interactive users a controlled continuation choice without changing non-interactive behavior. Prefer bounded preset actions first (`stop`, `+1`, `+3`, `+5`) with optional custom input only if it proves necessary.

**Batch 6 — Runtime Contract and CLI Hardening**

- [ ] **36 — Agent CLI connection hanging and follow-up validation gaps.** Address cases where generic agent CLIs (`codex`, `agy`) hang indefinitely in certain execution environments (e.g. `codex` reading from a piped stdin, or `agy` waiting on blocked network/daemon connectivity) without completing. Under the default config where agent watchdog timeouts are disabled (`0`), these hangs block the loop indefinitely without output. Additionally, establish a validation check to ensure that the follow-up step actually writes the required report file before proceeding, preventing the loop from advancing silently without producing the follow-up artifact.
- [ ] **35 — Implementation-ledger validator rejects non-passing rows but reports a misleading "missing table / confidence" error.** A real `claude` implementation wrote `docs/dev/impl-v1-claude.md` (file since deleted; row values reproduced inline) with both required tables and `State overall confidence: 0.96`, yet the harness still terminated with the generic "missing evidence table / requirement coverage table / confidence declaration" message. The real mismatch is stricter: `src/implement-ledger.ts` currently requires every `Result` / `Status` cell in the required tables to match the passing-status allow-list, and this ledger contains non-passing rows such as `✅ (deterministic); env-gated pending` and `⏳ release-gate`. Decide one explicit contract for pending release-gate items, improve the runtime error in `src/loop.ts` so it reports the true failure reason, and add regression coverage for this exact ledger shape.

**Batch 7 — Docs Canonicalization**

- [ ] **14 — docs canonicalization + broken plan reference fix.** Make `docs/architecture/overview.md` the canonical architecture source, reduce duplicated architecture prose elsewhere, and fix or remove the broken `docs/dev/plan.md` references after the remaining runtime and rendering changes have landed so the docs only need one final alignment pass.
- [ ] **37 — Escalation stage after repeated rejected audits/reviews.** After `N` consecutive rejected audits or reviews, the loop should enter a dedicated escalation stage that runs an analysis skill over the rejection history and writes an advice artifact answering whether the operator should patch the current source artifact (`plan.md`, implementation, etc.) or continue with another follow-up plus audit attempt. The advice result should appear in the normal timeline/status table with a clear outcome such as `continue` or `patch plan.md`. Open design question: decide whether this stage should be powered by one shared cross-loop escalation skill with loop-aware inputs, or separate skills for the plan loop and review loop.

---

## Batch 5 notes

This batch groups two small, operator-visible fixes: one artifact-integrity correction and one interactive control-flow improvement. Neither should materially reshape the runtime architecture.

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

## 8 — Prompt to extend iterations at max (consideration)

Goal: when the loop reaches `max-iterations`, instead of a hard stop, offer the interactive user a choice —
extend by N more iterations, or stop — so a run that's converging isn't cut off just because the up-front
guess was too low.

> Current observation: after the iteration budget is exhausted the app fully stops with
> `hit max-iterations, awaiting human`. There is no chance to continue without re-running.

**Findings so far:**

- **It is a hard stop today.** `src/loop.ts` falls out of the `while (iteration < options.maxIterations)` loop and returns `hit max-iterations, awaiting human` in both interactive and non-interactive modes.
- **A similar prompt already exists** at the other decision point: since the unified action menu shipped, interactive mode at `APPROVED` (and every decision point) uses `promptStageAction` (`src/interactive.ts`). `promptMaxIterations` also already asks for the count up-front, so this change mirrors existing interaction patterns. _(The earlier stop-vs-second-opinion prompt, `promptSecondOpinionDecision`, was removed by the menu work — mirror `promptStageAction`, not it.)_
- **Extending is mechanically cheap.** `maxIterations` lives on `LoopOptions`, so extending is a local control-flow change rather than a state-model rewrite.
- **Must be interactive-only.** CI and `--loop` runs should keep the current exit behavior.

**Fix (to consider):**

- Add a dedicated continuation prompt to `src/interactive.ts`, but prefer bounded preset actions first (`stop`, `+1`, `+3`, `+5`) over free-form numeric input.
- Restructure the loop-exit branch so interactive continuation happens before the function returns, rather than by relying on awkward post-loop state mutation.
- Guard against accidental infinite prompting with bounded continuation rules or a clear "ask once per limit hit" policy.
- Keep non-interactive behavior and exit codes byte-for-byte identical.

**Effort:** S. This is a localized control-flow change in the loop termination path.

---

## Batch 6 notes

This batch is the highest-risk runtime work still open. It groups loop-liveness failures and contract-validation failures because both affect whether the harness can safely advance state after a provider run.

## 36 — Agent CLI connection hanging and follow-up validation gaps

Goal: Prevent loops from hanging indefinitely due to external CLI issues and prevent the loop from silently proceeding when a follow-up step produces no output file.

**Findings:**

- **External CLI Hanging:**
  - `codex exec` waits indefinitely for input on stdin (`Reading additional input from stdin...`) when stdin is piped but not closed (which happens in certain script execution environments).
  - **Verification (2026-07-02): already mitigated on the harness path.** Every spawn goes through `runProcess` with `stdio: ['ignore', 'pipe', 'pipe']` (`src/adapters/utils.ts:107`), so stdin is `/dev/null` (closed) — codex reading stdin gets EOF, not a hang. Drop this sub-issue unless a spawn path that pipes stdin is introduced.
  - `agy` hangs indefinitely when it is unauthenticated or when its local daemon/network connectivity is blocked/unavailable.
- **Harness Watchdog Deficiencies:** Because config-only timeouts for `claude`, `codex`, and `agy` default to `0` (disabled) in [orc.config.yaml](/Users/lukasz/softDev-temp/orc-smash/orc.config.yaml), the harness never terminates these stuck runs, causing them to stall silently forever without writing any new files.
- **Follow-up Validation Gap:** In [loop.ts](/Users/lukasz/softDev-temp/orc-smash/src/loop.ts#L628), the follow-up step runner doesn't assert that the follow-up report (`docs/dev/review-followup-v{n}-{agent}.md`) is created on disk. If it's missing (due to an agent failure or hang), the harness silently defaults `followUpOutcome` to `'patched'` and proceeds to the next audit, leaving no follow-up file.

**Fix:**

- Enable a default/fallback watchdog timeout for all config-only agents or ensure the harness warns when timeouts remain disabled.
- ~~Modify [utils.ts](/Users/lukasz/softDev-temp/orc-smash/src/adapters/utils.ts) to explicitly handle piped stdin~~ — **already done** (`stdio: ['ignore', …]` at `utils.ts:107`). Remaining real work here is the watchdog default and the follow-up-file validator below.
- Add a validator in the loop orchestration to assert that the follow-up report file was written before advancing the state machine, analogous to the implement ledger verification.

**Effort:** M.

---

## 35 — Implementation-ledger validator rejects non-passing rows but reports a misleading "missing table / confidence" error

Goal: make implementation-ledger validation truthful and contract-aligned, so a provider-written ledger that structurally contains both required tables and a confidence line fails for the real reason and the skill/runtime contract stays in sync.

> Current observation: a real `claude` implementation run wrote `docs/dev/impl-v1-claude.md` (file since deleted; row values reproduced inline) with both required tables and `State overall confidence: 0.96`, yet the harness terminated with `Ledger at docs/dev/impl-v1-claude.md is missing the required evidence table, requirement coverage table, and/or confidence declaration`. The actual mismatch is in row status semantics, not missing sections.

**Findings so far:**

- **The validator is stricter than the error text.** `src/implement-ledger.ts` requires both tables, a confidence line, and every `Result` / `Status` cell to match the passing-status allow-list. A ledger can therefore fail even when the tables and confidence declaration are present.
- **The observed Claude ledger failed on non-passing row values, not on structure.** In `docs/dev/impl-v1-claude.md` (file since deleted; row values reproduced inline), rows such as `✅ (deterministic); env-gated pending` and `⏳ release-gate` do not match the current `PASSING_STATUS` contract, so `isCompleteImplementLedger(...)` returns `false`.
- **The runtime error hides the real cause.** `src/loop.ts` collapses every non-empty invalid ledger into the same catch-all message about missing tables / confidence, which sends debugging effort in the wrong direction.
- **The skill and validator need one explicit contract for release-gate items.** If pending env-gated verification is allowed but not implementation-blocking, it should not be encoded as a failing row in the two required gate tables unless the validator is intentionally widened to model that state.

**Fix:**

- Decide one source-of-truth contract for non-blocking release-gate items: either keep the two required tables strictly pass/fail and move pending release-gate items into a separate prose section, or explicitly add a supported pending status shape with clear gating semantics.
- Replace the catch-all invalid-ledger message in `src/loop.ts` with reasoned diagnostics that distinguish missing evidence table, missing coverage table, missing confidence declaration, blank required cells, and non-passing status cells.
- Add regression tests in `tests/implement-ledger.test.ts` and implement-loop gate tests for the real Claude ledger shape, including at least one case with structurally present tables plus pending/release-gate cells.
- If the skill contract changes, update `skills/30-simple-implement/SKILL.md` so provider outputs stop drifting into unsupported ledger states.

**Effort:** S.

---

## Batch 7 notes

This batch is intentionally last. It consolidates architecture documentation only after the remaining runtime, rendering, and contract changes have settled.

## 14 — Docs canonicalization + broken plan reference fix

Goal: make the architecture documentation internally consistent, reduce duplication, and remove stale references that no longer match the repo's current source-of-truth layout.

> Current observation: architecture guidance is split across multiple documents, and some references still point at `docs/dev/plan.md` even though that file is no longer a stable canonical target.

> **Verification (2026-07-02; updated 2026-07-07):** `docs/dev/plan.md` was later **re-created** (it now holds the Batches 5–7 follow-up plan), so the `README.md` (:74,:105) and `AGENTS.md` (:15,:116) links **resolve again** — they are no longer broken. The remaining issue is that the link *text* is stale (calls plan.md the "current implementation plan" / "design source of truth") while the file's own header says "deferred." The canonicalization goal stands; the "broken links" framing no longer applies, and the line numbers have drifted.

**Focus:**

- Make [docs/architecture/overview.md](/Users/lukasz/softDev-temp/orc-smash/docs/architecture/overview.md) the canonical architecture reference.
- Reduce duplicated architecture prose in [README.md](/Users/lukasz/softDev-temp/orc-smash/README.md), [AGENTS.md](/Users/lukasz/softDev-temp/orc-smash/AGENTS.md), and other supporting docs where the same rules are repeated.
- Fix or remove stale references to `docs/dev/plan.md` and any other outdated roadmap-era anchors.
- Do one final wording-alignment pass only after the remaining runtime and rendering items are finished, so this cleanup does not need to be repeated.

**Effort:** S.

---

## 37 — Escalation stage after repeated rejected audits/reviews

Goal: prevent blind retry loops after repeated rejected audits or reviews by adding an explicit loop stage that evaluates the rejection history and advises whether to patch the source artifact or continue iterating.

> Current observation: when the same plan or review work is rejected repeatedly, the current workflow has no first-class mechanism to inspect the sequence of rejected artifacts and decide whether the process should continue with another follow-up/audit cycle or stop and patch the source artifact itself.

**Focus:**

- Define an `N`-rejection threshold that transitions the loop into an escalation stage for repeated rejected audits or reviews.
- Introduce the stage-specific analysis skill that consumes the rejected artifact history and writes a structured advice artifact.
- Ensure the advice artifact participates in the normal timeline/status display and renders a clear result such as `continue` or `patch plan.md`.
- Define the state-machine behavior after escalation: whether the outcome is advisory-only, changes the default next step, or gates further follow-up/audit attempts.
- Decide whether the stage should be powered by one shared cross-loop skill with loop-aware inputs, or split into separate plan-loop and review-loop variants.
- Keep the feature compatible with manifest-as-data, including loop/stage declaration, artifact naming, and timeline rendering.

**Effort:** M.

---

## Batch 8 notes

Follow-ups to the **shipped** unified-action-menu feature (commits `b2a0f01` + `334b9ff`). These are gaps in already-shipped behavior, not new roadmap capability, so they are tracked separately from Batches 5–7 to keep those batches scoped to their themes.

> **Plan status (2026-07-07):** the follow-up plan in `docs/dev/plan.md` is now
> **approved**. Implementation should treat that plan as the source of truth for Batch 8.
> The most important late clarification is that approved-phase `continue` is no longer a
> single audit-only resume: it should continue the full upcoming `audit -> follow-up`
> segment, prompting only for step kinds that do not already have resumable sessions and
> re-prompting only after the whole segment completes.

## Menu — CONTINUE silently uses the manifest-default model when no prior session exists for the step kind

Goal: when a user picks CONTINUE, the harness should treat it as continuation of the
next whole chain segment, not as a one-step action with hidden defaults. For each step
in that segment, inherit the runner from a prior session of that step kind when one
exists; when no such session exists, prompt up front for that step's provider/model
instead of silently substituting the skill's manifest-default model.

> Current observation: auditing with one model (e.g. `codex/gpt-5.5`) and then
> selecting CONTINUE on the rejected audit can spawn the follow-up on
> `opencode/opencode-go/deepseek-v4-flash` — the `plan-follow-up` skill's manifest
> default (`skills.yaml:18-19`, also the global registry default) — with no prompt.
> Separately, approved-phase `CONTINUE CHAIN — resume the APPROVAL session` can behave
> like a one-off audit rerun when no resumable session exists, creating a fresh session
> id, asking for only one runner, and re-prompting immediately after the audit. In both
> cases the operator is denied coherent up-front control over the whole upcoming chain
> segment.

**Findings so far:**

- **CONTINUE does not prompt** — by design it inherits provider+model and offers no picker (`src/loop.ts` `chooseAction` + the START NEW / RUN ONE STEP branches are the only ones that call `promptRunners`).
- **Inheritance is per-step-kind** (unified-action-menu plan invariant 2): the follow-up runner is resolved from prior *follow-up* steps, the audit runner from prior *audit* steps. The audit's model is intentionally not inherited by the follow-up.
- **On the first follow-up there is no prior follow-up session**, so the inheritance walk (`findResumableSession`) returns nothing. Resolution then falls back to the runner `smash.ts` resolved non-interactively — the skill's manifest default.
- **The same gap affects approved-phase continue semantics.** When approved-phase
  `continue` has no resumable approval-session audit, the code can fall back to a fresh
  audit run with a new session id, but the action still behaves like a single audit step
  instead of a full `audit -> follow-up` segment.
- **The plan's fallbacks must cover both the *session* and the *runner*.** "resumed
  requested but no prior session → warn + fall back to fresh" is correct for continuity
  mode. It is not sufficient for runner selection: the harness must prompt for any step
  in the segment that lacks its own resumable session instead of silently using the
  manifest default.
- **Related:** unified-action-menu review v1 Major-3 (single ownership of runner resolution) and review v2 Minor-B (duplicated backward-walk for CONTINUE runner resolution). This is a distinct edge case in the same area.

**Fix:**

- When CONTINUE is chosen, resolve the full upcoming chain segment up front:
  rejected-state `continue` resolves `follow-up -> audit` or `audit -> follow-up`
  depending on phase, and approved-phase `continue` resolves `audit -> follow-up`.
- For each step kind in that segment, when `findResumableSession` returns null, **prompt
  for the runner** (`promptRunners`) instead of silently substituting the manifest
  default. Keep the warn-and-fresh behavior for the session.
- When one step has a resumable session and the other does not, prompt only for the
  missing step. When both have resumable sessions, prompt for neither. When neither has a
  resumable session, prompt for both.
- Re-prompt only after the whole segment completes, not between the two steps.
- Add loop tests covering rejected continue, approved continue, mixed inheritance, and
  no-session cases so the segment never silently degrades into a one-step rerun plus
  menu prompt.

**Effort:** S.
