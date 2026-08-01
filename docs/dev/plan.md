---
status: ready
confidence: 0.98
---

# Batch 8 — Spec-and-Plan Skill Contract Improvements

## Objective

Improve the packaged planning, implementation, and review skills by adopting the
useful quality controls identified in the older planning skills while preserving
the current config-driven harness, approval loops, artifact contracts, automatic
preflight, fingerprints, lineage, provider selection, and pipeline behavior.

Batch 8 introduces `docs/dev/spec.md` as the acceptance contract alongside
`docs/dev/plan.md` as the implementation design. The existing `plan` approval
loop audits and repairs the two documents as one planning set; it does not gain a
second loop or a special-case execution path.

## Scope and Authority

- `spec.md` owns the required behavior: objective, acceptance criteria,
  constraints, non-goals, and relevant research requirements.
- `plan.md` owns delivery: architecture, ownership boundaries, implementation
  sequence, affected files, migration or compatibility work, and verification.
- A plan may elaborate a spec but must not silently narrow or contradict it.
- `plan.md` remains the approval-loop target and the only document updated by
  implementation closeout. `spec.md` is a named project-file input and remains
  the stable acceptance contract.
- The current implementation and descriptive architecture documents are
  evidence about the baseline, not automatically immutable design constraints.
  An explicitly proposed architecture change is assessed as a transition to a
  target design. Controlling safety invariants in `AGENTS.md` remain mandatory
  unless the user explicitly reopens them.
- The executing agent owns every feasible local and automated verification.
  Operator-only checks are exceptional and must identify the unavailable
  capability, exact steps, expected result, substitute evidence, and whether the
  missing result blocks approval or completion.

## Non-Goals

- Do not support, load, or emulate the old `21-plans-audit` or
  `22-plans-follow-up` workflow.
- Do not add ADR, todo, timeline, or feature-folder conventions.
- Do not add another approval loop, pipeline stage, execution engine, database,
  workflow-name branch, or automatic downstream transition.
- Do not remove or weaken existing manifest validation, missing-input preflight,
  output classification, implementation-ledger validation, exact decision and
  outcome tokens, fingerprints, provenance, lineage, continuity, provider
  telemetry, or iteration controls.
- Do not make research mandatory for the default pipeline.
- Do not introduce harness-owned semantic scoring or parse the new audit tables
  in TypeScript in this batch.
- Do not introduce a dynamically selected second-opinion role or require a prior
  audit/repair artifact for a second opinion.
- Do not treat an audit of a legacy plan alone as approval of a newly created
  specification.

## Design Decisions

### Document-set lifecycle and recoverable publication

The direct planning skill and the research-first `create-plan` task create both
documents. Neither skill overwrites a canonical document. Recovery authority is
durable document metadata, not a fixed temporary filename or the continued
existence of a provider process.

Every document created by the paired-publication protocol contains a preserved
`creation:` mapping in YAML front matter with this exact logical schema:

```yaml
creation:
  protocol: orc-planning-set-v1
  transactionId: <64 lowercase hex>
  sourceKind: direct | accepted-research | plan-bootstrap
  sourceArtifactIdentity: <artifact identity or none>
  sourceDigest: <64 lowercase hex>
  document: spec | plan
  bodyDigest: <64 lowercase hex>
  peerBodyDigest: <64 lowercase hex>
```

`bodyDigest` is SHA-256 over the Markdown body after the complete YAML front
matter. `peerBodyDigest` is the other canonical document's body digest. The
transaction ID is SHA-256 over a length-delimited serialization of the protocol,
source kind, source artifact identity, source digest, spec body digest, and plan
body digest. Lengths are unsigned decimal UTF-8 byte counts followed by `:`, in
the field order just listed; no JSON/YAML key ordering is involved. For
`accepted-research`, `sourceArtifactIdentity` is the exact
accepted evaluation identity and `sourceDigest` covers both the research bytes
and accepted evaluation artifact bytes. For direct authoring without research,
the source identity is `none` and the source digest is the domain-separated,
length-delimited digest of the literal `direct` plus the two body digests, so it
is reconstructable without conversation history. The two documents must carry
the same transaction ID, source tuple, and reciprocal body digests.

