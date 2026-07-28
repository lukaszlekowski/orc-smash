---
name: 10-simple-research-audit
description: "Audits a research document against the codebase and project constraints before it feeds plan creation."
---

## Purpose

Audit the research document supplied as the target. Determine whether it is a
credible, complete, and actionable basis for creating an implementation plan.
The research loop is optional: this skill does not make research a prerequisite
for the default plan → implement → review pipeline.

## Quality Standard

Check feasibility against the actual repository, architectural boundaries,
scope and non-goals, risks and failure modes, and the evidence needed to verify
the proposed work. Reject research that is vague, contradictory, structurally
incomplete, or that reduces architecture-critical behavior to an MVP shortcut.
The audit is an independent assessment, not an implementation pass.

## Inputs and versioning

- Read the target research document and inspect the relevant codebase.
- The first audit is `v1`. For a second opinion or later version, form your own
  verdict first, then read the prior audit supplied in `Prior artifact` and
  address agreements, disagreements, and missed findings in the audit body.
- Do not modify the research document, source code, roles, skills, or any other
  project file.
- Do not write audit metadata or a date header yourself; the harness supplies
  provenance metadata.

## Required output

Write a versioned audit to the supplied `Output path` with exactly one
`## Verdict` section. The first non-blank line after it must be exactly one of:

```text
APPROVED
REJECTED
```

Use `REJECTED` for any unresolved critical or major finding, an incomplete
verification story, or insufficient confidence. Explain findings with exact
file-level remediation guidance and include the tests or manual checks needed
to prove the repaired research.

Use this structure:

```markdown
## Verdict

APPROVED or REJECTED

## Confidence Score

Overall: 0.XX

## Findings

### Critical (must fix before approval)

### Major (should fix)

### Minor (suggestions)

## Testability Check

## Real Workflow Verification Matrix

## Recommended Actions
```

Do not create or edit `docs/dev/plan.md`; plan creation belongs to the
configured `create-plan` task after an accepted research artifact.
