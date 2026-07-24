# Research — Binding-aware pipeline stage state

## Status

Research complete enough to plan implementation. This document records the
current behavior, related defects, compatibility constraints, and the boundary
between present-state eligibility and durable historical lineage.

The corresponding implementation contract is `docs/dev/plan.md`.

## Research question

How should orc-smash decide that a configured pipeline stage is complete,
offer its successor, recover an unfinished approval loop, and validate a
persisted stage continuation without confusing:

- approval-loop evaluation acceptance;
- approval-loop repair completion;
- task completion;
- required-artifact validity;
- current action eligibility; and
- historically valid lineage?

## Executive conclusion

The observed **Start suggested stage** bypass is not an isolated menu defect.
Several modules flatten distinct artifact meanings into the generic predicate:

```ts
decision === 'accepted'
  || completionOutcome === 'completed'
  || contractValid
```

That predicate is valid only for a subset of task contracts. It is not a
definition of approval-loop completion.

The safe correction requires two domain reducers and one historical validator:

1. reduce an approval-loop chain to its current semantic state;
2. resolve binding-aware successor candidates from those chain states; and
3. validate a continuation parent by the semantics that applied when the
   continuation was created, without consulting later unrelated state.

Using one undifferentiated "latest completion" predicate for all three would
either preserve the bypass or retroactively invalidate legitimate history.

## Observed production defect

The `plan` stage contained:

```text
plan evaluation v4 -> retry
plan repair v4 -> completed
plan evaluation v5 -> retry
```

The application offered:

```text
plan repair v4/completed -> start implement
```

The repair artifact proved only that the repair invocation completed. It did
not prove that the repaired plan was evaluated and accepted. Starting
`implement` from it would bypass the unresolved v5 rejection.

## Current system map

### Artifact discovery and classification

`src/artifact-index.ts`:

- discovers files from manifest output patterns;
- validates provenance identity and binding/stage routing;
- classifies decision, completion, and required-artifact contracts;
- validates pipeline and same-chain parent structure; and
- constructs the stateless global snapshot.

The snapshot retains the phase as `Step.kind` (`evaluate`, `repair`, or
`task`), but downstream pipeline eligibility drops that field.

### Pipeline candidate resolution

`src/next-step.ts` maps snapshot steps into `ArtifactRecord` and calls
`pipelineStageCandidates` / `eligibleNextStages` in
`src/pipeline-state.ts`.

`ArtifactRecord` currently lacks the binding kind, binding ID, and artifact
phase required to distinguish:

- `loop/evaluate/accepted`;
- `loop/repair/completed`;
- `task/completion-artifact/completed`; and
- `task/required-artifact/valid`.

`pipelineStageCandidates` selects every artifact in a pipeline run/stage that
matches the generic predicate. It does not first reduce the artifact's
approval chain to a current state.

### Interactive execution gate

`src/commands/smash.ts` shows the candidates, lets the operator select one,
then recomputes eligibility before execution. This is a valuable TOCTOU gate,
but it invokes the same incorrect resolver, so a new rejected evaluation does
not invalidate an older repair candidate.

### Durable lineage validation

`src/artifact-index.ts` validates a `stage-continuation` root by checking that
its parent:

- is classified;
- belongs to the same pipeline run;
- belongs to the immediate predecessor stage; and
- matches the same generic completion predicate.

This admits a repair artifact as a continuation parent. It also means fixing
candidate display alone would leave an already-created invalid continuation
classified on the next scan.

### Approval-loop recovery and presentation

`src/loop-selector.ts` and `src/project-snapshot-view.ts` treat the latest
`completionOutcome === 'completed'` as terminal. After a durable repair
artifact, however, an approval loop is awaiting its next evaluation.

The binding engine already contains more accurate continuation logic:

- latest rejected evaluation without matching repair -> repair next;
- matching completed repair -> evaluation next;
- accepted evaluation -> complete.

That logic is local to `src/loops/binding-engine.ts` and is not the shared
state contract used by menus, status, and pipeline eligibility.

## Findings

### F1 — Approval-loop repair can unlock a successor

**Confirmed, high severity.**

`pipelineStageCandidates` treats `repair/completed` as stage completion. This
can execute a downstream task or loop before the approval loop is accepted.

### F2 — The same error exists in persisted-lineage validation

**Confirmed, high severity.**

The scanner accepts a stage-continuation root whose parent is a completed
repair. A candidate-only patch would therefore be incomplete.

