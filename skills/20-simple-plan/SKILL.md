---
name: 20-simple-plan
description: Creates a coherent spec.md and plan.md planning set for an approved feature before implementation begins.
---

## Purpose

Draft a production-ready planning set: `docs/dev/spec.md` (the acceptance
contract) plus `docs/dev/plan.md` (the delivery design), published as one
transaction-bound document pair. For every plan step, provide explicit
file-level and code-level instructions (including exact functions, hooks, or
files to modify), use industry best practices, and prefer decision-level and
file-level instructions — use exact symbols only where a fragile contract
would otherwise be ambiguous.

---

## Quality Standard

Planning sets must preserve the best-practice, long-term architecture approved
in research. Do not downgrade requirements into "MVP-only" shortcuts, partial
implementations, vague follow-up work, or structural-only scaffolding when
those requirements are central to the feature's quality. If delivery must be
phased, the documents must still define the full target architecture, the
release boundary, and make every phase independently verifiable against real
workflow behavior.

For architecture-critical, security-critical, data-integrity, paid-access,
startup, sync, or cross-stack work, the planning set must prove how the real
workflow will function end to end. Do not treat providers, models, routes,
config fields, or UI locks as complete unless the set also covers the owning
source of truth, persistence/sync behavior, error states, failure recovery,
tests, and manual verification needed to prove the user/developer/backend
workflow.

---

## Documents to Produce

### Specification (`docs/dev/spec.md`)

The acceptance contract. It owns:

- objective and scope;
- acceptance criteria (each independently testable);
- constraints and non-goals;
- research-derived requirements, when approved research exists (trace each
  applicable non-negotiable; do not invent research that does not exist).

The spec does not design delivery. Do not put architecture, file-level steps,
or verification commands in the spec.

### Plan (`docs/dev/plan.md`)

The delivery design. It owns:

- architecture and ownership boundaries;
- implementation sequence (each step independently verifiable);
- file impact;
- failure handling and edge cases;
- verification commands and acceptance gates;
- a Spec-to-Plan Coverage table mapping every spec acceptance criterion to a
  plan step and its verification evidence;
- a confidence score of at least `0.95`.

A plan may elaborate the spec but must not silently narrow or contradict it.

---

## Paired-Publication Protocol (mandatory)

Publish `spec.md` and `plan.md` as one transaction. Never overwrite an
existing canonical document. Recovery authority is durable document metadata,
not a fixed temporary filename.

### Creation metadata

Both documents carry this exact YAML front-matter mapping (preserve insertion
order):

```yaml
creation:
  protocol: orc-planning-set-v1
  transactionId: <64 lowercase hex>
  sourceKind: direct
  sourceArtifactIdentity: none
  sourceDigest: <64 lowercase hex>
  document: spec
  bodyDigest: <64 lowercase hex>
  peerBodyDigest: <64 lowercase hex>
```

- `bodyDigest` is SHA-256 over the Markdown body after the complete YAML front
  matter (the file content following the closing `---` of the creation
  mapping, including the leading newline).
- `peerBodyDigest` is the other canonical document's body digest.
- `sourceDigest` is SHA-256 over the length-delimited serialization of the
  literal `direct`, the spec body digest, and the plan body digest, in that
  order: `sha256(enc("direct") + enc(specBodyDigest) + enc(planBodyDigest))`
  where `enc(x)` is `<decimal UTF-8 byte length>:<x>`.
- `transactionId` is SHA-256 over `enc(protocol) + enc(sourceKind) +
  enc(sourceArtifactIdentity) + enc(sourceDigest) + enc(specBodyDigest) +
  enc(planBodyDigest)` with the fields in that exact order. Lengths are
  unsigned decimal UTF-8 byte counts followed by `:`; no JSON/YAML key
  ordering is involved.
- Both documents must carry the same `transactionId`, the same source tuple,
  and reciprocal `bodyDigest`/`peerBodyDigest` values.

### Staging and publication

Staging files are transaction-scoped siblings in `docs/dev/`:

- `docs/dev/.spec.md.orc-smash-<transactionId>.tmp`
- `docs/dev/.plan.md.orc-smash-<transactionId>.tmp`

Each staging file contains the complete final bytes, including creation
metadata. Publication follows this protocol:

1. Inspect the canonical files and only staging names matching the strict
   protocol pattern. Inspect at most eight matching entries; more than eight
   blocks as an ambiguous/unbounded directory state. Recompute every declared
   digest from bytes; metadata text alone is not proof.
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
   artifact was written.
5. Once canonical content alone is sufficient to reconstruct success, remove
   only staging files whose transaction ID and recomputed bytes match that
   canonical transaction. Cleanup is idempotent: a later retry verifies the
   canonical pair, finishes bounded cleanup, and writes the completion
   artifact. Remove at most the two expected matching staging files; preserve
   and report unrelated or unverifiable staging files.

Zero files therefore creates a pair; one protocol-owned canonical file can
resume its missing peer; two valid protocol-owned canonical files are an
idempotent success. An unrelated pre-existing document without matching,
recomputable creation metadata is never adopted or overwritten.

---

## Rules

- Do not weaken approved research into MVP shortcuts or partial architecture;
  preserve the full long-term standard in the documents.
- Every plan step must be independently verifiable.
- Confidence score of at least `0.95` is required in the header of each
  document. If confidence < 0.95 for either document, stop and report the
  specific blockers instead of finalizing the pair.
- If either canonical document already exists, do not overwrite, truncate, or
  modify it; follow the recovery protocol above.
- Each plan step must say exactly what will change, where it will change, why
  it is needed, and any important edge cases or regressions to watch for. Do
  not write generic advice.
- Assume the model executing this has no reasoning capabilities and requires
  literal instructions.
- If you detect vagueness in your own draft, stop and rewrite before
  answering.

---

## Confirmation

Before writing, state:

- Which documents you will produce
- Your confidence score per document
- Any specific gaps that affect your confidence in generating a high-quality
  planning set.
