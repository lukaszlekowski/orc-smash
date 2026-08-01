---
name: 40-simple-review
description: "Reviews a completed implementation against its spec.md acceptance outcomes and plan.md delivery design. Produces versioned review outputs: v1 for initial review, v2 as a follow-up review after repair, v3 and so on. Use after implementation is complete."
---

## Purpose

Review a completed implementation against the acceptance contract first and
the delivery design second: `docs/dev/spec.md` defines the required outcomes,
`docs/dev/plan.md` defines the architecture, steps, and verification the
implementation must satisfy. Each invocation produces a versioned review
(`vN`): the first run is `v1`, a follow-up review after repair is `v2`, and
so on.

---

## Quality Standard

Reviews must enforce the approved best-practice, long-term architecture. Do
not approve implementations that are merely directionally correct, partially
wired, or limited by "MVP" reasoning when the spec requires a complete
capability. If any required fix remains, verdict is **REJECTED**. Only
**APPROVED** and **REJECTED** are valid verdicts.

For every **Major** or **Critical** finding, the review must do all of the
following:

- name the exact unmet acceptance criterion from the spec,
- name the exact missed plan step, stop gate, or verification obligation,
- explain why the current implementation is only partial / insufficient
  rather than complete,
- state the best-practice fix direction for long-term maintainability,
- and explicitly say when the fix must be implemented through the approved
  plan architecture rather than as a local workaround.

Do not leave architecture-critical findings phrased as vague "fix this"
comments. The review must tell the implementer what level of ownership,
layering, and source-of-truth model the fix must preserve.

For every Critical or Major finding, include file-level and code-level
remediation guidance that names the exact path(s), the affected
function/class/route/schema, and the minimal change required to make the
implementation compliant with the approved plan.
For every Minor finding, include a short remediation note with exact file
paths and concrete change instructions when a concrete change is appropriate.

---

## Inputs Required (ask if not provided)

- Specification path
- Plan document path
- Current review version to produce (v1, v2, v3…)
- Prior artifact, when supplied (see Prior-Artifact-Aware Behavior below)

---

## Independent-First Assessment

Assess the current worktree, the spec's required outcomes, the plan's
architecture and steps, and the codebase independently before consulting any
prior artifact. A prior artifact is repair/comparison evidence, not authority.
When the prior artifact is `none`, do not search for historical reviews.

## Prior-Artifact-Aware Behavior

Artifact version does not identify a review mode. A v2 review can be the
ordinary follow-up after a v1 repair, while a second opinion is a fresh chain
whose prior artifact is `none`.

- **`Prior artifact: none`** — assess independently and stop. Do not look for
  historical reviews or comparisons.
- **Prior artifact is a follow-up (repair) artifact** — first write your own
  independent assessment, then verify each repair claim against the current
  worktree and the rejected findings it addresses.
- **Prior artifact is an explicitly supplied comparison artifact** — first
  write your own independent assessment, then record agreements and
  disagreements with it.

Never perform a historical lookup based on the numeric version alone.

---

## Diff Analysis

Run the following and analyse the output:

- `git diff --staged`
- `git diff HEAD`
- Scan for: bugs, security issues, style violations, missed edge cases,
  unintended changes

Map every spec acceptance criterion and every plan step to the code that was
written to fulfil it.

The implementation must satisfy the original long-term intent, not only the
latest wording.

---

## Review Criteria

| Dimension | What to Check |
| --- | --- |
| **Acceptance coverage** | Every spec acceptance criterion maps to implementation evidence? |
| **Plan adherence** | Was every plan step executed? Any steps silently skipped? |
| **Diff analysis** | Does `git diff --staged` show any bugs, regressions, or unintended changes? |
| **Architectural compliance** | Architectural patterns correct? No layer violations? |
| **Code quality** | Edge cases handled? Error paths covered? |
| **Regressions** | Any existing functionality broken? |
| **Verification** | Do all plan verification commands pass? |
| **Deviations** | Any divergence from the spec/plan set — even intentional ones — documented? |
| **Long-term quality** | Does the implementation actually deliver the approved architecture, not just scaffolding or a reduced feature? |
| **Alignment evidence** | For each major gap, does the review cite the exact spec / plan element that is not properly implemented? |
| **Maintainability** | Does the implementation preserve clear ownership, typed models, centralized resolution, and extensibility rather than adding local workaround logic? |

---

## Partial Implementation Detector

Explicitly check whether any claimed capability is only:

- represented by a type or field but unused in production config,
- exposed only as an internal API without a usable workflow,
- covered only by synthetic tests but not by real app behavior,
- implemented globally when scope-specific behavior was required,
- documented as complete while review or verification evidence says otherwise.

