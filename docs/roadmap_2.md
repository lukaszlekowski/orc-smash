# Roadmap 2 — Deferred implementation (batches E–G)

> Near-term batches A–D (items **Menu**, **43**, **42**, **39**, **41**, **40**, **33**,
> **35**, **8**, **38**) live in `roadmap_1.md`. Shared context — the verification-status
> history and the **Architecture assumptions and implementation goal** — is also in
> `roadmap_1.md` and applies to these items too.

## Short checklist

Current pending work, grouped into recommended implementation batches.

**Batch E — Runtime liveness (standalone, highest risk)**

- [ ] **36 — Agent CLI connection hanging and follow-up validation gaps**

**Batch F — Escalation stage (standalone feature)**

- [ ] **37 — Escalation stage after repeated rejected audits/reviews**

**Batch G — Docs canonicalization (last)**

- [ ] **14 — docs canonicalization + broken plan reference fix**

## Quick summaries

**Batch E — Runtime liveness (standalone, highest risk)**

- [ ] **36 — Agent CLI connection hanging and follow-up validation gaps.** Address cases where generic agent CLIs (`codex`, `agy`) hang indefinitely in certain execution environments (e.g. `codex` reading from a piped stdin, or `agy` waiting on blocked network/daemon connectivity) without completing. Under the default config where agent watchdog timeouts are disabled (`0`), these hangs block the loop indefinitely without output. Additionally, establish a validation check to ensure that the follow-up step actually writes the required report file before proceeding, preventing the loop from advancing silently without producing the follow-up artifact.

**Batch G — Docs canonicalization (last)**

- [ ] **14 — docs canonicalization + broken plan reference fix.** Make `docs/architecture/overview.md` the canonical architecture source, reduce duplicated architecture prose elsewhere, and fix or remove the broken `docs/dev/plan.md` references after the remaining runtime and rendering changes have landed so the docs only need one final alignment pass.

**Batch F — Escalation stage (standalone feature)**

- [ ] **37 — Escalation stage after repeated rejected audits/reviews.** After `N` consecutive rejected audits or reviews, the loop should enter a dedicated escalation stage that runs an analysis skill over the rejection history and writes an advice artifact answering whether the operator should patch the current source artifact (`plan.md`, implementation, etc.) or continue with another follow-up plus audit attempt. The advice result should appear in the normal timeline/status table with a clear outcome such as `continue` or `patch plan.md`. Open design question: decide whether this stage should be powered by one shared cross-loop escalation skill with loop-aware inputs, or separate skills for the plan loop and review loop.

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