Staging files are transaction-scoped siblings:
`docs/dev/.spec.md.orc-smash-<transactionId>.tmp` and
`docs/dev/.plan.md.orc-smash-<transactionId>.tmp`. They contain the complete
final bytes, including creation metadata. Publication follows this protocol:

1. Inspect canonical files and only staging names matching the strict protocol
   pattern. Inspect at most eight matching entries; more than eight blocks as an
   ambiguous/unbounded directory state. Recompute every declared digest;
   metadata text alone is not proof.
2. When no canonical pair exists, generate and validate both complete staging
   files before publishing either one. Recheck that each destination remains
   absent immediately before its same-directory atomic rename. Publish spec
   first and plan second. Never rename over an existing destination.
3. On retry, identify a transaction by a valid source tuple and recomputed
   digests—not merely by filename. Resume exactly one matching transaction.
   Multiple matching candidates, malformed metadata, a changed source, or an
   unrelated canonical file returns `BLOCKED` without modifying any canonical
   file.
4. A valid canonical spec plus matching staged plan resumes the second publish.
   Two canonical documents with matching creation metadata and recomputed
   reciprocal digests reconstruct successful publication even when interruption
   occurred after both renames but before the completion artifact was written.
   The retry writes the configured `COMPLETED` evidence; it does not regenerate
   or replace the documents.
5. Once canonical content alone is sufficient to reconstruct success, remove
   only staging files whose transaction ID and recomputed bytes match that
   canonical transaction. Cleanup interruption is idempotent: a later retry
   verifies the canonical pair, finishes bounded cleanup, and writes completion
   evidence. At most the two expected matching staging files are removed;
   unrelated or unverifiable staging files are preserved and reported.

Zero files therefore creates a pair; one protocol-owned canonical file can
resume its missing peer; and two valid protocol-owned canonical files are an
idempotent success for the same source authority. An unrelated pre-existing
document without matching, recomputable creation metadata is never adopted or
overwritten. The plan follow-up skill edits an existing complete pair after
rejection and preserves the creation mapping as an immutable publication
receipt. After direct authoring has returned successfully or classified task
completion exists, that receipt is not a current-content integrity check and its
original body digests are not rewritten. Current document integrity and
staleness belong to binding fingerprints. Plan follow-up is not the recovery
mechanism for a missing document.

The `plan` loop continues to target `docs/dev/plan.md` and declares
`specPath: docs/dev/spec.md` as a named file input. The `implement` task and
`review` loop declare both `specPath` and `planPath`. This uses the current
generic input resolution and means missing files prevent execution and changes
to either document affect the input fingerprint.

The `create-plan` task must not declare its not-yet-created output documents as
named file inputs because existing preflight correctly treats missing named
inputs as unavailable. Its skill continues to own the canonical creation paths.

### Plan-only project migration and Batch 8 cutover

Add a packaged ordinary `create-spec` task backed by a new
`skills/24-simple-create-spec/SKILL.md`. It targets the worktree, receives the
existing `planPath` as a declared input, and writes only a missing
`docs/dev/spec.md` plus its configured completion artifact. It never modifies
or replaces the plan. The skill derives objective, acceptance criteria,
constraints, and non-goals from the plan and verified codebase context. It
returns `BLOCKED` without creating the spec when confidence is below `0.95` or
the plan is too ambiguous to preserve intent.

The bootstrapped spec uses the same `creation:` schema with
`sourceKind: plan-bootstrap`, `sourceArtifactIdentity: none`, `sourceDigest` and
`peerBodyDigest` equal to the existing plan-body digest, and a transaction ID
derived from the source tuple plus the spec and plan body digests. The existing
plan remains byte-for-byte unchanged and need not acquire reciprocal metadata.
On retry, a spec whose recomputed metadata still binds to the unchanged plan is
idempotent completed work, including the window after spec publication but
before task evidence. A changed plan, unrelated spec, ambiguous staging set, or
digest mismatch blocks without overwriting either document.

The task is operator-invoked and remains outside both pipelines. After it
returns `COMPLETED`, the operator must run the plan approval loop against the
new spec/plan pair. No legacy plan audit is successor evidence for that pair:
the new binding-result fingerprint differs, so implementation remains
unavailable until the joint audit is accepted.

