---
name: 42-simple-review-follow-up
description: Patches an existing implementation after a rejected implementation review. Use after 40-simple-review returns REJECTED and the next step is a constrained repair pass, not a fresh implementation.
---

## Purpose

Repair an existing implementation after a rejected `40-simple-review`, while preserving the approved plan and useful implementation work already present.

This skill is the loop between `40-simple-review` and another `40-simple-review` run. It does not approve the implementation.

---

## Quality Standard

This is an execution skill: when the required inputs are available, patch the implementation rather than only proposing changes.

Every rejected review finding must be fixed directly or explicitly escalated as blocked. Do not weaken approved requirements, defer blockers, invent a new architecture, or make surface-level fixes that leave the real workflow incomplete.

For architecture-critical, security-critical, data-integrity, paid-access, startup, sync, or cross-stack work, the repaired implementation must prove end-to-end behavior across source of truth, persistence/sync, backend/API enforcement, UI behavior, failure states, tests, and manual verification.

Apply a best-practice, long-term architecture standard. Reject and fix code that relies on "MVP-only" shortcuts, conditional approval, vague future hardening, partial plumbing, or a structurally present capability without the real workflow. If a review finding exposes non-production-grade design, patch toward the maintainable source-of-truth, ownership, layering, and verification model approved by the plan. Do not trade correctness for a smaller patch.

Passing tests is necessary but not sufficient. The real workflow identified by the rejected review must work, and the repair must preserve the approved ownership boundaries rather than hiding the symptom.

---

## Before Proceeding

Read:

- The latest rejected implementation review in `docs/dev`, unless the user provides a specific review path
- Current plan
- Relevant code in the project's frontend source, test, and backend directories

---

## Inputs Required

- Rejected implementation review path
- Existing plan path

If any input is missing and cannot be inferred, ask one concise question.

If multiple rejected reviews exist and the user did not provide a path, use the most recent versioned rejected review (`vN` with the highest N, or latest timestamp if versions are ambiguous). If the latest implementation review is `APPROVED`, stop and report that no review follow-up is needed.

---

## Repair Rules

- Patch the existing implementation in place.
- Preserve good existing implementation work.
- Fix every Critical, Major, and relevant Minor finding from the rejected review.
- Preserve the approved plan architecture exactly unless the user explicitly reopens planning.
- Re-check each patch against approved plan and the rejected review. Do not make a local symptom fix that leaves the underlying workflow, testability, or architecture gap intact.
- Do not start a fresh implementation or rewrite broad areas unrelated to the rejected review findings.
- Do not silently mark a blocker as deferred.
- Do not use "for MVP", "later hardening", "conditional approval", or similar framing to bypass a required fix unless approved docs explicitly define that phase boundary and the user approves the deferral.
- Update plan status or closeout notes only when they are stale, wrong, or required by the rejected review. If review is rejected, do not leave docs claiming final approval/completion.
- If a review finding conflicts with approved plan, stop and report the conflict instead of guessing.

---

## Verification Rules

Run the verification required by the rejected review and the approved plan.

For cross-stack features, default to:

- Project-appropriate lint/analyze command
- Project-appropriate test command
- Backend test command, if applicable
- Any manual workflow check named by the rejected review

If a command cannot be run, report why and mark the repair blocked unless the user explicitly accepts that limitation.

Do not mark the repair complete when:

- any required verification command fails,
- a manual workflow from the rejected review still fails,
- only synthetic/unit tests pass but the real workflow remains unverified,
- or the fix weakens ownership, layering, source of truth, typed models, or centralized resolution.

---

## Required Output Shape

Write your follow-up report to the exact `Write your output to` value in Inputs (the follow-up output path), not the audit path or a derived filename.

Do not write a `## Verdict` section — follow-ups do not produce verdicts.

Always include this section to indicate outcome:
```markdown
## Follow-up Outcome

patched
```
(use `blocked` instead of `patched` only when a finding cannot be fixed and is escalated as blocked).

After patching, report:

- files patched
- review findings fixed
- verification commands run and results
- manual workflow evidence, when required
- anything intentionally not fixed, with reason
- next step: rerun `40-simple-review`

If blocked, report:

- the exact finding that cannot be fixed
- what decision, source document, environment, or dependency must change
- whether planning must be reopened

---

## Verification Before Finishing

Before finishing:

- Re-read the rejected review and confirm every finding is addressed or explicitly blocked.
- Re-read the patched code paths and tests.
- Re-run required verification.
- Check plan status fields do not falsely claim final approval when review remains rejected.
- Check timeline has exactly one row for this follow-up run.
- Do not claim approval; only a subsequent `40-simple-review` can approve the implementation.
