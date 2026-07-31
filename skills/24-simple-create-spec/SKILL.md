---
name: 24-simple-create-spec
description: "Creates docs/dev/spec.md for an existing plan-only project without changing the plan. Use when a plan exists but no specification exists."
---

## Purpose

Create `docs/dev/spec.md` for an existing plan-only project, preserving the
plan byte-for-byte. This is the explicit migration for a plan-only target: it
bootstraps the acceptance contract from the existing `docs/dev/plan.md`. The
resulting pair is **not approved by this task** — after it returns
`COMPLETED`, the operator must run the plan approval loop against the new
spec/plan pair, and implementation or review remains unavailable until that
joint audit is accepted.

This is an ordinary operator-invoked configured task, not a pipeline stage,
and it never modifies or replaces the plan.

## Preconditions and fail-safe behavior

- The project file supplied as `planPath` must exist and contain the plan.
- Fresh creation requires `docs/dev/spec.md` to be absent. If it exists, it
  is accepted only under the idempotent-success rules below; any other
  existing spec blocks the task.
- The task derives objective, acceptance criteria, constraints, and non-goals
  from the plan and verified codebase context.

If a precondition fails, or if requirements are too ambiguous to preserve the
plan's intent, create only the task evidence at the supplied `Output path`
with exactly one `## Outcome` section whose first non-blank line is exactly
`BLOCKED`, followed by the precise reason. Do not create, modify, or delete
any canonical document. A blocked task artifact is valid evidence but never
successor evidence.

## Confidence requirement

Require confidence of at least `0.95` that the derived spec preserves the
plan's intent. If confidence is below `0.95` or the plan is too ambiguous to
derive a faithful spec, return `BLOCKED` without creating the spec.

## Creation metadata and plan binding

The bootstrapped spec carries this `orc-planning-set-v1` creation mapping in
YAML front matter:

```yaml
creation:
  protocol: orc-planning-set-v1
  transactionId: <64 lowercase hex>
  sourceKind: plan-bootstrap
  sourceArtifactIdentity: none
  sourceDigest: <plan body digest>
  document: spec
  bodyDigest: <64 lowercase hex>
  peerBodyDigest: <plan body digest>
```

- `sourceDigest` and `peerBodyDigest` equal the existing plan-body digest
  (SHA-256 over the plan's Markdown body after its complete YAML front
  matter). Recompute it from the plan bytes; do not trust metadata text.
- `bodyDigest` is SHA-256 over the spec's Markdown body after its complete
  YAML front matter.
- `transactionId` is SHA-256 over `enc(protocol) + enc(sourceKind) +
  enc(sourceArtifactIdentity) + enc(sourceDigest) + enc(specBodyDigest) +
  enc(planBodyDigest)` in that exact field order, where `enc(x)` is
  `<decimal UTF-8 byte length>:<x>`.
- The existing plan remains byte-for-byte unchanged and does not acquire
  reciprocal metadata.

## Staging and publication

Stage the complete final spec bytes (including creation metadata) at
`docs/dev/.spec.md.orc-smash-<transactionId>.tmp`.

1. Inspect canonical files and only staging names matching the strict
   protocol pattern. Inspect at most eight matching entries; more than eight
   blocks as an ambiguous/unbounded directory state. Recompute every declared
   digest; metadata text alone is not proof.
2. Fresh creation: generate and validate the complete staging file, recheck
   that the destination remains absent immediately before the same-directory
   atomic rename, and never rename over an existing destination.
3. Retry reconstruction: an existing spec whose recomputed metadata still
   binds to the unchanged plan is idempotent completed work, including the
   window after spec publication but before task evidence. A changed plan,
   unrelated spec, ambiguous staging set, or digest mismatch blocks without
   overwriting either document.
4. On success, remove only staging files whose transaction ID and recomputed
   bytes match the published spec; preserve and report unrelated or
   unverifiable staging files. Cleanup is idempotent.

## Required evidence

The task evidence at `Output path` must contain exactly one `## Outcome`
section with `COMPLETED` as its first non-blank line after the heading when
the spec was created (or already existed with valid plan binding), followed
by:

- the created spec path;
- confirmation that the plan bytes are unchanged;
- the requirement that the operator run the plan approval loop against the
  new pair — no legacy plan audit is successor evidence for the pair, and a
  fresh joint approval is mandatory before implementation or review.
