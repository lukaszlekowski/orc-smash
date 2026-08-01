---
name: 23-simple-create-plan
description: "Creates the initial spec.md and plan.md planning set from an accepted research artifact without clobbering an existing document."
---

## Purpose

Create the initial `docs/dev/spec.md` and `docs/dev/plan.md` pair from the
accepted research document, bound to the accepted research artifact as the
source authority. This is an ordinary configured task in the optional
research-first pipeline; it is not part of the plan approval loop and it must
never replace an existing document.

## Preconditions and fail-safe behavior

Before creating anything, read the project file supplied as `researchPath`,
read the `Prior artifact`, and inspect the worktree target.

- `researchPath` must exist and contain the research document.
- `Prior artifact` must not be `none`; it must be the exact accepted research
  evaluation artifact, and its `## Verdict` must contain the configured
  accepted token `APPROVED`.
- `docs/dev/spec.md` and `docs/dev/plan.md` must not already exist, unless
  their presence is part of the recovery protocol below.

If any precondition fails, create only the task evidence at the supplied
`Output path` with exactly one `## Outcome` section whose first non-blank line
is exactly `BLOCKED`, followed by the precise reason. Do not create either
document or modify the research document, research audit, or any other project
file. A blocked task artifact is valid evidence but never successor evidence.

## Document authority split

- `docs/dev/spec.md` owns the acceptance contract: objective, acceptance
  criteria, constraints, non-goals, and research-derived requirements.
- `docs/dev/plan.md` owns delivery: architecture, ownership boundaries,
  implementation sequence, file impact, failure handling, verification, and
  acceptance gates, plus a Spec-to-Plan Coverage table mapping every spec
  acceptance criterion to a plan step and its verification evidence.

Both documents must carry a confidence score of at least `0.95` in their
header. The plan must be concrete enough for an implementer and an audit to
validate against the actual codebase.

## Creation metadata and source binding

Both documents carry the `orc-planning-set-v1` creation mapping in YAML front
matter:

```yaml
creation:
  protocol: orc-planning-set-v1
  transactionId: <64 lowercase hex>
  sourceKind: accepted-research
  sourceArtifactIdentity: <accepted evaluation artifact identity>
  sourceDigest: <64 lowercase hex>
  document: spec
  bodyDigest: <64 lowercase hex>
  peerBodyDigest: <64 lowercase hex>
```

- `sourceArtifactIdentity` is the exact artifact identity of the accepted
  research evaluation artifact supplied as `Prior artifact` (its
  `artifactIdentity` provenance value).
- `sourceDigest` is SHA-256 over the length-delimited serialization of the
  research document bytes and the accepted evaluation artifact bytes, in that
  order: `sha256(enc(researchBytes) + enc(evaluationBytes))` where `enc(x)`
  is `<decimal UTF-8 byte length>:<x>`. Read both files fresh; do not trust
  metadata text.
- `bodyDigest` is SHA-256 over the Markdown body after the complete YAML
  front matter. `peerBodyDigest` is the other canonical document's body
  digest.
- `transactionId` is SHA-256 over `enc(protocol) + enc(sourceKind) +
  enc(sourceArtifactIdentity) + enc(sourceDigest) + enc(specBodyDigest) +
  enc(planBodyDigest)` in that exact field order.
- Both documents must carry the same `transactionId`, source tuple, and
  reciprocal body digests.

## Staging and recovery protocol

Staging files are transaction-scoped siblings in `docs/dev/`:
`docs/dev/.spec.md.orc-smash-<transactionId>.tmp` and
`docs/dev/.plan.md.orc-smash-<transactionId>.tmp`, each containing the
complete final bytes including creation metadata.

1. Inspect canonical files and only staging names matching the strict
   protocol pattern. Inspect at most eight matching entries; more than eight
   blocks as an ambiguous/unbounded directory state. Recompute every declared
   digest; metadata text alone is not proof.
2. When no canonical pair exists, generate and validate both complete staging
   files before publishing either one. Recheck that each destination remains
   absent immediately before its same-directory atomic rename. Publish the
   spec first and the plan second. Never rename over an existing destination.
3. On retry, identify a transaction by a valid source tuple and recomputed
   digests — not merely by filename. Resume exactly one matching transaction.
   Multiple matching candidates, malformed metadata, a changed source, or an
   unrelated canonical file returns `BLOCKED` without modifying any canonical
   file.
4. A valid canonical spec plus matching staged plan resumes the second
   publish. Two canonical documents with matching creation metadata and
   recomputed reciprocal digests reconstruct successful publication even when
   interruption occurred after both renames but before the completion
   artifact was written. The retry writes the completion evidence; it does not
   regenerate or replace the documents.
5. Once canonical content alone is sufficient to reconstruct success, remove
   only staging files whose transaction ID and recomputed bytes match that
   canonical transaction. Cleanup is idempotent and removes at most the two
   expected matching staging files; preserve and report unrelated or
   unverifiable staging files.

Never report successful completion with only one canonical document. An
unrelated pre-existing document without matching, recomputable creation
metadata is never adopted or overwritten.

Do not modify `researchPath`, the accepted research audit, source code, roles,
skills, or any other file. Do not create a replacement workflow for an
existing planning set.

## Required evidence

The task evidence at `Output path` must contain exactly one `## Outcome`
section with `COMPLETED` as its first non-blank line after the heading when
the pair was created. Summarize both created document paths and the
verification performed without duplicating the documents or writing another
artifact.
