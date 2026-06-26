---
name: 30-simple-implement
description: Implements an approved feature from its plan document following the RPI pipeline. Use only when both plan has an approved audit (v1 or higher with APPROVED verdict).
---

## Purpose

Implement a feature from its approved plan.

---

## Quality Standard

Implementation must deliver the approved long-term architecture, not a thinner MVP substitute. Do not intentionally leave architecture-critical behavior partial, hidden behind TODOs, or represented only by scaffolding. If the plan is incomplete or would require cutting corners to finish, stop and report the gap instead of implementing a reduced feature.

---

## Before Proceeding

Locate and confirm:

- The **plan** document
- The **approved plans audit** (v1+, verdict = APPROVED)

If no approved plans audit exists: `⛔ No approved plans audit found. Implementation cannot begin.`

---

## Inputs Required (ask if not provided)

- Plan path

---

## Pre-Implementation Check

Before writing any code, state:

```
Plan located:        ✅ / ❌ [path]
Plan status:         [ready / implementing / other]
Approved audit:      ✅ / ❌ [path]
Confidence score:    0.XX
```

If confidence < 0.95, stop and list the specific blockers before writing code.

---

## Implementation Rules

- Follow every step in the plan document in sequence
- Do not reduce scope to "MVP only" or leave architecture-critical behavior partially implemented unless the approved plan explicitly phases it with verification and the user approves the deferral
- Run verification commands after each plan step as defined in the plan
- If a step cannot be completed as written, stop and report — do not silently skip or substitute
- Maintain a running implementation evidence ledger while working
- For every plan step, record the files changed, tests added/updated, verification command, result, and any deviation

---

## Implementation Evidence Ledger

Before declaring implementation complete, produce this table:

| Plan Step | Files Changed | Tests / Verification | Result | Deviation         |
| --------- | ------------- | -------------------- | ------ | ----------------- |
| ...       | ...           | ...                  | ✅/❌  | none / documented |

Also produce a requirement coverage table:

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

1. Update plan status (`done` / `blocked`) and phase checklists
2. Record all plan deviations in the plan change log

Do not declare completion until all five steps are done.