Release ordering is a mandatory migration gate:

1. **First implementation invocation:** start from the accepted legacy plan
   edge. In this one provider subprocess, implement and test the `create-spec`
   task, transaction-aware authoring rules, generic binding-result snapshot,
   joint plan-audit/follow-up skills, `specPath` on the plan/implement/review
   bindings, and the spec-aware implement skill. The running subprocess keeps
   the legacy manifest/prompt snapshot with which it started; the new bindings
   govern only later invocations. Do not invoke `orc` recursively or wait for
   operator input.
2. End that first invocation with a structurally valid blocked implementation
   ledger whose exact remaining blocker is `fresh joint plan approval required`.
   The blocked artifact is durable terminal evidence for the first invocation,
   releases run ownership, cannot unlock review, and consumes only its legacy
   predecessor edge.
3. **Operator invocation after ownership release:** run the ordinary
   `create-spec` task. It requires only `planPath`, so it remains available even
   though the newly configured plan, implement, and review actions are
   unavailable until `spec.md` exists.
4. **Separate operator invocation:** run the newly joint plan loop. The new
   composite binding snapshot makes the target-only legacy approval stale; the
   blocked implementation artifact is not approval evidence. Obtain a distinct
   accepted joint-audit edge for the current spec/plan bytes.
5. **Second implementation invocation:** start only from that distinct accepted
   joint edge. Because the first invocation already installed `specPath`, this
   invocation is preflighted and composed with both exact document paths before
   the provider starts. Complete the remaining 8D–8E role, review/follow-up
   skill, test, and documentation work. Its valid completed ledger may then
   unlock review normally.

The initial legacy-plan approval authorizes only this bounded bootstrap/cutover
slice. It is not approval of the newly generated spec or the remaining feature.
The cutover is not a compatibility loader or hidden state; it is an explicit,
one-time document migration using an ordinary configured task and a mandatory
re-entry through the existing plan approval loop. Every numbered boundary above
is a completed harness invocation; no subprocess is paused and resumed, and no
two invocations own the target concurrently.

### Generic binding-result snapshot

The current `resultFingerprint` name and provenance field remain v1-compatible,
but their result-time value becomes the digest of a canonical binding snapshot:

- the existing target fingerprint; and
- the content digest of every declared `files:` dependency in sorted key order.

`src/target-snapshot.ts` owns a new pure
`captureBindingResultFingerprint(projectRoot, target, files, manifest)` helper
that reuses `captureTargetFingerprint` and `captureFileDigests`. The serialized
shape is domain-separated and deterministic so target/file boundaries cannot
collide. `src/loops/binding-engine.ts` records this composite value after a
classified provider result. If a provider removed a declared file, result
snapshot capture is caught and the step stops as `unknown` without classified
successor evidence. `src/next-step.ts` reconstructs the same composite value for
each configured pipeline-stage binding. If a declared file is missing, snapshot
construction does not crash status or menus: it omits that stage's current
snapshot so existing typed missing-fingerprint/unavailable and missing-input
preflight paths fail closed.

`src/pipeline-stage-state.ts` continues to compare the current map entry with
the recorded `resultFingerprint`, preserve `target-fingerprint-drift` and
`missing-target-fingerprint` reasons, and preserve exact-edge consumption and
historical-lineage rules. Its internal parameter/comment naming is updated to
make clear that the map now contains binding snapshots. Historical artifacts
whose target-only result fingerprint predates this rule fail closed as stale;
they are not migrated or reclassified.

### Independent audit and second-opinion semantics

Artifact version does not identify a second opinion. A v2 evaluation can be the
ordinary audit after a v1 repair, while a second opinion is a fresh chain root
whose prior artifact is `none`.

Auditor and reviewer instructions require an independent assessment of the
current target, declared requirements, and codebase before consulting any prior
artifact. When a prior artifact is supplied, it is repair/comparison evidence,
not authority. When it is `none`, the agent does not search for historical
audits or reviews. The existing harness behavior for fresh second-opinion chains
is unchanged.

### Blocking threshold and audit convergence

