# Plan — Binding-aware pipeline stage state and lineage

## Status

**DRAFT — requires approval through the configured `plan` approval loop before
implementation.**

This plan implements the findings in `docs/dev/research.md`. It is the
controlling target contract for this issue.

## Objective

Make pipeline progression, approval-loop recovery, status presentation, and
durable lineage use explicit binding- and phase-aware semantics so that:

- only an accepted approval evaluation unlocks the next pipeline stage;
- repair completion returns the loop to evaluation and never means approval;
- completed and required-artifact tasks retain their current progression;
- the same predecessor edge is not offered repeatedly;
- execution-time rechecks match displayed eligibility; and
- later activity never retroactively invalidates historically valid
  continuations.

## Scope

This plan covers:

- approval-loop chain-state reduction;
- manifest contract validation for approval-loop phases;
- pipeline stage-completion evidence;
- successor candidate generation and exact-edge replay suppression;
- stage-continuation parent validation;
- same-chain phase/outcome validation;
- loop recovery and suggested-loop status;
- candidate diagnostics and labels; and
- deterministic regression coverage.

## Non-goals

- Do not change automatic repair after a rejected second opinion.
- Do not add a one-shot second-opinion mode.
- Do not choose one accepted independent chain as globally authoritative over
  another accepted independent chain.
- Do not implement qualified-decision operator correction.
- Do not redesign runner recommendations or runner selection.
- Do not change provider adapters, model catalogues, effort, session
  capability, timeout, signal, ownership, or supervisor contracts.
- Do not add automatic downstream transitions.
- Do not migrate or specially classify legacy artifacts lacking the v1
  identity contract.

## Normative decisions

### D1. Approval is phase-specific

An approval-loop stage is complete only when one of its independently valid
chains currently ends in a classified `evaluate` artifact whose normalized
decision is `accepted`.

`repair/completed` and `repair/valid` are intermediate chain states. They
permit evaluation and never unlock a pipeline successor.

### D2. Task completion is contract-specific

A task stage completes when:

- its `completion-artifact` classifies as `completed`; or
- its `required-artifact` is classified, contract-valid, and passes its named
  validator.

`blocked`, `unknown`, unclassified, or validator-failing tasks do not complete.

### D3. Chain state is causal, not filename-based

Reduce one chain using parent identity, phase, version, and normalized
contract result. Do not infer workflow order from filename categories,
provider names, literal verdict words, or mtime alone.

Impossible branches, duplicate positions, or illegal transitions fail closed
as `conflict` or `unknown`.

### D4. Independent chains remain independent

Primary approval and second-opinion runs have distinct chain IDs. An accepted
artifact from each may remain a separate successor candidate.

A retry or repair in one chain cannot itself become an accepted candidate.
This plan does not redefine whether activity in one independent chain
supersedes another chain.

### D5. Exact pipeline edges are single-use

Do not offer a predecessor artifact as a candidate when a classified root in
the immediate successor stage already names that artifact as
`parentArtifactIdentity`.

This suppresses accidental replay of the exact edge while preserving a
separate candidate from a different accepted chain. A future explicit rerun
feature would require its own contract and is not inferred here.

### D6. Present eligibility and historical validity are separate

Current candidate eligibility considers current target fingerprints,
unresolved chain state, and exact-edge consumption.

Historical lineage validation asks whether the recorded parent was
completion-capable for its binding and correctly anchored the successor when
created. It must not re-evaluate the parent against later unrelated chain
activity or current target contents.

### D7. TOCTOU remains fail-closed

After operator selection, rescan and recompute the selected candidate through
the same current eligibility function used to display it. The final such
recheck lives in `smashAction` immediately before the selected adapter's
`run(...)` invocation (the provider-spawn boundary); no eligibility-sensitive
work may follow it. Runner resolution and ownership setup may precede that
final recheck. This defines the guarantee boundary: mutations after the final
recheck and before the operating system actually creates the provider process
remain an unavoidable process-spawn race and are not represented as an
accepted eligibility decision.

Any changed decision, new exact-edge consumer, target drift, invalid evidence,
or conflict aborts the selection without provider execution.

