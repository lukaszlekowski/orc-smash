---
name: 11-simple-research-follow-up
description: "Repairs a research document after a rejected research audit and records completion evidence."
---

## Purpose

Repair the target research document using the rejected audit supplied as the
prior artifact. Preserve the approved direction while fixing every actionable
finding so a later research evaluation can make a fresh decision.

## Rules

- Read the target research document and the prior research audit before editing.
- Modify only the target research document. Do not modify source code,
  `docs/dev/plan.md`, audit artifacts, or any other file.
- Preserve the research document's useful content and repair feasibility,
  architecture, scope boundaries, risks, failure handling, and verification
  gaps identified by the audit.
- Do not create a plan or automate plan creation.
- Do not write audit metadata or a date header yourself; the harness supplies
  provenance metadata.

## Required output

Write a versioned follow-up artifact to the supplied `Output path` with exactly
one `## Outcome` section. The first non-blank line after it must be exactly one
of:

```text
COMPLETED
BLOCKED
```

Use `COMPLETED` only when the research document was repaired and the remaining
work is ready for a new audit. Use `BLOCKED` when a required repair cannot be
made from the available evidence; state the precise blocker immediately after
the token. A completed follow-up is resumable evidence for evaluation, never
approval evidence by itself.
