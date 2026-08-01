---
name: 21-simple-plans-audit
description: "Audits the spec.md and plan.md planning set against the codebase and project workflow. Produces versioned audit outputs: v1 for initial audit, v2 as a follow-up audit after repair, v3 and so on. Use when the planning set needs quality review before implementation begins."
---

## Purpose

Audit the planning set — `docs/dev/spec.md` (the acceptance contract) and
`docs/dev/plan.md` (the delivery design) — as one set, against the codebase,
architecture rules, and canonical workflow. Each invocation produces a new
versioned audit (`vN`): the first run is `v1`, a follow-up audit after repair
is `v2`, and so on.

---

## Quality Standard

Audits must enforce the best-practice, long-term implementation standard. Do
not accept documents that shrink architecture-critical requirements into
"limited MVP" scope, leave important behavior as vague future work, rely on
partial implementation, or describe structural plumbing without proving the
real workflow. If any required fix remains, verdict is **REJECTED**. Only
**APPROVED** and **REJECTED** are valid verdicts.

For architecture-critical, security-critical, data-integrity, paid-access,
startup, sync, or cross-stack work, audit the documents against
production-grade behavior: source of truth, ownership boundaries,
persistence/sync, backend/API enforcement, external-service failure modes, UI
behavior, tests, and manual verification. A planning set is not
implementation-ready if it can pass while the user/developer/backend workflow
remains incomplete.

For every Critical or Major finding, include file-level and code-level
remediation guidance that names the exact path(s), the affected
function/class/route/schema, and the minimal change required to make the
planning set implementation-ready.

---

## Inputs Required (ask if not provided)

- Specification path
- Plan path
- Current audit version to produce (v1, v2, v3…)
- Prior artifact, when supplied (see Prior-Artifact-Aware Behavior below)

---

## Independent-First Assessment

Assess the current specification, current plan, and codebase independently
before consulting any prior artifact. A prior artifact is repair/comparison
evidence, not authority. When the prior artifact is `none`, do not search for
historical audits.

## Prior-Artifact-Aware Behavior

Artifact version does not identify an audit mode. A v2 evaluation can be the
ordinary audit after a v1 repair, while a second opinion is a fresh chain
whose prior artifact is `none`.

- **`Prior artifact: none`** — assess the documents independently and stop.
  Do not look for historical audits or comparisons.
- **Prior artifact is a follow-up (repair) artifact** — first write your own
  independent assessment, then verify each repair claim against the current
  documents and the rejected findings it addresses.
- **Prior artifact is an explicitly supplied comparison artifact** — first
  write your own independent assessment, then record agreements and
  disagreements with it.

Never perform a historical lookup based on the numeric version alone.

---

## Codebase Scan

Analyse:

- Backend source directory — backend code (controllers, models, routes)
- Frontend source directory — frontend code

Identify what the planning set changes, and verify those changes are
consistent with what already exists.

---

## Intentional Architecture Changes

Do not reject solely because the proposed design differs from current code or
descriptive architecture documentation. First decide whether the difference
is intentional. An intentional replacement must state:

1. the current behavior or architecture being replaced;
2. the target architecture and ownership boundaries;
3. the invariants retained;
4. migration and compatibility effects; and
5. the tests and documentation that will be updated.

Reject accidental contradictions, infeasible transitions, missing migration
or verification coverage, and violations of controlling invariants that were
not explicitly reopened. When an architecture document describes the
superseded baseline, updating that document belongs in implementation scope
rather than forcing the planning set back to the old design.

---

## Blocking Threshold and Authority

- Critical and Major findings block approval. Minor findings are advisory.
- A missing acceptance criterion, safety invariant, feasibility requirement,
  migration obligation, or required verification is at least Major; never
  hide a blocker under Minor.
- Every blocking finding cites its authority: a spec requirement, an
  applicable approved research constraint, a controlling project invariant, a
  verified codebase fact, or a missing verification obligation.
- Implementation-local uncertainty may remain for implementation/review when
  the plan defines a reliable way to expose it. Planning approval does not
  require predicting every coding defect.
- Approval requires zero unresolved Critical or Major findings and overall
  confidence of at least `0.95`.

---

## Audit Criteria