### D8. Approval-loop manifests express approval semantics

Manifest validation requires:

- `evaluate.output.contract: decision-artifact` with configured accepted and
  retry tokens;
- `repair.output.contract` to be a non-decision contract supported by repair;
- task output contracts to remain `completion-artifact` or
  `required-artifact`;
- a `required-artifact` `validator` to name a supported validator — an unknown
  name fails manifest load instead of being silently ignored
  (`implement-ledger` is the only supported name) — and no `validator` on
  `decision-artifact` or `completion-artifact` contracts, where it would be
  silently unused; and
- binding IDs unique across loops and tasks, so ID-keyed state maps stay
  unambiguous by kind.

The runtime must no longer treat `valid` or `completed` evaluation output as
approval.

### D9. Unknown evidence never advances

An invalid or unclassified output cannot become completion evidence. When an
invalid routed artifact can be attributed to the active chain position, that
chain resolves to `unknown` and stops. Less-specific unclassified artifacts
remain visible warnings but are never guessed into a pipeline identity.

## Target architecture

### A. Approval-loop state reducer

Add `src/approval-loop-state.ts` with a pure reducer that accepts classified
and relevant unclassified steps for one chain.

Its input phase domain is exactly `evaluate | repair | task`. Legacy
`StepKind` values (`audit`, `follow-up`, and `implement`) are not chain-state
inputs: a supplied value fails closed as `unknown` rather than being coerced
into an approval phase. v1 manifest artifacts reach the reducer only through
their declared output-pattern phase.

It owns:

- legal phase/outcome transitions;
- terminal versus resumable state;
- next required phase;
- conflict detection; and
- stable reason codes.

Required states:

```ts
type ApprovalChainState =
  | { kind: 'not-started' }
  | { kind: 'repair-required'; evaluate: Step }
  | { kind: 'evaluation-required'; repair: Step }
  | { kind: 'accepted'; evaluate: Step }
  | { kind: 'blocked'; artifact: Step; reason: string }
  | { kind: 'unknown'; artifact?: Step; reason: string }
  | { kind: 'conflict'; artifacts: Step[]; reason: string };
```

The reducer must be generic over binding identity and normalized results. It
must not know workflow names such as `plan` or `review`.

### B. Pipeline stage-state rules

Add `src/pipeline-stage-state.ts` with pure functions for:

1. `completionEvidenceForStage(...)`
   - resolves the stage binding through the manifest;
   - uses the approval reducer for loops;
   - applies the declared output contract for tasks.

2. `pipelineStageCandidates(...)`
   - evaluates completion-capable evidence;
   - applies expected-predecessor, pipeline/run/stage, target-fingerprint, and
     exact-edge-consumption checks;
   - returns eligible and unavailable candidates with reason codes.

3. `validateContinuationParent(...)`
   - validates the recorded parent by binding/phase semantics and immediate
     pipeline lineage;
   - intentionally excludes current fingerprint and later-chain state.

`src/pipeline-state.ts` may retain identity, hashing, and run-context
responsibilities, but it must stop owning a second generic completion
predicate. Move or delegate candidate semantics cleanly; do not create a
generic helper bucket.

`Candidate` (or a distinct unavailable-candidate variant) must gain a typed
`reason` / `unavailableReason` code. `evidence` remains diagnostic context;
rendering and execution consume the typed code rather than deriving a reason
from booleans.

### C. Rich artifact input

The candidate and validator inputs must retain:

- `bindingKind`;
- `bindingId`;
- phase (`evaluate`, `repair`, or `task`);
- declared task/step contract where needed;
- chain ID and chain mode;
- pipeline, run, and stage IDs;
- version and artifact identity;
- parent artifact identity;
- normalized decision/completion result;
- contract validity and unclassified state;
- result fingerprint; and
- artifact path for diagnostics.

Do not reduce a `Step` to decision/completion booleans before invoking the
domain rule.

### D. Consumer alignment

Use the new reducers in:

