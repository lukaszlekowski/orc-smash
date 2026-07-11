---
name: 21-simple-plans-audit
description: "Audits plan document against the codebase and project workflow. Produces versioned audit outputs: v1 for initial audit, v2 as second opinion reviewing v1, v3 reviewing v2, etc. Use when plan documents need quality review before implementation begins."
---

## Purpose

Audit plan document against the codebase, architecture rules, and canonical workflow. Each invocation produces a new versioned audit (`vN`) — the first run is `v1`, a second opinion run is `v2` (reads `v1` after forming its own verdict), and so on.

---

## Quality Standard

Audits must enforce the best-practice, long-term implementation standard from the approved research. Do not accept docs that shrink architecture-critical requirements into "limited MVP" scope, leave important behavior as vague future work, rely on partial implementation, or describe structural plumbing without proving the real workflow. If any required fix remains, verdict is **REJECTED**. Only **APPROVED** and **REJECTED** are valid verdicts.

For architecture-critical, security-critical, data-integrity, paid-access, startup, sync, or cross-stack work, audit the docs against production-grade behavior: source of truth, ownership boundaries, persistence/sync, backend/API enforcement, external-service failure modes, UI behavior, tests, and manual verification. A plan is not implementation-ready if it can pass while the user/developer/backend workflow remains incomplete.

For every Critical or Major finding, include file-level and code-level remediation guidance that names the exact path(s), the affected function/class/route/schema, and the minimal change required to make the plan implementation-ready.

---

## Inputs Required (ask if not provided)

- Plan path
- Current audit version to produce (v1, v2, v3…)
- If v2+: path to the prior audit document

---

## Codebase Scan

Analyse:

- Backend source directory — backend code (controllers, models, routes)
- Frontend source directory — frontend code

Identify what the plan changes, and verify those changes are consistent with what already exists.

---

## Audit Criteria

| Dimension                      | What to Check                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| **Plan feasibility**           | Are all steps implementable? Correct file paths? Dependencies sequenced?                                            |
| **Architectural consistency**  | Architectural patterns followed? No layer violations?                                                               |
| **Risk coverage**              | Breaking changes, migrations, or regressions identified?                                                            |
| **Long-term quality**          | Does the plan preserve the approved best-practice architecture without cut corners?                                 |
| **Real workflow completeness** | Would the plan prove the claimed user/developer/backend workflows end to end, including failure and recovery paths? |

---

## Mandatory Cross-Document Checks

Every plans audit must include:

### Testability Check

| Acceptance Criterion | Can Fail For Partial Implementation? | Evidence Needed | Status |
| -------------------- | ------------------------------------ | --------------- | ------ |
| ...                  | ✅/❌                                | ...             | ✅/❌  |

If an acceptance criterion could pass while the feature remains partial, verdict must be **REJECTED**.

### Real Workflow Verification Matrix

| Claimed Workflow / Capability | Plan Tasks | Verification Strong Enough To Catch Partial Implementation? | Status |
| ----------------------------- | ---------- | ----------------------------------------------------------- | ------ |
| ...                           | ...        | ✅/❌                                                       | ✅/❌  |

If any claimed workflow can be implemented as fields, routes, providers, or UI states while the real workflow remains unusable, insecure, or unverified, verdict must be **REJECTED**.

---

## Versioned Second Opinion Rule (v2+)

If producing v2 or higher:

1. **Write your complete verdict section first** — do not read the prior audit until your own findings, verdict, and confidence score are written.
2. Once your verdict section is complete, read the prior audit.
3. Note agreements, disagreements, and any findings the prior audit missed.
4. Your final verdict must be your own.

The output template enforces this sequence: verdict appears before the comparison section.

---

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

Under each Critical, Major and Minor finding, add a short "Remediation" line with exact file paths and concrete change instructions.

### Critical (must fix before approval)

- ...

### Major (should fix)

- ...

### Minor (suggestions)

- ...

## Testability Check

| Acceptance Criterion | Can Fail For Partial Implementation? | Evidence Needed | Status |
| -------------------- | ------------------------------------ | --------------- | ------ |
| ...                  | ✅/❌                                | ...             | ✅/❌  |

## Comparison with Prior Audit (v2+ only)

- Agreements: ...
- Disagreements: ...
- New findings: ...

## Recommended Actions

- ...
```

---

## Approval Rule

- If any blocker, unresolved condition, architectural shortcut, or quality gap remains, verdict must be **REJECTED**.
- If any architecture-critical workflow lacks verification strong enough to catch structural-only implementation, verdict must be **REJECTED**.
- If overall confidence < 0.95, list the specific areas of uncertainty. Verdict must be **REJECTED**.
- Use **APPROVED** only when the documents are implementation-ready without conditions.
- State confidence per finding where relevant
- The exact `Write your output to` value in Inputs is authoritative. Write the audit there; do not derive or substitute a filename.