### F3 — Historical artifacts remain reusable candidates

**Confirmed behavior requiring a narrower rule.**

Candidate resolution collects every completion-bearing predecessor artifact.
It does not check whether the exact predecessor artifact has already been used
as the parent of a classified successor-stage root. If its target fingerprint
still matches, the same pipeline edge can be started repeatedly.

Independent accepted chains in the same stage are currently presented as
separate operator choices. This behavior is covered by an existing test and
must not be removed implicitly while fixing exact-edge replay.

### F4 — Completed repair can hide an in-progress chain

**Confirmed latent recovery defect.**

`bindingHasInProgressChain` returns false when the latest artifact is a
completed repair. The loop is not terminal; its next semantic phase is
evaluation. This can make **Continue current loop** unavailable after a
restart or interruption boundary that leaves the repair durable.

The project snapshot repeats the same false-terminal interpretation in its
suggested-loop reason.

### F5 — Approval-loop contract combinations are under-constrained

**Confirmed for custom manifests.**

The manifest gives both evaluate and repair steps the generic `OutputSchema`.
The binding engine consequently treats an evaluate step returning `valid` or
`completed` as accepted.

For an `approval-loop`:

- evaluate must use `decision-artifact`;
- repair may use a non-decision completion contract;
- only the configured accepted decision can complete the loop.

The packaged manifest already follows this shape, so validation can fail bad
custom manifests at load time instead of supporting ambiguous runtime
semantics.

### F6 — Same-chain validation checks identity shape, not legal transitions

**Confirmed structural gap.**

After the stage-continuation root, the scanner requires the immediate parent
to exist in the same chain, but does not validate semantic transitions such
as:

```text
evaluate/retry -> repair/completed -> evaluate
```

The normal executor writes legal transitions, so this is primarily a durable
state-reconstruction gap. The state store should not classify impossible
phase/outcome sequences as valid workflow evidence.

### F7 — The current tests do not protect the required semantics

**Confirmed coverage gap.**

- `tests/pipeline-state.test.ts` has no rejected-evaluate/repair/re-evaluate
  matrix.
- Its test named "required-artifact predecessor" supplies
  `completionOutcome: completed` rather than a required artifact with only
  `contractValid: true`.
- `tests/next-step.test.ts` has a case that asserts only that the result is an
  array.
- `tests/smash-action.test.ts` intentionally preserves multiple candidates in
  one run, but does not distinguish independent accepted chains from replay
  of the same predecessor edge.
- There is no regression proving that display and execution-time rechecks
  resolve the same current chain state.

The focused pipeline, lineage, selector, and smash-action suite currently
passes, demonstrating that the defect is not caught by existing assertions.

## Semantics that currently work and must remain

- A configured accepted evaluation completes an approval-loop chain.
- A configured retry evaluation enables repair, not a downstream stage.
- A completed repair enables the next evaluation in the same chain.
- A blocked or unknown repair does not advance the loop.
- A completed task using `completion-artifact` can unlock its successor.
- A valid task using `required-artifact` can unlock its successor.
- Blocked, unknown, unclassified, foreign-run, wrong-stage, and stale-target
  evidence cannot unlock a successor.
- The interactive selection is rechecked against a fresh snapshot before
  provider execution.
- A second opinion is a fresh, independent chain root and a rejected second
  opinion continues automatically into repair.
- Historical artifacts remain immutable evidence; later activity must not
  retroactively rewrite or unclassify a continuation that was valid when
  created.

## Required semantic boundaries

### 1. Current approval-chain state

Reduce artifacts within one chain, preserving causal order:

| Latest legal chain state | Chain state | Next action |
| --- | --- | --- |
| no artifact | not-started | evaluate |
| evaluate/retry, no valid repair | repair-required | repair |
| evaluate/retry -> repair/completed or valid | evaluation-required | evaluate |
| evaluate/accepted | accepted | successor may be offered |
| evaluate/unknown or unclassified routed output | unknown | stop |
| repair/blocked | blocked | stop |

A repair is never an accepted state.

### 2. Binding-aware completion evidence

| Stage binding | Completion-capable evidence |
| --- | --- |
| approval loop | the chain's current valid `evaluate/accepted` artifact |
| completion-artifact task | valid `task/completed` |
| required-artifact task | valid classified task artifact satisfying its validator |

The decision tokens remain manifest-configured; TypeScript consumes normalized
`accepted` / `retry` values and does not branch on literal verdict words.