- `src/next-step.ts` for candidate and unavailable-state construction. Delete
  its unused `resolveNextStep`, `NextStepState`, `NextStepDecision`, and
  `NextStepInput` exports, and remove their cases from
  `tests/next-step.test.ts`; this historical decision-only restart rule has no
  production callers and must not become a second owner of loop progression;
- `src/commands/smash.ts` for the execution-time recheck;
- `src/artifact-index.ts` for continuation and same-chain validation;
- `src/loop-selector.ts` for **Continue current loop** availability;
- `src/project-snapshot-view.ts` for suggested-loop explanations; and
- `src/loops/binding-engine.ts` for initial continuation phase, removing its
  parallel reconstruction logic unconditionally.

Rendering modules consume typed reasons; they do not reimplement decisions.

## Implementation releases

### Release 1 — Domain contracts and manifest constraints

1. Add the pure approval-chain reducer.
2. Add binding-aware stage completion and historical-parent rules.
3. Extend or replace `ArtifactRecord` so phase and binding semantics survive.
4. Constrain approval-loop evaluate/repair contract combinations at manifest
   load, reject unknown or misplaced `validator` names, and reject loop/task
   binding-ID collisions — each fails closed at load instead of being silently
   ignored.
5. Narrow binding-engine evaluation acceptance to normalized `accepted`.
6. Add unit matrices before wiring operator actions.

Release 1 must preserve current production behavior for the packaged manifest
except that impossible custom approval-loop contracts fail at load time.

### Release 2 — Stateless scan, recovery, and lineage

1. Replace the generic continuation-parent predicate in
   `src/artifact-index.ts`.
2. Validate legal same-chain approval transitions.
3. Route loop recovery and next-phase selection through the approval reducer.
4. Align `bindingHasInProgressChain` and project-snapshot suggested-loop
   reasons.
5. Preserve classified historical successor artifacts when later independent
   chain activity occurs.

Release 2 must prove restart behavior at each durable boundary:

- after retry evaluation;
- after completed repair;
- after accepted evaluation;
- after blocked repair; and
- after invalid/unclassified output.

This release deletes the unused parallel `resolveNextStep` restart rule in
`src/next-step.ts` and its focused tests; `approval-loop-state.ts` is the sole
owner of approval-loop next-phase semantics.

### Release 3 — Candidate eligibility, replay, and operator evidence

1. Replace candidate generation with binding-aware completion evidence.
2. Exclude every repair artifact from loop-stage completion.
3. Suppress an exact predecessor edge already consumed by the successor.
4. Preserve separate eligible candidates from distinct accepted chains.
5. Return unavailable candidates with explicit reasons for status.
6. Apply the identical resolver during the pre-spawn TOCTOU recheck in
   `smashAction`, immediately before `adapter.run(...)`; retain or move any
   earlier interactive confirmation check only as an early usability check,
   never as the final authorization.
7. Include predecessor binding kind, phase, normalized result, chain identity,
   and consumption/fingerprint state in labels and detailed status.

No release may temporarily make repair artifacts eligible.

### Release 4 — Documentation and release verification

1. Synchronize `AGENTS.md`, `README.md`, and
   `docs/architecture/overview.md` with: the configured linear
   `plan -> implement -> review` pipeline; approval-loop progression being
   exclusively `evaluate/accepted`; repair's resumable-but-not-successor role;
   the reducer/stage-state ownership boundaries; the displayed
   **Start suggested stage** eligibility and reason diagnostics; exact-edge
   single-use and historical-lineage behavior; and the operator-workaround
   removal condition below. Remove or correct any description of generic
   `accepted || completed || contractValid` completion.
2. Retain the operator workaround until all acceptance gates pass.
3. Run deterministic gates and the existing provider contract gates affected
   by shared binding execution.
4. Audit the completed plan and archive implementation evidence according to
   the configured workflow.

## Required test matrix

### Approval-loop reducer

- Empty chain -> `not-started`.
- Retry evaluation -> `repair-required`.
- Retry evaluation plus completed repair -> `evaluation-required`.
- Retry evaluation plus valid required-artifact repair ->
  `evaluation-required`.
