---
name: 40-simple-review
description: "Reviews a completed implementation against its plan document. Produces versioned review outputs: v1 for initial review, v2 as second opinion reviewing v1, v3 reviewing v2, etc. Use after implementation is complete."
---

## Purpose

Review a completed implementation against its plan and spec, scanning for deviations, regressions, architectural violations, and quality issues. Each invocation produces a versioned review (`vN`), supporting multiple independent reviewer passes.

---

## Quality Standard

Reviews must enforce the approved best-practice, long-term architecture. Do not approve implementations that are merely directionally correct, partially wired, or limited by "MVP" reasoning when the plan requires a complete capability. If any required fix remains, verdict is **REJECTED**. Only **APPROVED** and **REJECTED** are valid verdicts.

For every **Major** or **Critical** finding, the review must do all of the following:

- name the exact unmet requirement from the spec,
- name the exact missed plan step, stop gate, or verification obligation,
- explain why the current implementation is only partial / insufficient rather than complete,
- state the best-practice fix direction for long-term maintainability,
- and explicitly say when the fix must be implemented through the approved plan architecture rather than as a local workaround.

Do not leave architecture-critical findings phrased as vague "fix this" comments. The review must tell the implementer what level of ownership, layering, and source-of-truth model the fix must preserve.

For every Critical or Major finding, include file-level and code-level remediation guidance that names the exact path(s), the affected function/class/route/schema, and the minimal change required to make the implementation compliant with the approved plan.
For every Minor finding, include a short remediation note with exact file paths and concrete change instructions when a concrete change is appropriate.

---

## Inputs Required (ask if not provided)

- Plan document path
- Feature-specific checklist path if one exists
- Current review version to produce (v1, v2, v3…)
- If v2+: path to the prior review document

---

## Diff Analysis

Run the following and analyse the output:

- `git diff --staged`
- `git diff HEAD`
- Scan for: bugs, security issues, style violations, missed edge cases, unintended changes

Map every plan step to the code that was written to fulfil it.

The implementation must satisfy the original long-term intent, not only the latest plan wording.

---

## Review Criteria

| Dimension                    | What to Check                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plan adherence**           | Was every plan step executed? Any steps silently skipped?                                                                                            |
| **Diff analysis**            | Does `git diff --staged` show any bugs, regressions, or unintended changes?                                                                          |
| **Architectural compliance** | Architectural patterns correct? No layer violations?                                                                                                 |
| **Code quality**             | Edge cases handled? Error paths covered?                                                                                                             |
| **Regressions**              | Any existing functionality broken?                                                                                                                   |
| **Verification**             | Do all plan verification commands pass?                                                                                                              |
| **Deviations**               | Any divergence from plan — even intentional ones — documented?                                                                                       |
| **Long-term quality**        | Does the implementation actually deliver the approved architecture, not just scaffolding or a reduced feature?                                       |
| **Alignment evidence**       | For each major gap, does the review cite the exact plan / spec / checklist element that is not properly implemented?                                 |
| **Maintainability**          | Does the implementation preserve clear ownership, typed models, centralized resolution, and extensibility rather than adding local workaround logic? |

---

## Partial Implementation Detector

Explicitly check whether any claimed capability is only:

- represented by a type or field but unused in production config,
- exposed only as an internal API without a usable workflow,
- covered only by synthetic tests but not by real app behavior,
- implemented globally when scope-specific behavior was required,
- documented as complete while review or verification evidence says otherwise.

If any architecture-critical capability is only partially implemented, verdict must be **REJECTED**.

When this happens, say so plainly. Use direct language such as:

- "This is partially implemented and therefore not acceptable under the project standard."
- "Structural plumbing exists, but the real workflow is still broken."
- "This must be fixed through the approved architecture, not via a local patch."

## Major / Critical Finding Structure

Every **Major** or **Critical** finding must include these elements in the written review:

1. **Alignment block**
   - Plan step / stop gate / verification requirement not met

2. **Why this is not sufficient**
   - Explain the gap between the claimed capability and the real behavior
   - Distinguish structural support from production-readiness / workflow completeness
   - Call out when a solution would only be a narrow UI patch, synthetic test pass, or other short-term workaround

3. **Best-practice fix direction**
   - State the preferred long-term implementation shape
   - Specify the correct ownership layer, source of truth, and architectural boundary
   - Explicitly warn against local workaround patterns when relevant, for example:
     - widget-local state instead of provider-owned state
     - string-keyed maps instead of typed models
     - inspector-only merge logic instead of provider / resolver logic
     - duplicated derivation logic instead of centralized resolution

4. **Review instruction to implementer**
   - When applicable, explicitly direct the implementer to follow the approved plan/checklist architecture rather than improvising a local fix

5. **Remediation**
   - Name the exact file path(s)
   - Name the affected function/class/route/schema
   - State the minimal code change required to resolve the finding without weakening the approved architecture

---

## Versioned Second Opinion Rule (v2+)

If producing v2 or higher:

1. **Write your complete verdict section first** — do not read the prior review until your own findings, verdict, and confidence score are written.
2. Once your verdict section is complete, read the prior review.
3. Note agreements, disagreements, and any findings the prior reviewer missed.
4. Your final verdict must be your own.

The output template enforces this sequence: verdict appears before the comparison section.

---

## Output Format

```markdown
# Implementation Review — [Feature Name] — v[N]

> **Document metadata (loop, skill, kind, role, version, agent, model, target, priorAudit, timestamp) is written as YAML front matter by the orc-smash harness. Do not write `Date:`/`Auditor:`/metadata headers yourself.**

## Verdict

APPROVED / REJECTED

## Confidence Score

Overall: 0.XX

## Plan Step Coverage

| Step | Status   | Notes |
| ---- | -------- | ----- |
| ...  | ✅/⚠️/❌ | ...   |

## Diff Findings

| Finding | Severity        | File | Fix |
| ------- | --------------- | ---- | --- |
| ...     | High/Medium/Low | ...  | ... |

## Closeout Validation

- Plan status and phase checklists reflect actual implementation state: ✅ / ❌
- If any closeout update is missing, report it as a finding above.

## Findings

Under each Critical, Major and Minor finding, add a short "Remediation" line with exact file paths and concrete change instructions.

### Critical

- For each item, include: Alignment block; Why this is not sufficient; Best-practice fix direction; and, when applicable, an explicit instruction to implement through the approved plan/checklist architecture.

### Major

- For each item, include: Alignment block; Why this is not sufficient; Best-practice fix direction; and, when applicable, an explicit instruction to implement through the approved plan/checklist architecture.

### Minor

- ...

## Comparison with Prior Review (v2+ only)

- Agreements: ...
- Disagreements: ...
- New findings: ...

## Recommended Actions

- ...
```

---

## Approval Rule

- If any blocker, unresolved condition, architectural shortcut, missing verification, or quality gap remains, verdict must be **REJECTED**.
- If overall confidence < 0.95, list the specific areas of uncertainty. Verdict must be **REJECTED**.
- Use **APPROVED** only when the implementation satisfies the plan without conditions.
- Reviews must reject fixes that merely make the tests pass while weakening ownership, layering, or extensibility.
- For any rejected Major/Critical issue, the review must state the best-practice long-term recommendation, not just the local symptom to change.
- The exact `Write your output to` value in Inputs is authoritative. Write the review there; do not derive or substitute a filename.

---