- Critical and Major findings block approval.
- Minor findings are advisory and do not block approval.
- A missing acceptance criterion, safety invariant, feasibility requirement,
  migration obligation, or required verification is at least Major; an auditor
  must not hide a blocker under Minor.
- Every blocking finding cites its authority: a spec requirement, applicable
  approved research constraint, controlling project invariant, verified
  codebase fact, or missing verification obligation.
- A later audit may introduce a new blocker only with that concrete basis.
- Implementation-local uncertainty may remain for implementation/review when
  the plan defines a reliable way to expose it. Planning approval does not
  require predicting every coding defect.
- Approval requires zero unresolved Critical or Major findings and overall
  confidence of at least `0.95`.

### Intentional architecture changes

The planning audit must not reject solely because the proposed design differs
from current code or descriptive architecture documentation. It first decides
whether the difference is intentional. An intentional replacement must state:

1. the current behavior or architecture being replaced;
2. the target architecture and ownership boundaries;
3. the invariants retained;
4. migration and compatibility effects; and
5. the tests and documentation that will be updated.

Reject accidental contradictions, infeasible transitions, missing migration or
verification coverage, and violations of controlling invariants that were not
explicitly reopened. When an architecture document describes the superseded
baseline, updating that document belongs in implementation scope rather than
forcing the plan back to the old design.

### Skill-owned quality measures

The planning audit records semantic coverage rather than adding a harness
validator:

- 100% of spec acceptance criteria map to plan work.
- 100% of spec acceptance criteria map to verification evidence.
- 100% of applicable approved research constraints map into the spec and plan
  when approved research exists.
- 100% of claimed workflows have success-path verification and relevant
  failure/recovery verification.
- Zero unexplained missing requirements.
- Zero unresolved Critical or Major findings.
- Overall confidence is at least `0.95`.

## Implementation Steps

### 8A — Establish the two-document authoring contract

#### Design

Update both plan-creation skills to produce a coherent `spec.md` and `plan.md`
pair with the authority split defined above.

`skills/20-simple-plan/SKILL.md` must:

- produce `docs/dev/spec.md` and `docs/dev/plan.md`;
- require a confidence score of at least `0.95` for each document;
- put acceptance criteria, constraints, research-derived requirements, and
  non-goals in the spec;
- put architecture, sequencing, file impact, failure handling, and verification
  in the plan;
- include a spec-to-plan coverage table in the plan;
- treat approved research as optional, but preserve and trace its applicable
  non-negotiables when it exists;
- emit and validate the `orc-planning-set-v1` creation mapping, reciprocal body
  digests, reconstructable direct-source digest, transaction-scoped staging,
  and zero/one/two-file recovery protocol; and
- prefer decision-level and file-level instructions, using exact symbols only
  where a fragile contract would otherwise be ambiguous.

`skills/23-simple-create-plan/SKILL.md` must:

- create both canonical files from accepted research;
- bind the transaction to the accepted research artifact identity and the
  recomputed research/evaluation source digest;
- use transaction-scoped staging and recover valid interruption windows without
  overwriting either canonical file;
- define behavior for zero, one, and two canonical files and reject unsafe or
  inconsistent pre-existing content;
- never report successful completion with only one canonical document;
- define the same spec/plan authority split and coverage requirements; and
- retain the current `COMPLETED`/`BLOCKED` task-evidence contract and
  non-clobbering behavior.

Add `skills/24-simple-create-spec/SKILL.md` for the plan-only migration. It must:

- require an existing `planPath`; fresh creation requires an absent
  `docs/dev/spec.md`, while retry reconstruction permits only an existing
  protocol-valid spec whose recomputed metadata binds to the unchanged plan;
- create only the spec using `plan-bootstrap` metadata, transaction-scoped
  staging, and same-directory atomic publication;
- preserve the plan byte-for-byte;
- recognize an already published spec as idempotent success only when its
  recomputed metadata still binds to the unchanged plan;
- require confidence of at least `0.95` and block on ambiguous requirements;
- explain that the resulting pair requires a fresh joint plan audit; and
- write exactly one configured `## Outcome` token to its task evidence.

