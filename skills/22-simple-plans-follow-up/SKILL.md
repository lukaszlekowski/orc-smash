---
name: 22-simple-plans-follow-up
description: Patches existing plan document after a rejected plans audit. Use after 21-simple-plans-audit returns REJECTED and the next step is a constrained planning repair pass, not a fresh plan or implementation.
---

## Purpose

Repair an existing plan set after a rejected plans audit, while preserving the approved research architecture and the useful parts of the current planning documents.

This skill is the loop between `21-simple-plans-audit` and another `21-simple-plans-audit` run. It does not approve documents and does not begin implementation.

---

## Quality Standard

This is an execution skill: when the required inputs are available, patch the documents rather than only proposing changes.

Every rejected audit finding must be fixed directly or explicitly escalated as blocked. Do not weaken approved research, defer blockers, invent a new architecture, or make surface-level wording edits that leave the real workflow incomplete.

For architecture-critical, security-critical, data-integrity, paid-access, startup, sync, or cross-stack work, the patched docs must still prove end-to-end behavior across source of truth, persistence/sync, backend/API enforcement, UI behavior, failure states, tests, and manual verification.

Apply a best-practice, long-term architecture standard. Reject and fix language that relies on "MVP-only" shortcuts, conditional approval, vague future hardening, partial plumbing, or a structurally present capability without the real workflow. If an audit finding exposes non-production-grade design, patch toward the maintainable source-of-truth, ownership, layering, and verification model approved by research. Do not trade correctness for a smaller patch.

---

## Before Proceeding

Read:

- The latest rejected plans audit in `docs/dev/`, unless the user provides a specific audit path. If you didn't run ls or grep this section to locate the content of `docs/dev/`, do so now to update your memory with the latest audit findings.
- Current plan

---

## Inputs Required

- Rejected plans audit path
- Existing plan path

If any input is missing and cannot be inferred, ask one concise question.

If multiple rejected audits exist and the user did not provide a path, use the most recent versioned rejected audit (`vN` with the highest N, or latest timestamp if versions are ambiguous). If the latest plans audit is `APPROVED`, stop and report that no plans follow-up is needed.

---

## Repair Rules

- Patch existing plan file in place.
- Preserve good existing content.
- Fix every Critical, Major, and relevant Minor finding from the rejected audit.
- Do not create a new plan set unless the audit says the documents are unrecoverable or the user asks.
- Do not silently mark a blocker as deferred.
- Do not use "for MVP", "later hardening", "conditional approval", or similar framing to bypass a required fix unless approved research explicitly defines that phase boundary.
- Do not proceed to implementation.

---

## Required Output Shape

Write your follow-up report to the exact `Write your output to` value in Inputs (the follow-up output path), not the audit path or a derived filename.

Do not write a `## Verdict` section — follow-ups do not produce verdicts.

Always include this machine-readable section to indicate outcome:
```markdown
## Outcome

COMPLETED
```
(use `BLOCKED` instead of `COMPLETED` only when a finding cannot be fixed and is escalated as blocked; include a concise reason below the token).

After patching, report:

- files patched
- audit findings fixed
- anything intentionally not fixed, with reason
- next step: rerun `21-simple-plans-audit`

If blocked, report:

- the exact finding that cannot be fixed
- what decision or source document must change
- whether research must be reopened

---

## Verification

Before finishing:

- Re-read the rejected audit and confirm every finding is addressed.
- Re-read the patched sections in plan.
- Do not claim approval; only a subsequent `21-simple-plans-audit` can approve the documents.
