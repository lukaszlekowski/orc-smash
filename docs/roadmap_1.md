# Roadmap 1 — Near-term implementation (batches A–D)

> Deferred batches E–G (items **#36**, **#37**, **#14**) live in `roadmap_2.md`.

## Short checklist

Current pending work, grouped into recommended implementation batches.

**Batch A — Runner & session continuity**

- [x] **Menu — CONTINUE silently uses the manifest-default model when no prior session exists for the step kind**
- **43 — Chain follow-up never resumes its prior session (startup 'resumed' → 'new' downgrade is permanent)**
  - [x] plan / plan-follow-up — done (verified by test (m); the resume assertion is proven discriminating)
  - [x] review / review-follow-up — done (verified by test (n): review-follow-up v2 resumes v1's session id through the shared `runLoop` continuity code — the #43 fix holds on the review path)

**Batch B — smash output & error diagnostics**

- [ ] **39 — `smash` panel does not refresh timeline after persisted follow-up artifacts**
- [ ] **40 — `smash` startup notes report plan-stage artifacts when running a non-plan loop (review)**
- [ ] **41 — Clean implement failures leave no diagnostic artifact (only interrupts / auth errors do)**
- [ ] **42 — Hold the alt screen until q/Esc on run end (timestamps + main-screen error flush shipped; hold-to-dismiss remains)**

**Batch C — Artifact & validation integrity**

- [ ] **33 — Follow-up artifacts carry duplicate front-matter blocks**
- [ ] **35 — Implementation-ledger validator rejects non-passing rows but reports a misleading "missing table / confidence" error**

**Batch D — Interactive exit / recovery prompts**

- [ ] **8 — Prompt to extend iterations at max**
- [ ] **38 — Manual retry flow for transient provider / transport failures**

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

## Quick summaries

**Batch C — Artifact & validation integrity**

- [ ] **33 — Follow-up artifacts carry duplicate front-matter blocks.** Follow-up docs (`review-followup-vN-*`, `plan-followup-vN-*`) end up with two YAML front-matter blocks: the agent writes its own and the harness prepends a second via `writeArtifactWithMeta` (`src/provenance.ts`) without stripping the first, because the follow-up skills lack the "harness owns metadata" note the audit skills carry. Strip any existing leading block before stamping (and/or mirror the audit-skill instruction) and add a one-block-per-artifact regression test.

**Batch D — Interactive exit / recovery prompts**

- [ ] **8 — Prompt to extend iterations at max (consideration).** When the loop hits `max-iterations`, offer interactive users a controlled continuation choice without changing non-interactive behavior. Prefer bounded preset actions first (`stop`, `+1`, `+3`, `+5`) with optional custom input only if it proves necessary.

**Batch C (cont.) — Artifact & validation integrity**

- [ ] **35 — Implementation-ledger validator rejects non-passing rows but reports a misleading "missing table / confidence" error.** A real `claude` implementation wrote `docs/dev/impl-v1-claude.md` (file since deleted; row values reproduced inline) with both required tables and `State overall confidence: 0.96`, yet the harness still terminated with the generic "missing evidence table / requirement coverage table / confidence declaration" message. The real mismatch is stricter: `src/implement-ledger.ts` currently requires every `Result` / `Status` cell in the required tables to match the passing-status allow-list, and this ledger contains non-passing rows such as `✅ (deterministic); env-gated pending` and `⏳ release-gate`. Decide one explicit contract for pending release-gate items, improve the runtime error in `src/loop.ts` so it reports the true failure reason, and add regression coverage for this exact ledger shape.

---

## Batch A notes — Runner & session continuity

Runner selection and session-continuity for chain segments: CONTINUE must prompt for any step kind lacking a resumable session (instead of silently using the manifest default), and a chain's follow-up must resume the prior follow-up's session instead of running fresh every iteration.

> **Plan status (2026-07-07):** the follow-up plan in `docs/dev/plan.md` is now
> **approved**. Implementation should treat that plan as the source of truth for Batch A.
> The most important late clarification is that approved-phase `continue` is no longer a
> single audit-only resume: it should continue the full upcoming `audit -> follow-up`
> segment, prompting only for step kinds that do not already have resumable sessions and
> re-prompting only after the whole segment completes.

### Menu — CONTINUE silently uses the manifest-default model when no prior session exists for the step kind

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

---

### 43 — Chain follow-up never resumes its prior session (startup 'resumed' → 'new' downgrade is permanent)

Goal: in a chain (START NEW / CONTINUE) that cycles through multiple versions, each
follow-up should resume the prior follow-up's session — like the audit does — instead of
starting fresh every version.

> Current observation: a review chain (codex audit + opencode follow-up) cycled v1→v4 on
> repeated rejection. The audit kept one session id (`*a096f` across v1–v4) but the
> follow-up got a fresh session every version (`awTfO` → `FmoJk` → `kqnnT`), defeating
> session continuity for the follow-up step.

**Findings so far:**

- **The startup downgrade is permanent.** `resolveUpfrontRunners` (`src/loop.ts:557-560`)
  downgrades a `'resumed'`-policy step to `'new'` when no prior session exists to inherit
  at startup. `upfrontPolicies` is never re-evaluated — `resolveUpfrontRunners` is a no-op
  mid-chain for already-resolved runners — so a follow-up on a fresh chain is locked to
  `'new'` for the whole chain and every follow-up runs fresh.
- **The adapter can resume; it is just never asked.** opencode supports `-c <sessionId>`
  resume (`src/adapters/opencode.ts:41-42`) and each follow-up returns a fresh session id,
  so v2/v3/v4 *could* resume v1/v2/v3 — but the locked `'new'` policy means the resumed
  branch in Step A (`src/loop.ts:~977-990`) is never taken.
- **Why the audit resumes but the follow-up doesn't.** At this run's startup a prior codex
  audit session existed to inherit (audit stayed `'resumed'`, keeps resuming one id), but
  no prior opencode follow-up session existed (follow-up downgraded to `'new'`).
- **The downgrade exists to suppress a warning** — and that warning is load-bearing both
  ways: `loop-continuity.test.ts` (non-interactive) expects `"resumed requested … no prior
  session"` to warn; `loop-followup-runner` b5/b6 (interactive) expect it suppressed.
- **Pre-existing** — not introduced by the chain-mode cycling fix or the timestamp work.

**Fix:**

- Stop locking the policy to `'new'`. Keep the step's policy as chosen (`'resumed'`) for
  the chain and let the per-cycle `findResumableSession` in Step A / Step B resume when a
  prior session exists — so follow-up v2+ resumes v1's session.
- Reconcile the warning contract: a fresh chain's first follow-up legitimately has nothing
  to resume, so "no prior session → fresh" should be silent (or a note), not a warning;
  reserve the warning for a genuine mismatch (prior steps of that kind exist but none
  match agent/model). Update the six assertions in `loop-continuity.test.ts` and
  `loop-followup-runner.test.ts` (b5/b6) to match.
- Add a regression test: a fresh chain (no prior follow-up) where follow-up v2 resumes v1's
  session id (prompt/artifact-version assertion, like the existing chain tests).

**Effort:** M.

---

## Batch B notes — smash output & error diagnostics

Operator-visible output and error diagnostics in `smash` runs.

### 39 — `smash` panel does not refresh timeline after persisted follow-up artifacts

Goal: when a follow-up or audit artifact is written during an interactive `smash` run,
the live panel should reflect the updated timeline immediately instead of requiring a
subsequent fresh scan through `orc status` or a new `smash` invocation.

> Current observation: after running a manual follow-up step, the follow-up artifact is
> written under the target's `docs/dev/` and `orc status` shows it correctly, but the
> live `smash` timeline shown during the current run does not visibly update to include
> that persisted step. This makes it look like the step was not recorded even though the
> artifact exists and the next scan sees it.

**Findings so far:**

- **The filesystem scan is working.** `orc status` performs a fresh `scan(...)` over the
  target root and correctly discovers the new follow-up artifact, so the issue is not in
  filename matching, artifact persistence, or state normalization.
- **The gap appears to be in live rendering / state refresh during `smash`.** The
  running loop maintains in-memory step state and emits progress events, but the live
  panel does not always re-render from a freshly scanned timeline after a one-off or
  manual follow-up completes.
- **This is especially confusing after one-off actions.** When an operator runs a manual
  follow-up because `CONTINUE` was disabled or unavailable, they reasonably expect the
  timeline in the same run to show that follow-up immediately before the next action
  prompt.
- **Authoritative state should stay filesystem-backed.** The correct fix direction is not
  to create a parallel UI-only timeline model that can drift. The live panel should be
  refreshed from the same normalized step facts / scan source that powers `orc status`,
  or from an equivalent canonical in-memory representation that is guaranteed to match the
  persisted artifact facts.

**Fix:**

- Refresh the live `smash` timeline after step completion using the same canonical facts
- source that `status` uses, especially after follow-up artifact persistence and before
- re-prompting the operator.
- Ensure one-off follow-up and one-off audit paths update the visible timeline before the
  next action menu is shown.
- Add regression coverage for:
  - one-off follow-up writes artifact → live timeline shows the new step in the same run
  - normal chained follow-up writes artifact → live timeline stays in sync
  - `orc status` and the live `smash` panel agree on timeline contents after each step

**Effort:** S.

---

### 40 — `smash` startup notes report plan-stage artifacts when running a non-plan loop

Goal: when a non-plan loop is run (e.g. `review`), the startup notes should describe that
loop's own audit/follow-up artifacts (or report `none`), not the `plan` loop's artifacts.

> Current observation: running `orc smash` and selecting the `review` loop (with no
> review artifacts on disk yet) prints `most recent plan audit:
> docs/dev/plan-audit-v3-codex.md, decision: APPROVED …` and `most recent follow-up:
> docs/dev/plan-followup-v2-codex.md …` — both plan-stage artifacts — while the action
> menu correctly offers `review v1 → review-follow-up v1`. The notes and the menu
> disagree about which loop is running.

**Findings so far:**

- **The startup notes are hard-wired to the `plan` loop.** `src/loop.ts:853-854` resolves
  `planSpec = config.manifest.loops['plan']!` and scans `planSpec`'s audit/follow-up
  patterns regardless of the `loopName`/`loopSpec` actually being run, then emits
  `most recent plan audit` / `most recent follow-up` notes (`src/loop.ts:856-866`).
- **The decision path is already loop-correct.** `initialScan` at `src/loop.ts:868` uses
  `loopSpec.auditPattern` / `loopSpec.followUpPattern`, and `chooseAction` builds the
  menu from the current loop — which is why the menu shows `review v1` while the notes
  show plan. Only the human-readable notes leak across loops.
- **The `plan document located: docs/dev/plan.md` note is plan-specific too** and is
  emitted for every loop; for the `review` loop it is irrelevant.
- **This section is only reached for plan/review loops** — the `implement` branch
  (`src/loop.ts:615-847`) returns earlier — so driving the notes from `loopSpec` is safe:
  both plan and review carry audit/follow-up patterns.
- **No state is corrupted** — this is a display/clarity bug, not a control-flow bug. But
  it is misleading at exactly the moment an operator decides what to do next, and makes a
  fresh review run look like it is resuming plan-stage work.

**Fix:**

- Drive the startup "most recent audit / follow-up" notes from the current `loopSpec`
  (the same patterns `initialScan` already uses), label them by loop (`most recent review
  audit` / `most recent plan audit`), and report `none` when no artifacts exist for that
  loop.
- Make the `plan document located` note plan-loop-only (emit when `loopName === 'plan'`,
  or drop it for non-plan loops).
- Add a regression test asserting that running the `review` loop with no review artifacts
  prints `most recent review audit: none` (not plan artifacts), while the menu still
  offers `review v1`.

**Effort:** S.

---

### 41 — Clean implement failures leave no diagnostic artifact (only interrupts / auth do)

Goal: when an implement run fails cleanly (provider error, nonzero exit, missing or
invalid ledger), preserve a diagnostic artifact the way an interrupt does — so the
operator can inspect the stopped work and `orc status` reflects that a run was attempted.

> Current observation: an interactive `implement` run (opencode) exited mid-run; afterward
> there is no `docs/dev/impl-vN-*.md` and `.orc-smash/interrupted.json` is absent, so `orc
> status` and the folder are both empty. The operator expected a "stopped work" artifact
> like an interrupt leaves, but got nothing.

**Findings so far:**

- **The interrupt safety net is signal-only.** The durable `.orc-smash/interrupted.json`
  marker is written by the signal handler from the step context registered via
  `setStepCtx` in `runAdapter` (`src/loop.ts`), so it fires only on SIGINT/SIGTERM
  mid-spawn — not on a clean provider failure.
- **Clean implement failures preserve an artifact only for `auth`.** `src/loop.ts:690-702`
  quarantines via `quarantineAuthArtifact` only when `result.error?.kind === 'auth'`
  (`:691-693`); every other failure kind — nonzero exit, `missing_output`
  (`:718-727`), `invalid_output` (`:729-741`), and the truncated/interrupted completion at
  `:704-713` — returns early with no marker and no preserved artifact.
- **If the agent wrote nothing, there is nothing on disk.** The missing-output path is
  reached when the agent exits cleanly but produced no ledger; the invalid path leaves the
  raw (invalid) file in place but does not flag it. So a provider that errors before
  writing leaves zero trace.
- **`lastAuditPath` is `null` on these returns** (`emitFinalSummary(..., null)`), so the
  final summary points at nothing and `orc status` has no implement step to show.
- **Likely trigger for this run:** a provider startup/connection failure (roadmap #36,
  "Agent CLI connection hanging") — a clean failure that writes no ledger. Compounding
  factor: the run used the silently-selected default model (`opencode/deepseek-v4-flash`,
  see the implement model-selection fix), so the operator did not choose the provider that
  failed.

**Fix:**

- On any clean implement failure, preserve the partial ledger if one exists (move the raw
  `impl-vN-*.md` into quarantine alongside the interrupt path, or stamp it with a failure
  marker) and/or write a lightweight failure record so `orc status` can show that an
  implement run was attempted and how it failed.
- Generalize the `auth`-only `quarantineAuthArtifact` branch at `src/loop.ts:691-693` into
  a shared "preserve stopped-work artifact on failure" helper covering the nonzero-exit,
  missing-output, and invalid-output paths — the same gap exists in the audit / follow-up
  `stepFailed` branches.
- Add a regression test asserting that a clean implement failure (nonzero exit, no ledger)
  leaves a discoverable artifact/marker and that `orc status` surfaces it.
- Operator-facing: surface the failure reason durably — today it lives only in the
  transient `structuredMessage` output; recommend `--debug-spawn` to capture provider
  stderr for these cases.

**Effort:** S–M.

---

### 42 — Hold the alternate screen until q/Esc on run end

> **Status (2026-07-08):** option (a) shipped — `error` / `stepFailed` / `finalSummary`
> now prefix a `[HH:MM:SS]` timestamp, and failures raised while the live region is active
> are buffered and flushed to the main screen in `finalSummary` (`src/cli-output.ts`), so
> the "screen disappears with the error" case is fixed. Only option (b) (hold-to-dismiss)
> remains open.

Goal: when a `smash` run ends — especially on failure — the operator must be able to see
why it ended, without the live panel vanishing and taking the error with it.

> Current observation: a review chain (codex audit + agy follow-up) exited on an agy
> failure; the rich live panel disappeared and no error was visible afterward. The agy
> error was only ever printed to the terminal and was unrecoverable from disk.

**Findings so far:**

- **Panel mode renders on the terminal alternate screen.** `attachLiveRegion` enters the
  alt screen (`[?1049h`, `src/cli-output.ts:8,160`) and re-renders every
  `PANEL_RENDER_INTERVAL_MS` (1000ms, `:11,161`) with a clear-and-redraw
  (`CURSOR_HOME_CLEAR`, `:10`). Terminals do not preserve the alt screen in scrollback.
- **`finalSummary` tears it down immediately.** It calls `detach()` then
  `restoreMainScreen()` (`EXIT_ALT_SCREEN`, `:9,142`), discarding the whole alt screen and
  printing only the final summary line on the main screen.
- **Step errors written during a live step are lost twice over.** `stepFailed` while
  `liveActive` writes via `console.error` to the alt screen (`src/cli-output.ts:127`),
  where the 1s re-render overwrites it and the teardown then discards it — so the detailed
  error never reaches the persistent main screen / scrollback.
- **No durable error log exists.** The failure reason lives only in the transient
  `structuredMessage` / `stepFailed` output; nothing is written to disk unless the
  operator passed `--debug-spawn`.

**Fix (two options, not mutually exclusive):**

- **(a) Durable + main-screen errors — shipped.** `error` / `stepFailed` / `finalSummary`
  now prefix a `[HH:MM:SS]` timestamp, and failures raised while the live region is active
  are buffered and flushed to the main screen in `finalSummary` (`src/cli-output.ts`). (A
  durable log file is a possible future add-on.)
- **(b) Hold the alt screen until the operator dismisses it — nicer UX, more involved.**
  On run end, render the final panel (with the error) and wait for `q` / `Esc` (or any
  key) before `restoreMainScreen()`, mirroring `less` / `htop`. This needs raw-mode
  keypress reading (`process.stdin.setRawMode(true)`), must be **TTY-gated** so CI / piped
  runs do not hang on a keypress, must handle `SIGINT` / Ctrl-C during the wait, and is
  harder to unit-test (needs a testable seam around stdin). Effort: M.

**Recommendation:** (a) shipped. (b) is a follow-up for when the hold-to-read UX is
wanted.

**Effort:** M (remaining — b only).

---

## Batch C notes — Artifact & validation integrity

Artifact structure and implementation-ledger validation integrity.

### 33 — Follow-up artifacts carry duplicate front-matter blocks

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

### 35 — Implementation-ledger validator rejects non-passing rows but reports a misleading "missing table / confidence" error

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

## Batch D notes — Interactive exit / recovery prompts

Interactive exit and recovery prompts.

### 8 — Prompt to extend iterations at max (consideration)

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

### 38 — Manual retry flow for transient provider / transport failures

Goal: when a provider run fails for a transient infrastructure reason (for example
provider overload, temporary upstream gateway failure, or short-lived transport
instability), give the operator a first-class way to retry the same step with the same
resolved runner and version instead of forcing a full manual re-entry of the command and
menu flow.

> Current observation: a real `claude` run using `glm-5.2` can terminate with a
> server-side overload error such as `API Error: 529 ... service may be temporarily
> overloaded`. Today that resolves to terminal `unknown`, the loop stops, and the
> operator must restart `orc smash` manually even though the desired next action is often
> simply "retry the same step in a moment."

**Findings so far:**

- **`unknown` is terminal by design and should stay that way.** The repo rule in
  `AGENTS.md` / `README.md` is correct: missing output, malformed verdicts, and
  transport/provider failures must stop the loop and must not silently advance state.
- **There is no first-class retry affordance today.** After a transient provider failure
  the operator has to relaunch the CLI, reselect the loop, re-enter iteration limits,
  and navigate back through the menu even when the intended action is "retry the exact
  same step."
- **Some failures are likely transient, not semantic.** Provider overloads (`529`),
  temporary gateway failures, and similar server-side failures are operationally
  different from rejected audits or malformed outputs: the source artifact may be fine,
  and retrying the same resolved runner is often the right next move.
- **Automatic retry would be risky.** Blind retries could hide infrastructure issues,
  create duplicate provider executions, or make state transitions ambiguous. The safe
  product direction is an explicit operator choice after a terminal `unknown`, not an
  automatic loop-internal retry.
- **The harness already has most of the needed ingredients.** `runLoop` knows the step
  kind, version, resolved runner, and pending action at failure time; the missing piece
  is a structured recovery path that surfaces "retry same step" as a deliberate option.

**Fix:**

- Add an interactive-only recovery prompt for terminal `unknown` outcomes caused by
  provider / transport / timeout-style failures.
- The prompt should prefer explicit bounded actions such as:
  `stop`, `retry same step`, `pick different runner`, and possibly `restart from menu`.
- Preserve the `unknown` safety rule: the original failed attempt still terminates the
  current run as `unknown`; retry is an operator-triggered follow-up action, not an
  invisible continuation.
- Keep non-interactive behavior unchanged: CI / scripted runs should still exit on
  terminal `unknown` exactly as today.
- Add regression coverage for at least:
  - transient provider error → interactive retry same step
  - retry with same runner preserves version and artifact path
  - retry with different runner re-prompts only the affected skill
  - non-interactive mode still exits immediately on `unknown`

**Effort:** M.