Register this skill and its ordinary `create-spec` task in
`config/orc-smash.yaml` during the first cutover invocation. In that same
invocation, 8B adds `specPath` to plan, implement, and review. The running legacy
implementation is unaffected because its config and prompt were resolved before
those edits; after ownership release, the new missing-input preflight disables
those three actions while leaving `create-spec` runnable for plan-only targets.

`roles/planner.md` must describe planning documents generically enough to cover
spec creation, plan creation, research follow-up, and paired plan repair without
embedding project-specific workflow branching.

#### File impact

- `skills/20-simple-plan/SKILL.md`
- `skills/23-simple-create-plan/SKILL.md`
- `skills/24-simple-create-spec/SKILL.md` (new)
- `roles/planner.md`
- `config/orc-smash.yaml` (add the migration skill/task; the same first
  invocation also applies all 8B named-input changes)

#### Verification

- Add a focused skill-contract test that reads the packaged skills and proves
  both authoring paths require the two canonical documents, their authority
  split, non-clobbering behavior, creation-metadata schema, source binding,
  transaction-scoped recovery protocol, and the existing outcome contract.
- In the research-first deterministic e2e, verify successful `create-plan`
  produces both files. Inject interruption (a) before either rename, (b) between
  renames, (c) after both renames but before completion-artifact classification,
  and (d) during staging cleanup. For every window, prove source attribution,
  digest validation, canonical-file preservation, retry classification,
  exact-edge behavior, and bounded cleanup. Also prove unrelated, ambiguous,
  changed-source, and malformed transaction files are preserved and return
  `BLOCKED` without claiming successor availability.
- Add deterministic `create-spec` task coverage for an existing plan-only
  target: success preserves the plan bytes, ambiguity blocks without a spec,
  pre-existing unrelated spec is never overwritten, after-publication/
  before-evidence retry is idempotent, cleanup is bounded, and the task remains
  outside pipeline progression.
- Add a cutover integration fixture proving the bootstrap implementation ledger
  is classified `blocked`, releases ownership, does not unlock review, and a
  later distinct jointly accepted plan edge can start a separate implementation
  invocation.

### 8B — Wire `specPath` through existing generic manifest inputs

#### Design

Execute this complete step in the first legacy-authorized implementation
invocation. The running invocation retains its already-resolved legacy binding;
the changed manifest applies after ownership is released:

- `plan` loop: keep `target: docs/dev/plan.md`; add
  `files.specPath: docs/dev/spec.md` and include `specPath` in `inputs`.
- `implement` task: add `files.specPath: docs/dev/spec.md` beside `planPath`
  and include both in `inputs`.
- `review` loop: add `files.specPath: docs/dev/spec.md` beside `planPath` and
  include both in `inputs`.
- Preserve the `24-simple-create-spec` registration and ordinary `create-spec`
  completion task added in 8A; its only named input remains `planPath`.
- Give the prompt inputs explicit human-readable labels for the specification
  and implementation plan.
- Keep `create-plan` wired only to its existing input documents; do not declare
  absent output paths as named inputs.

Do not change manifest schemas, prompt composition, preflight policy, pipeline
definitions, artifact schema version, or output contracts. The generic
machinery already supports multiple declared project-file inputs. Change only
result-time snapshot construction and current-stage snapshot reconstruction so
the existing state comparison covers the binding target plus declared files.

#### File impact

- `config/orc-smash.yaml`
- `src/target-snapshot.ts`
- `src/loops/binding-engine.ts`
- `src/next-step.ts`
- `src/pipeline-stage-state.ts` (semantic naming/comments; preserve typed
  reasons and comparison behavior)

#### Verification

- Extend `tests/prompt-composer.test.ts` to prove both paths resolve from the
  project root and appear in declared order for planning, implementation, and
  review prompts.
- Extend manifest/config tests to prove every new `files:` key is referenced by
  `inputs` and the packaged manifest loads unchanged through the v1 schema.
- Extend action/preflight tests to prove missing `spec.md` or `plan.md` reports
  the exact named missing input and prevents ownership admission/provider spawn
  for implement/review; missing `spec.md` similarly prevents the plan loop.
- Add focused snapshot tests proving canonical ordering, target/file domain
  separation, stable unchanged values, and missing dependency handling.
- Add loop-level coverage proving deletion of a declared file during provider
  execution stops as `unknown` without a classified artifact or successor.