- Accepted evaluation -> `accepted`.
- Blocked repair -> `blocked`.
- Invalid evaluation or repair -> `unknown`.
- Repair after accepted evaluation -> conflict/unclassified.
- Evaluation after retry without repair -> conflict/unclassified.
- Duplicate or competing same-chain positions -> conflict.
- Legacy `audit`, `follow-up`, or `implement` phase supplied to the reducer ->
  fail-closed `unknown` with a stable reason code.
- Custom accepted/retry tokens normalize without literal-token branching.

### Pipeline candidates

- Accepted loop evaluation unlocks the immediate successor.
- Rejected loop evaluation does not unlock it.
- Completed repair does not unlock it.
- Completed repair followed by another rejected evaluation does not unlock it.
- An older completion-looking artifact in the same unresolved chain is not
  eligible.
- Completed completion-artifact task unlocks its successor.
- Blocked completion-artifact task does not unlock it.
- Valid required-artifact task unlocks its successor.
- Validator-failing required artifact does not unlock it.
- Unclassified and identity-invalid artifacts never unlock a successor.
- Foreign pipeline/run/stage evidence is excluded.
- Stale target fingerprints produce an unavailable candidate with a reason.
- Distinct accepted chains remain distinct candidates.
- An exact predecessor already consumed by a successor root is not offered
  again.
- Consumption in another pipeline run does not suppress the candidate.

### Historical lineage

- A successor rooted at `loop/evaluate/accepted` remains classified.
- A successor rooted at `loop/repair/completed` is unclassified.
- A successor rooted at a completed task remains classified.
- A successor rooted at a valid required-artifact task remains classified.
- Wrong pipeline, run, stage, binding, or parent identity is unclassified.
- A later independent rejected second opinion does not retroactively
  unclassify an existing valid successor.
- Later target drift suppresses new candidates but does not rewrite historical
  lineage.

### Recovery and menus

- Retry evaluation enables **Continue** with repair next.
- Completed repair enables **Continue** with evaluation next.
- Accepted evaluation disables **Continue** and permits second opinion.
- Unknown/conflict never recommends a fresh transition as though complete.
- Status and menu use the same reason/state returned by the reducer.
- The second-opinion rejected -> repair behavior remains unchanged.

### TOCTOU and execution

- A candidate accepted at display but followed by a retry before confirmation
  is rejected before spawn.
- A candidate consumed by another successor before confirmation is rejected
  before spawn.
- Target modification before confirmation is rejected before spawn.
- No failed recheck invokes an adapter or writes a successor artifact.
- A successful recheck binds exactly the selected predecessor identity.
- Mutation after interactive confirmation but before the `smashAction`
  adapter-run boundary is rejected by the final recheck; a test seam asserts
  that the eligibility recheck is the last eligibility gate before
  `adapter.run(...)`.

### Manifest validation

- Approval evaluate with completion-artifact is rejected.
- Approval evaluate with required-artifact is rejected.
- Approval repair with decision-artifact is rejected.
- An unknown `validator` name on a required-artifact is rejected at load.
- A `validator` on a decision-artifact or completion-artifact contract is
  rejected at load.
- A loop and a task sharing the same textual ID are rejected at load.
- Packaged plan and review loops remain valid.
- Tasks retain completion-artifact and required-artifact support.

## Existing tests requiring correction

- Replace the mislabeled required-artifact case in
  `tests/pipeline-state.test.ts` with separate completion-task and
  required-artifact-task cases.
- Strengthen `tests/next-step.test.ts` to assert exact candidates and reasons,
  not merely `Array.isArray`, including the typed unavailable reason field.
- Refine the multiple-candidates smash-action test to state that candidates
  come from distinct accepted chains and add a separate exact-edge replay
  suppression test.
- Extend artifact-index validation with phase/outcome legality and a
  repair-parent rejection.
- Add parity tests proving status display and execution recheck consume the
  same domain result.
- Add a structural regression test (in `tests/pipeline-state.test.ts` or a
  dedicated focused test) that scans `src/` and fails if either forbidden
  generic-completion predicate shape — `completionOutcome === 'completed'` as
  a loop-success shortcut, or `contractValid === true && decision ===
  undefined && completionOutcome === undefined` — appears outside the
  contract-specific task branch in `pipeline-stage-state.ts`. Pair it with a
  focused spy/seam assertion that `pipelineStageCandidates` obtains loop
  completion only from `completionEvidenceForStage` and excludes every repair
  artifact regardless of `completionOutcome`.