If any architecture-critical capability is only partially implemented, verdict
must be **REJECTED**.

When this happens, say so plainly. Use direct language such as:

- "This is partially implemented and therefore not acceptable under the
  project standard."
- "Structural plumbing exists, but the real workflow is still broken."
- "This must be fixed through the approved architecture, not via a local
  patch."

---

## Intentional Architecture Changes

Reject unapproved architectural deviations from the spec/plan set. If the
implementation intentionally replaced an approved design, it must have done so
through the approved plan's change process; an improvised replacement is a
blocking finding. When an architecture document describes the superseded
baseline, updating that document belongs to implementation follow-up rather
than forcing the worktree back to the old design.

---

## Blocking Threshold and Authority

- Critical and Major findings block approval. Minor findings are advisory.
- Every blocking finding cites its authority: a spec acceptance criterion, an
  applicable approved research constraint, a controlling project invariant, a
  verified codebase fact, or a missing verification obligation.
- Approval requires zero unresolved Critical or Major findings and overall
  confidence of at least `0.95`.

---

## Major / Critical Finding Structure

Every **Major** or **Critical** finding must include these elements in the
written review:

1. **Alignment block**
   - Spec acceptance criterion / plan step / stop gate / verification
     requirement not met

2. **Why this is not sufficient**
   - Explain the gap between the claimed capability and the real behavior
   - Distinguish structural support from production-readiness / workflow
     completeness
   - Call out when a solution would only be a narrow UI patch, synthetic test
     pass, or other short-term workaround

3. **Best-practice fix direction**
   - State the preferred long-term implementation shape
   - Specify the correct ownership layer, source of truth, and architectural
     boundary
   - Explicitly warn against local workaround patterns when relevant, for
     example:
     - widget-local state instead of provider-owned state
     - string-keyed maps instead of typed models
     - inspector-only merge logic instead of provider / resolver logic
     - duplicated derivation logic instead of centralized resolution

4. **Review instruction to implementer**
   - When applicable, explicitly direct the implementer to follow the
     approved spec/plan architecture rather than improvising a local fix

5. **Remediation**
   - Name the exact file path(s)
   - Name the affected function/class/route/schema
   - State the minimal code change required to resolve the finding without
     weakening the approved architecture

---

## Output Format

```markdown
# Implementation Review — [Feature Name] — v[N]

> **Document metadata (loop, skill, kind, role, version, agent, model, target, priorAudit, timestamp) is written as YAML front matter by the orc-smash harness. Do not write `Date:`/`Auditor:`/metadata headers yourself.**

## Verdict

APPROVED / REJECTED

## Confidence Score

Overall: 0.XX

## Spec Outcome Coverage

| Acceptance Criterion | Implementation Evidence | Status |
| -------------------- | ----------------------- | ------ |
| ...                  | ...                     | ✅/❌  |

## Plan Step Coverage

| Step | Status   | Notes |
| ---- | -------- | ----- |
| ...  | ✅/⚠️/❌ | ...   |

## Diff Findings

| Finding | Severity        | File | Fix |
| ------- | --------------- | ---- | --- |
| ...     | High/Medium/Low | ...  | ... |

## Findings

Under each Critical, Major and Minor finding, add a short "Remediation" line with exact file paths and concrete change instructions. Every blocking finding must cite its concrete authority.

### Critical

- For each item, include: Alignment block; Why this is not sufficient; Best-practice fix direction; and, when applicable, an explicit instruction to implement through the approved spec/plan architecture.

### Major

- For each item, include: Alignment block; Why this is not sufficient; Best-practice fix direction; and, when applicable, an explicit instruction to implement through the approved spec/plan architecture.

### Minor

- ...

## Comparison with Prior Artifact

- Agreements: ...
- Disagreements: ...
- New findings: ...

(Include only when a prior artifact was supplied.)

## Recommended Actions

- ...
```

---

## Approval Rule

- If any blocker, unresolved condition, architectural shortcut, missing
  verification, or quality gap remains, verdict must be **REJECTED**.
- If overall confidence < 0.95, list the specific areas of uncertainty.
  Verdict must be **REJECTED**.
- Use **APPROVED** only when the implementation satisfies the spec outcomes
  and the approved plan without conditions.
- Reviews must reject fixes that merely make the tests pass while weakening
  ownership, layering, or extensibility.
- For any rejected Major/Critical issue, the review must state the
  best-practice long-term recommendation, not just the local symptom to
  change.
- The exact `Write your output to` value in Inputs is authoritative. Write
  the review there; do not derive or substitute a filename.
- Do not modify `docs/dev/spec.md`, `docs/dev/plan.md`, or any source code.

---