- Add pipeline/action regressions proving an accepted plan+spec remains
  eligible unchanged; editing only `spec.md` yields the existing typed stale
  reason and prevents implementation; restoring the exact accepted bytes
  restores eligibility; a missing spec remains a typed preflight failure; and
  changing an unrelated file does not stale a file-target plan stage.
- Retain a separate assertion that the pre-run `inputFingerprint` changes when
  `spec.md` changes, but do not use that assertion as proof of successor
  invalidation.
- Prove a pre-Batch-8 target-only `resultFingerprint` does not authorize the new
  paired successor after `spec.md` is bootstrapped; a fresh joint approval is
  required.

### 8C — Strengthen plan audit and plan follow-up

#### Design

Apply the plan-audit and plan-follow-up portions of this step at the cutover
alongside the plan loop's `specPath`; they are prerequisites for the mandatory
joint re-audit. Update `skills/21-simple-plans-audit/SKILL.md` to audit the spec
and plan as one set. It must include:

- spec completeness and testability;
- the intentional-architecture-change rule;
- the blocking-authority and convergence rules;
- a Spec-to-Plan Coverage table with requirement, plan step, verification, and
  status;
- a conditional Research-to-Execution table when approved research exists;
- a `Requirements Not Carried Forward` section that says `None` when empty;
- the existing Testability and Real Workflow matrices, updated to cite both
  documents;
- the semantic quality measures above; and
- exact `APPROVED`/`REJECTED`, confidence, output-path, and no-target-modification
  requirements already present.

Replace the `v2+` second-opinion rule with prior-artifact-aware behavior. The
audit first assesses current documents independently. If the supplied prior
artifact is a follow-up, it then verifies the repair claims; if it is another
explicitly supplied comparison artifact, it records agreements and
disagreements. Version alone never requires a historical lookup.

Update `skills/22-simple-plans-follow-up/SKILL.md` to:

- read and patch both documents in place;
- preserve the spec/plan authority boundary and all good content;
- fix each blocking finding without weakening research or controlling
  invariants;
- block rather than guess when an audit asks to change approved research or a
  non-reopened controlling invariant;
- keep the existing exact `Outcome`, output-path, and no-approval contracts;
  and
- re-check all coverage and traceability sections after repair.

Update `roles/auditor.md` with the generic independent-first rule. Keep its
authorization to write only the configured audit artifact and its prohibition
on editing the target documents or source code.

#### File impact

- `skills/21-simple-plans-audit/SKILL.md`
- `skills/22-simple-plans-follow-up/SKILL.md`
- `roles/auditor.md`

#### Verification

- Add skill-contract tests for the two required document inputs, mandatory
  matrices/omissions section, architecture-change exception, blocker authority,
  severity threshold, confidence threshold, and exact decision/outcome tokens.
- Add prompt/e2e coverage proving an ordinary post-repair v2 receives the repair
  artifact while a fresh second opinion receives `Prior artifact: none`; neither
  skill equates the numeric version with chain mode.
- Prove a spec-file change makes prior accepted plan evaluation evidence stale
  through the new binding-result snapshot and existing state comparison.

### 8D — Make implementation and review spec-and-plan aware

#### Design

Update `skills/30-simple-implement/SKILL.md` during the first cutover invocation,
so the second invocation is composed with the new contract already installed.
It must require the spec, plan, and approved joint plan audit before modifying
code. Every spec acceptance criterion must appear in the implementation
requirement-coverage table. The implementer follows the approved plan as the
delivery design; a material spec/plan conflict or a necessary architecture
change outside the approved set results in blocked evidence rather than an
improvised implementation. Preserve the exact existing implementation-ledger
headers, accepted status vocabulary, confidence threshold, and harness-owned
plan closeout. Add one narrow phase-boundary rule: when an approved plan
explicitly requires a fresh approval between independently verifiable slices,
finish the first subprocess with a structurally valid blocked ledger, release
ownership, and require a later implementation invocation from a new accepted
edge. The implementer must never invoke the harness recursively or claim
completion for the unfinished slices.

Update `skills/40-simple-review/SKILL.md` to review the worktree first against
the spec's required outcomes and then against the plan's architecture, steps,
and verification. It must:

- map every acceptance criterion and plan step to implementation evidence;
- retain diff, regression, partial-implementation, real-workflow,
  maintainability, and exact-remediation checks;
- apply the same intentional-architecture and blocker-authority rules, while
  rejecting unapproved architectural deviations from the spec/plan set;
- use Critical/Major as blocking and Minor as advisory;
- replace version-based second-opinion wording with independent-first,
  prior-artifact-aware comparison; and
- retain the configured exact verdict, output path, and confidence requirements.

Update `skills/42-simple-review-follow-up/SKILL.md` to require both documents,
repair only rejected findings, and preserve the spec outcomes plus approved plan
architecture. If a finding contradicts the approved documents or requires a new
architecture beyond them, write `BLOCKED` evidence and require planning to be
reopened. Remove the unrelated timeline-row instruction.

Across implementation, review, and review follow-up, require the agent to run
all feasible local/automated verification. Operator-only verification is allowed
only under the exception contract in Scope and Authority; a mandatory check that
cannot be performed or substituted keeps the result blocked.

Update `roles/implementer.md` and `roles/reviewer.md` so their concise role
definitions recognize both documents. The reviewer role also receives the
independent-first rule. Do not add a special second-opinion role.

#### File impact

- `skills/30-simple-implement/SKILL.md`
- `skills/40-simple-review/SKILL.md`
- `skills/42-simple-review-follow-up/SKILL.md`
- `roles/implementer.md`
- `roles/reviewer.md`

#### Verification

- Preserve all `tests/implement-ledger.test.ts` cases and add a regression that
  confirms the skill still emits the exact validator-owned table headers.
- Extend deterministic implementation/review loop tests so prompts contain both
  absolute document paths and so missing either document fails preflight.
- Add a purpose-named cutover e2e that executes the first `runTask`, ownership
  release, separate `create-spec` task, separate joint `runLoop`, and second
  `runTask`. Assert zero nested provider runs and prove missing prior evidence,
  the legacy target-only approval, and the blocked first ledger cannot authorize
  the second implementation slice. Capture the second implementation prompt and
  require both absolute `specPath` and `planPath`, proving the manifest edit was
  installed before—not during—that subprocess.
- Add skill-contract assertions for conflict blocking, independent-first review,
  operator-verification limits, severity semantics, and removal of timeline/ADR/
  todo requirements.
- Exercise a review rejection followed by repair and reevaluation to prove the
  configured decision and completion contracts are unchanged.

### 8E — Synchronize operator documentation and run release gates

#### Design

Document the paired planning contract without presenting it as a new execution
engine:

- describe `spec.md` as the acceptance source and `plan.md` as the delivery and
  closeout source;
- explain that the existing plan loop audits both through a named file input;
- document `create-spec` as the explicit migration for a plan-only project and
  require a fresh joint approval afterward;
- define `resultFingerprint` as the binding target plus declared project-file
  dependencies while preserving the v1 provenance field and typed stale
  reasons;
- retain the default and research-first pipeline sequences exactly;
- state that optional research is traced when present but remains unnecessary
  for the default pipeline;
- state that second opinions remain fresh chains and artifact version does not
  define second-opinion semantics; and
- state that existing harness validation, pipeline structure, and artifact
  contracts are preserved while the generic result snapshot expands to include
  declared file dependencies.

#### File impact

- `AGENTS.md`
- `README.md`
- `docs/architecture/overview.md`
- Relevant tests under `tests/`, selected according to the preceding steps.

#### Verification

Run, in order:

1. `pnpm build`
2. `pnpm test`

Then inspect the final diff for accidental changes to pipeline order, output
patterns/contracts, decision tokens, implementation-ledger headers, runner
profiles, provider behavior, lineage, fingerprints, or closeout ownership.

Run the migration/cutover verification in a disposable plan-only project before
the final release gate. Execute the actual discrete sequence: legacy-authorized
first implementation returning a blocked ledger; ownership release; ordinary
`create-spec`; joint plan loop; second implementation from its accepted edge.
Confirm the plan bytes are unchanged by migration, the old approval and blocked
ledger cannot authorize the second slice, no provider calls overlap, and only
the accepted paired evidence unlocks the existing implement stage.