- Add `tests/manifest.test.ts` cases proving unknown `validator` names,
  validators on decision/completion contracts, and loop/task binding-ID
  collisions each fail at load while the packaged manifest stays valid.

## Verification commands

At minimum:

```text
pnpm typecheck
pnpm build
pnpm test
pnpm test tests/pipeline-state.test.ts
pnpm test tests/artifact-index-validation.test.ts
pnpm test tests/loop-selector.test.ts
pnpm test tests/next-step.test.ts
pnpm test tests/smash-action.test.ts
```

Run the deterministic fake-adapter end-to-end gates, including dual-target
isolation and mixed-runner loops. Because the binding engine and artifact scan
are shared by real providers, run the existing env-gated opencode, codex, and
claude contract checks during release sign-off; no new provider-specific
behavior is introduced. AGY requires only its existing deterministic seam and
manual authenticated verification policy.

## Acceptance gates

1. No code path defines generic stage completion as
   `accepted || completed || contractValid`; the structural regression guard
   and completion-evidence seam test enforce this, not behavioral coverage
   alone.
2. Approval-loop successor eligibility comes only from
   `evaluate/accepted`.
3. Repair completion remains resumable but never successor-eligible.
4. Both completion-artifact and required-artifact task progression pass;
   unknown or misplaced validator names and loop/task binding-ID collisions
   fail at manifest load.
5. Display, execution recheck, recovery, and lineage use the intended domain
   rule with explicit parity tests.
6. Exact-edge replay is suppressed without collapsing distinct accepted
   chains.
7. Historical valid continuations survive later independent activity and
   target drift.
8. Unknown, conflict, and unclassified evidence fail closed with a visible
   reason.
9. Second-opinion automatic repair is unchanged.
10. Typecheck, build, deterministic tests, focused regressions, and release
    contract gates pass.

## Deferred hardening (closed second-opinion findings)

The second-opinion audit chain on this plan (v3–v5; artifacts removed from the
audit trail) raised the following items. They are recorded here as
accepted-risk deferrals matched to current single-operator usage — not as
requirements of this plan — and each may become its own planned issue if usage
grows into it:

- **Provider-spawn authorization seam.** A one-shot
  `authorizeStageContinuation` callback threaded through `LoopOptions`,
  `runBinding`, and `executeLoopStep`, plus a first-class `eligibility-lost`
  outcome route. Deferred: D7's rescan-and-recompute recheck in `smashAction`
  immediately before `adapter.run(...)` covers the interactive single-operator
  risk; the callback threading and new outcome route are disproportionate to
  current usage.
- **Exact-`chainId` multi-chain recovery.** Per-chain resumable candidates
  replacing the boolean `bindingHasInProgressChain`, with an explicit operator
  choice when one binding has several resumable chains. Deferred: the reducer
  classifies each chain correctly on its own artifacts; multiple concurrently
  resumable chains on one binding are rare in single-operator use.
- **Permutation-invariant chain reduction.** Deriving causal order from
  parent-identity links independent of scanner order. Deferred: the scanner
  already validates immediate-parent linkage within each chain and fails closed
  on inconsistency; adversarial mtime or copied-artifact ordering is outside
  the current threat model.
- **Discriminated candidate-result union.** Per-reason required/forbidden
  field cardinality, reason-precedence tables, and canonical-sort contracts.
  Deferred: the typed `reason`/`unavailableReason` code (Target architecture B)
  carries the diagnostic without the cardinality machinery.

These items are closed for the approval of this plan; reopening any of them
requires its own research and plan cycle.

## Operator safety until release

Do not use **Start suggested stage** for an approval-loop predecessor unless
the displayed artifact is a classified `evaluate/accepted` artifact. Never
advance from `repair/completed`. For a retry evaluation, use **Continue current
loop** until a new accepted evaluation exists.
