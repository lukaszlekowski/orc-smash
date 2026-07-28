---
name: 23-simple-create-plan
description: "Creates the initial implementation plan from an accepted research artifact without clobbering an existing plan."
---

## Purpose

Create the initial `docs/dev/plan.md` from the accepted research document. This
is an ordinary configured task in the optional research-first pipeline; it is
not part of the plan approval loop and it must never replace an existing plan.

## Preconditions and fail-safe behavior

Before creating anything, read the project file supplied as `researchPath`,
read the `Prior artifact`, and inspect the worktree target.

- `researchPath` must exist and contain the research document.
- `Prior artifact` must not be `none`; it must be the exact accepted research
  evaluation artifact, and its `## Verdict` must contain the configured
  accepted token `APPROVED`.
- `docs/dev/plan.md` must not already exist. If it exists, do not overwrite,
  truncate, or modify it.

If any precondition fails, create only the task evidence at the supplied
`Output path` with exactly one `## Outcome` section whose first non-blank line
is exactly `BLOCKED`, followed by the precise reason. Do not create a plan or
modify the research document, research audit, or any other project file. A
blocked task artifact is valid evidence but never successor evidence.

## Successful execution

When all preconditions pass, create only these two project files:

1. `docs/dev/plan.md`, as the initial implementation plan; and
2. the task evidence at the supplied `Output path`.

The plan must meet the project's quality standard: include a confidence header
of at least `0.95`, a clear objective and scope, explicit non-goals, the
long-term architecture and ownership boundaries, file-level implementation
steps, edge cases and failure handling, deterministic and manual verification
commands, and release/acceptance gates. It must be concrete enough for an
implementer and an audit to validate against the actual codebase.

Do not modify `researchPath`, the accepted research audit, source code, roles,
skills, or any other file. Do not create a replacement workflow for an
existing plan.

## Required evidence

The task evidence at `Output path` must contain exactly one `## Outcome` section
with `COMPLETED` as its first non-blank line after the heading when the plan
was created. Summarize the created plan path and the verification performed
without duplicating the plan document or writing another artifact.