| Dimension | What to Check |
| --- | --- |
| **Spec completeness and testability** | Are all acceptance criteria concrete and independently testable? Are constraints and non-goals explicit? |
| **Plan feasibility** | Are all steps implementable? Correct file paths? Dependencies sequenced? |
| **Architectural consistency** | Architectural patterns followed? No layer violations? |
| **Risk coverage** | Breaking changes, migrations, or regressions identified? |
| **Long-term quality** | Does the plan preserve the approved best-practice architecture without cut corners? |
| **Real workflow completeness** | Would the plan prove the claimed user/developer/backend workflows end to end, including failure and recovery paths? |

---

## Mandatory Cross-Document Checks

Every plans audit must include:

### Spec-to-Plan Coverage

| Requirement | Plan Step | Verification | Status |
| ----------- | --------- | ------------ | ------ |
| ...         | ...       | ...          | ✅/❌  |

100% of spec acceptance criteria must map to plan work and to verification
evidence. Any criterion without a plan step or verification evidence is a
blocking finding.

### Research-to-Execution (only when approved research exists)

| Approved Research Constraint | Spec Requirement | Plan Step | Status |
| ---------------------------- | ---------------- | --------- | ------ |
| ...                          | ...              | ...       | ✅/❌  |

100% of applicable approved research constraints must map into the spec and
plan.

### Requirements Not Carried Forward

List spec requirements or research constraints that are not carried forward,
with reason. When there are none, write exactly `None`.

### Testability Check

| Acceptance Criterion | Can Fail For Partial Implementation? | Evidence Needed | Status |
| -------------------- | ------------------------------------ | --------------- | ------ |
| ...                  | ✅/❌                                | ...             | ✅/❌  |

If an acceptance criterion could pass while the feature remains partial,
verdict must be **REJECTED**.

### Real Workflow Verification Matrix

| Claimed Workflow / Capability | Plan Tasks | Verification Strong Enough To Catch Partial Implementation? | Status |
| ----------------------------- | ---------- | ----------------------------------------------------------- | ------ |
| ...                           | ...        | ✅/❌                                                       | ✅/❌  |

If any claimed workflow can be implemented as fields, routes, providers, or
UI states while the real workflow remains unusable, insecure, or unverified,
verdict must be **REJECTED**.

---

## Output Format

```markdown
# Plans Audit — [Feature Name] — v[N]

> **Document metadata (loop, skill, kind, role, version, agent, model, target, priorAudit, timestamp) is written as YAML front matter by the orc-smash harness. Do not write `Date:`/`Auditor:`/metadata headers yourself.**

## Verdict

APPROVED / REJECTED

## Confidence Score

Overall: 0.XX

## Findings

Under each Critical, Major and Minor finding, add a short "Remediation" line with exact file paths and concrete change instructions. Every blocking finding must cite its concrete authority.

### Critical (must fix before approval)

- ...

### Major (should fix)

- ...

### Minor (suggestions)

- ...

## Spec-to-Plan Coverage

| Requirement | Plan Step | Verification | Status |
| ----------- | --------- | ------------ | ------ |
| ...         | ...       | ...          | ✅/❌  |

## Research-to-Execution

| Approved Research Constraint | Spec Requirement | Plan Step | Status |
| ---------------------------- | ---------------- | --------- | ------ |
| ...                          | ...              | ...       | ✅/❌  |

(Include only when approved research exists.)

## Requirements Not Carried Forward

None

## Testability Check

| Acceptance Criterion | Can Fail For Partial Implementation? | Evidence Needed | Status |
| -------------------- | ------------------------------------ | --------------- | ------ |
| ...                  | ✅/❌                                | ...             | ✅/❌  |

## Real Workflow Verification Matrix

| Claimed Workflow / Capability | Plan Tasks | Verification Strong Enough To Catch Partial Implementation? | Status |
| ----------------------------- | ---------- | ----------------------------------------------------------- | ------ |
| ...                           | ...        | ✅/❌                                                       | ✅/❌  |

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

- If any blocker, unresolved condition, architectural shortcut, or quality gap
  remains, verdict must be **REJECTED**.
- If any architecture-critical workflow lacks verification strong enough to
  catch structural-only implementation, verdict must be **REJECTED**.
- If overall confidence < 0.95, list the specific areas of uncertainty.
  Verdict must be **REJECTED**.
- Use **APPROVED** only when the documents are implementation-ready without
  conditions.
- State confidence per finding where relevant.
- The exact `Write your output to` value in Inputs is authoritative. Write
  the audit there; do not derive or substitute a filename.
- Do not modify `docs/dev/spec.md`, `docs/dev/plan.md`, or any source code.