### 3. Current candidate eligibility

A successor candidate requires:

- a completion-capable predecessor artifact;
- the expected immediate predecessor stage;
- matching pipeline and pipeline-run identity;
- a current target fingerprint matching the predecessor result fingerprint;
- no unknown/unclassified barrier attributable to that same chain state; and
- no already-classified successor-stage root whose
  `parentArtifactIdentity` is that exact predecessor artifact.

Independent accepted chains may yield independent candidates. The fix does not
choose a winner between primary approval and second-opinion chains.

### 4. Historical continuation validity

A persisted successor root is valid when its recorded parent:

- is classified and contract-valid;
- is completion-capable for the parent stage's binding;
- belongs to the expected pipeline, run, and predecessor stage; and
- predates and directly anchors that successor root.

Historical validation must not ask whether the parent is still the currently
recommended candidate. A later independent second opinion or later target
change may suppress new transitions but must not corrupt valid recorded
history.

### 5. Same-chain transition validity

For approval loops, classified descendants must follow:

```text
evaluate/retry -> repair/(completed|valid) -> evaluate
```

`evaluate/accepted`, unknown, and blocked are terminal for that chain.
Second opinions start a new chain and are not descendants of the accepted
primary chain.

## Ordering and ambiguity

Normal executor output provides causal order through:

- immediate parent identity;
- version;
- phase;
- chain identity; and
- artifact identity.

Filesystem mtime must not be the sole workflow authority. When two artifacts
claim an impossible competing position in the same chain, the reducer should
return an explicit `conflict`/`unknown` state and fail closed rather than pick
one by filename, provider, or mtime.

## Second-opinion boundary

This work does not change second-opinion execution policy.

- A second opinion remains an independent chain root.
- Rejection still enters normal repair automatically.
- An accepted primary chain and an accepted second-opinion chain may remain
  separately visible evidence.
- This work does not introduce a one-shot second-opinion mode.

Only the state reducer is shared: a rejected second-opinion chain cannot
present its own repair as accepted completion.

## Recommended architecture

Introduce purposeful pure domain modules:

- `src/approval-loop-state.ts` — validates/reduces one approval chain and
  resolves its next phase;
- `src/pipeline-stage-state.ts` — classifies binding-aware completion evidence,
  resolves candidates, detects exact-edge replay, and validates historical
  continuation parents.

Do not introduce generic `helpers.ts` or a global boolean such as
`isCompleted`. The return types should carry semantic reasons suitable for
status, menu disablement, diagnostics, and tests.

Suggested result shapes:

```ts
type ApprovalChainState =
  | { kind: 'not-started' }
  | { kind: 'repair-required'; evaluate: Step }
  | { kind: 'evaluation-required'; repair: Step }
  | { kind: 'accepted'; evaluate: Step }
  | { kind: 'blocked'; artifact: Step; reason: string }
  | { kind: 'unknown'; artifact?: Step; reason: string }
  | { kind: 'conflict'; artifacts: Step[]; reason: string };

type StageCompletionEvidence =
  | { kind: 'eligible'; artifact: Step; bindingKind: 'loop' | 'task' }
  | { kind: 'incomplete'; reason: string }
  | { kind: 'unknown'; reason: string };
```

The exact types may be refined during implementation, but phase, binding kind,
chain identity, and reason must not be erased before the decision is made.

## Risks

### Over-sharing the current-state rule

If historical lineage uses today's latest state, a later second opinion could
retroactively unclassify a previously valid implementation. Avoid this by
keeping historical parent capability separate from current candidate
eligibility.

### Over-deduplicating candidates

Collapsing all accepted artifacts to one "latest stage result" would silently
remove the existing independent-chain choice. Deduplicate only an exact
already-consumed predecessor edge unless a later product decision explicitly
changes second-opinion selection.

### Breaking task progression

Removing the generic fallback without adding explicit task semantics would
prevent required-artifact tasks from unlocking successors. Task contract type
must be an input to the new rule.

### Partial wiring

Fixing only menu display, only candidate collection, or only scanner lineage
would leave inconsistent state decisions. All consumers must move to the
domain rules in one release sequence with parity tests.

## Operator workaround until implementation

For approval-loop predecessors, use **Start suggested stage** only when the
displayed predecessor artifact is a valid `evaluate/accepted` artifact.
Never advance from a repair artifact. When a loop has a retry evaluation,
choose **Continue current loop** and complete repair plus re-evaluation first.