Real-provider contract runs are not required because Batch 8 changes packaged
prompts/configuration and deterministic harness behavior, not provider adapters
or subprocess arguments. If implementation unexpectedly touches an adapter or
provider execution seam, stop and expand verification to the affected real
provider contract before declaring completion.

## Acceptance Gates

- Both planning creation paths define and safely create `spec.md` plus
  `plan.md`.
- Interrupted two-file creation has a tested retry path that preserves canonical
  files, validates durable transaction/source metadata, handles every
  publication/evidence window, cleans only matching staging files, and does not
  consume the predecessor edge with misleading terminal evidence.
- A plan-only project can invoke the ordinary `create-spec` task without
  changing its plan, after which a fresh joint plan audit is mandatory.
- The active Batch 8 cutover ends with blocked implementation evidence, cannot
  unlock review, releases ownership before `create-spec`, and resumes in a new
  provider invocation only from a distinct accepted joint-audit edge.
- Plan audit/follow-up, implementation, review, and review follow-up receive and
  use the two-document authority model.
- The plan loop remains one approval loop with `plan.md` as target and
  `specPath` as a named input.
- Missing required documents fail through existing generic preflight before a
  provider is spawned.
- The recorded result fingerprint and reconstructed current binding snapshot
  cover both planning documents; editing only `spec.md` stales accepted plan
  evidence, restoring the accepted bytes restores eligibility, and unrelated
  files do not stale the file-target plan stage.
- Plan and implementation audits contain complete requirement coverage and can
  reject structural-only workflows.
- Intentional architecture changes are evaluated as transitions rather than
  automatically forced back to outdated descriptive documentation.
- Every blocking finding cites a concrete authority; Minor findings do not
  prevent approval.
- Second opinions remain independent fresh chains without version-based or
  prior-artifact inference in the skills.
- Agents do not delegate feasible verification to the operator.
- No ADR, todo, timeline, compatibility loader, hardcoded workflow branch, new
  pipeline stage, or semantic harness validator is introduced.
- Existing v1 provenance field names, typed stale reasons, exact-edge
  consumption, and historical-lineage rules remain compatible and fail closed
  for legacy target-only fingerprints.
- Existing decision/outcome parsing, implementation-ledger validation,
  provenance, lineage, runner selection, provider behavior, and plan closeout
  tests remain green.
- `pnpm build` and the deterministic test suite pass.

## Risks and Mitigations

- **Partial document pair or terminal evidence gap:** creation skills bind body
  digests and source authority into durable creation metadata, use
  transaction-scoped staging, and reconstruct success from canonical bytes even
  after both renames. Unsafe/ambiguous state is preserved and reported
  `BLOCKED`; cleanup touches only recomputed matching transaction files.
- **Cutover attempts a nested run:** the first implementation invocation ends
  with blocked evidence and releases ownership before the separately invoked
  migration task and joint loop; the second implementation uses a new accepted
  edge and a new provider subprocess.
- **Plan-only projects become unusable:** the ordinary `create-spec` task needs
  only the existing plan, preserves it byte-for-byte, and explicitly requires a
  fresh joint audit before implementation or review.
- **Spec changes accepted under stale evidence:** result-time and current
  eligibility snapshots use the same target-plus-declared-files digest; tests
  exercise successor eligibility rather than only input-fingerprint mutation.
- **Optional research accidentally becomes mandatory:** do not add
  `researchPath` as a required plan-loop file input; trace it in the documents
  and skills only when approved research exists.
- **Outdated architecture blocks deliberate modernization:** require the audit
  to distinguish the baseline from an explicitly documented target transition.
- **Audit loops grow through subjective polish:** only Critical/Major findings
  block, and each must cite a concrete authority.
- **Prompt changes break structural artifact validation:** retain exact decision,
  outcome, ledger table, confidence, and configured output-path language and pin
  it with contract tests.
- **Snapshot fix spreads into workflow-specific logic:** keep the change in the
  generic snapshot/execution/state seams, preserve the v1 field and reason
  contracts, and add no branching on `plan`, `spec`, or pipeline names.

## Change Log

No implementation entries yet.
