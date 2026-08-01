---
name: 30-simple-implement
description: Implements an approved feature from its spec and approved plan. Use only when both the plan and spec have an approved joint plan audit (v1 or higher with APPROVED verdict).
---

## Purpose

Implement a feature from its approved planning set: the spec (`docs/dev/spec.md`) is the acceptance contract, the plan (`docs/dev/plan.md`) is the delivery design.

---

## Quality Standard

Implementation must deliver the approved long-term architecture, not a thinner MVP substitute. Do not intentionally leave architecture-critical behavior partial, hidden behind TODOs, or represented only by scaffolding. If the planning set is incomplete or would require cutting corners to finish, stop and report the gap instead of implementing a reduced feature.

---

## Before Proceeding

Locate and confirm:

- The **specification** document
- The **plan** document
- The **approved joint plan audit** (v1+, verdict = APPROVED, for the current spec/plan bytes)

If no approved joint plan audit exists: `⛔ No approved plans audit found. Implementation cannot begin.`

A legacy plan-only approval is not approval of the spec/plan pair. A missing or unapproved specification blocks implementation.

---

## Inputs Required (ask if not provided)

- Specification path
- Plan path

---

## Pre-Implementation Check

Before writing any code, state:

```
Plan located:        ✅ / ❌ [path]
Plan status:         [ready / implementing / other]
Spec located:        ✅ / ❌ [path]
Approved audit:      ✅ / ❌ [path]
Confidence score:    0.XX
```

If confidence < 0.95, stop and list the specific blockers before writing code.

---

## Implementation Rules

- Follow every step in the plan document in sequence; the plan is the delivery design. The spec's acceptance criteria are the contract — every spec acceptance criterion must appear in the implementation requirement-coverage table.
- Do not reduce scope to "MVP only" or leave architecture-critical behavior partially implemented unless the approved plan explicitly phases it with verification and the user approves the deferral.
- If a material spec/plan conflict appears, or a necessary architecture change outside the approved set, stop and produce blocked evidence — do not improvise an unapproved implementation.
- Run verification commands after each plan step as defined in the plan.
- If a step cannot be completed as written, stop and report — do not silently skip or substitute.
- Maintain a running implementation evidence ledger while working.
- For every plan step, record the files changed, tests added/updated, verification command, result, and any deviation.

## Phase-Boundary Rule

When the approved plan explicitly requires a fresh approval between independently verifiable slices:

1. Finish the first subprocess with a structurally valid blocked implementation ledger whose exact remaining blocker is recorded.
2. Release run ownership — never keep the target owned across the boundary.
3. Require a later implementation invocation that starts only from a new accepted plan edge.
4. Never invoke the harness recursively, and never claim completion for the unfinished slices.

## Verification Ownership

Run every feasible local and automated verification yourself. Operator-only verification is exceptional: it is allowed only when you identify the unavailable capability, the exact steps and expected result, the substitute evidence produced, and whether the missing result blocks approval or completion. A mandatory check that cannot be performed or substituted keeps the result blocked.

---

## Implementation Evidence Ledger

Write the complete implementation evidence ledger to the exact `Write your output to` value in Inputs. This is the authoritative required durable implementation artifact; do not derive another filename or return the ledger only in chat/stdout.

Before declaring implementation complete, produce this table:

| Plan Step | Files Changed | Tests / Verification | Result | Deviation         |
| --------- | ------------- | -------------------- | ------ | ----------------- |
| ...       | ...           | ...                  | ✅/❌  | none / documented |

Also produce a requirement coverage table (one row per spec acceptance criterion, plus any checklist items):

| Spec Requirement / Checklist Item | Implemented In | Verified By         | Status |
| --------------------------------- | -------------- | ------------------- | ------ |
| ...                               | file/path      | test/manual command | ✅/❌  |

If any row is incomplete, do not mark the implementation complete.

---

## Post-Implementation

After all steps are complete:

1. Run all verification commands listed in the plan
2. Summarise what was implemented, file by file
3. Flag any deviations from the plan (even minor ones)
4. State overall confidence that the implementation matches the spec: `0.XX`
5. If confidence < 0.95, mark the implementation blocked and list the specific unresolved blockers

---

## Closeout Checklist

The harness owns plan closeout after it validates the implementation ledger.
Do not edit `docs/dev/plan.md` directly for closeout.

1. Ensure the implementation evidence ledger is complete and accurate
2. Record all deviations in the ledger so the harness can carry them into the plan change log
3. Do not update plan status (`done` / `blocked`) yourself
4. Do not edit the plan change log yourself unless the user explicitly asked for a manual plan repair outside the normal harness flow

Do not declare completion until all five steps are done.
