# Config-Driven Loops, Tasks, Pipelines, and Continuity

## Direction

The right abstraction is not a completely generic workflow engine. It is:

- reusable skills;
- two-step approval loops;
- one-off tasks;
- linear pipelines composed from both;
- independent per-skill runner and continuity policies.

This provides flexibility without turning orc-smash into a general-purpose
workflow orchestrator.

## What Already Exists

A substantial part is already present in `skills.yaml`:

- Named roles linked to files.
- Named skills linked to a role, skill file, and runner profile.
- Configurable loop names.
- Audit and follow-up skill selection.
- Output filename patterns.
- Prompt input declarations.
- Per-skill default runners.

However, it is not yet a true user or project configuration:

- `config.ts` prefers the packaged `skills.yaml`; a project-local manifest is
  effectively only a fallback.
- `manifest.ts` accepts only three hardcoded loop types.
- Skills themselves are typed as `audit`, `follow-up`, or `implement`.
- Verdicts are hardcoded to `APPROVED | REJECTED`.
- The plan -> implement -> review pipeline is hardcoded by loop name.
- Decision-path scanning is split between audit/follow-up-specific scanning and
  separate implementation scanning. Cross-loop chronological status aggregation
  already exists, but there is no single generic artifact index driven by
  configurable loop and task output contracts.
- The action menu is built from hardcoded phases.
- Session support is hardcoded to provider names rather than provider
  capabilities.

The chains are therefore coded into the runtime rather than constructed from
configuration.

## Preserved Runtime Boundaries

The architecture change must not remove or weaken the existing logging, error
detection, ownership, timeout, interruption, or provider-process safety
features.

Preserve both existing logging layers:

- canonical typed runtime events consumed by plain and panel output;
- detailed provider-spawn and harness diagnostics written when debug logging is
  enabled.

The orchestration vocabulary may become generic, for example
`verdict.parsed -> decision.parsed`, `iteration.started -> round.started`, and
`plan.closeout -> stage.completed`. This is an event-schema migration, not a
reduction in logging. New events should carry the applicable `pipelineId`,
`pipelineRunId`, `stageId`, `chainId`, `loopId` or `taskId`, `skillId`, provider,
model, effort, session strategy, and session ID.

Every error must produce a concise visible event. When debug logging is
enabled, the detailed process and harness evidence must also be written to the
configured file. The debug flag controls additional diagnostic detail; it must
not hide the existence of an error from the screen.

## Recommended Conceptual Model

### 1. Skills are reusable, opaque units

A skill should define only its durable identity and defaults:

```yaml
skills:
  plan-auditor:
    file: skills/plan-audit/SKILL.md
    role: auditor
    runnerProfile: audit
```

Do not permanently classify the skill itself as `audit`, `follow-up`, or
`implement`. The workflow binding should decide what the skill does. This
allows the same skill to be reused in different contexts.

### 2. Define one generic two-skill approval loop

Use neutral internal names:

- `evaluate`
- `repair`

The UI can still display configured terms such as audit, review, or follow-up.

```yaml
loops:
  plan:
    type: approval-loop
    target: docs/dev/plan.md

    evaluate:
      skill: plan-auditor
      output: docs/dev/plan-audit-v{version}-{provider}.md
      decision:
        heading: Verdict
        accepted: APPROVED
        retry: REJECTED

    repair:
      skill: plan-repair
      output: docs/dev/plan-followup-v{version}-{provider}.md
```

Configured decision tokens map to canonical internal states:

```text
accepted
retry
unknown
```

Users can change `APPROVED` and `REJECTED`, while the runtime state machine
remains stable. This is safer than allowing arbitrary state machines.

### 3. Separate one-off tasks

Use a separate task section rather than forcing single-invocation work into
half of an approval loop:

```yaml
tasks:
  implement:
    skill: implement-plan
    output: docs/dev/impl-v{version}-{provider}.md

  update-docs:
    skill: update-docs
    output: docs/dev/docs-update-v{version}-{provider}.md

  investigate-loop:
    skill: investigate-rejection-cycle
    output: docs/dev/loop-investigation-v{version}-{provider}.md
```

A task runs once and returns to the action menu. `Execute one-off task` should
show configured tasks, not every raw skill, because a raw skill may lack the
input and output configuration required for safe execution.

### 4. Pipelines are linear configuration

```yaml
pipelines:
  default:
    stages:
      - loop: research
      - loop: plan
      - task: implement
      - loop: review
```

Keep pipelines linear initially. Avoid arbitrary graphs, conditional branches,
parallel stages, and dependencies.

The approval loop already provides the branching required by the current
product:

```text
evaluate -> accepted -> stage complete
         -> retry -> repair -> evaluate
```

## Pipeline-State Correctness

Selecting the suggested next stage only from the most recent approved document
is feasible but unsafe. An old plan approval could incorrectly advance a newly
drafted plan to implementation. Filenames and modification times do not prove
that an approval belongs to the current pipeline run.

Artifacts should carry provenance such as:

```yaml
pipeline: default
pipelineRunId: ...
stage: plan
chainId: ...
step: evaluate
version: 4
provider: claude
model: ...
effort: ...
sessionStrategy: resume-per-skill
sessionId: ...
inputFingerprint: ...
```

orc-smash can remain stateless because artifacts remain the durable state, but
the metadata must distinguish:

- an approval that does not satisfy the current artifact identity contract;
- a newly started loop;
- a fresh pipeline run;
- an approval for the current target revision;
- a second-opinion chain.

Automatic next-stage selection or execution must not be implemented. Once this
identity exists, the application may calculate an explainable suggestion that
the operator remains free to accept or ignore.

Initially, the application should make an explainable suggestion:

```text
Suggested: implement
Reason: plan stage was approved by plan-audit-v4-claude.md
```

The suggestion must include its evidence, such as the pipeline, previous stage,
completion artifact, decision, and matching input fingerprint. It should never
automatically select or start the suggested stage. The operator confirms it or
chooses another loop or task.

## Global Project Snapshot

Scan every artifact pattern declared by every configured loop and task into one
artifact index. The main screen can then show:

```text
Research
  latest evaluation: research-audit-v3-codex.md - APPROVED
  evaluation runner: codex / gpt-5.6-terra / effort: xhigh
  latest repair: research-followup-v2-claude.md
  repair runner: claude / opus-4.6 / effort: high

Plan
  latest evaluation: plan-audit-v4-claude.md - APPROVED
  evaluation runner: claude / opus-4.6 / effort: high
  latest repair: plan-followup-v3-codex.md
  repair runner: codex / gpt-5.6-luna / effort: provider default

Implement
  latest execution: none

Review
  latest evaluation: none
```

This should be global information. Selecting a loop should filter or emphasize
it, not determine what the scanner knows exists.

Only files that match a configured pattern and satisfy the corresponding
artifact contract should be interpreted as valid workflow artifacts. Every
other file, including artifacts produced by an older format, is handled exactly
like any other invalid or unclassified artifact. It must not advance a
pipeline, establish stage completion, enable continuation, or provide a
resumable session.

## Recommended Action Menu

Use a small top-level action menu:

```text
Start loop
Execute one-off task
Change loop
Display pipeline and project state
Stop for manual review
```

After `Start loop`:

```text
Continue current loop
Start fresh loop
Back
```

Rules:

- Every action remains visible. An unavailable action is disabled and displays
  a concrete reason; menu construction must never filter it out.
- `Continue` remains visible but is unavailable after approval because that
  chain is closed.
- `Continue` shows the next skill, artifact version, runner, model, and session
  strategy, including effort when configured.
- `Fresh` creates a new `chainId` and does not inherit provider sessions.
- Artifact version numbers continue increasing to avoid filename collisions,
  even when a fresh chain begins.

## Runner and Continuity Selection

Use this selection sequence:

```text
evaluate provider
evaluate model
evaluate effort
evaluate session strategy

repair provider
repair model
repair effort
repair session strategy
```

Each skill gets an independent strategy:

```text
Resume this skill's session on later invocations
Start a fresh session every invocation
```

Do not offer one shared same-chain session setting because it creates
cross-skill provider and model binding.

The full runner identity is `provider + model + optional effort`. Changing any
part of that tuple starts a fresh session. A resumed session must match the
recorded tuple exactly.

Provider capability should come from the adapter:

```ts
capabilities: {
  resumeSession: true | false
}
```

Unsupported choices must remain visible. For Agy, show the resume option greyed
out with an explanation that Agy does not expose supported session resumption.
Likewise, show configurable effort as unavailable with an explanation rather
than hiding the option. The UI should not contain provider-name checks such as
`agent === "agy"`; it renders capability information supplied by the adapter
and provider catalogue.

### Persistence across application restarts

`sessionMode: fresh` is insufficient. A first invocation can be fresh even
though the operator selected resume for later invocations.

Persist both intent and observed execution:

```yaml
sessionStrategy: resume-per-skill
sessionMode: fresh
sessionId: abc123
```

On the next application run, `Continue loop` can reconstruct the intended
behavior from artifact provenance.

## Iteration Budget

Define one iteration as one evaluator invocation. A repair does not consume a
separate iteration; it is part of the rejected round.

Recommended behavior:

- Initial default: four evaluator rounds.
- If the latest result is retry when the budget ends, offer:
  - extend by 3;
  - extend by 5;
  - custom extension;
  - return to menu.
- After each evaluator completes, verify and stamp its artifact, parse the
  decision, and handle acceptance before checking the remaining budget.
- If accepted, including on the final permitted round, close the loop
  immediately and return to the main action menu.
- Do not offer an iteration extension after acceptance.
- If retry is returned on the final permitted round, offer the configured
  extension choices. Extending by 3 after four completed rounds sets the new
  total budget to 7.
- Infrastructure errors and unknown decisions do not count as ordinary budget
  exhaustion; record the error and return to the applicable options menu.

Display both the round and provider-call counts:

```text
Round 3/4 - provider calls 5
```

The required ordering is:

```text
provider completion
-> artifact verification and provenance
-> decision parsing
-> accepted closeout, if accepted
-> budget check, only when retry
```

This prevents final-round approval from becoming an off-by-one failure.

## Controlled Error Handling

Recoverable workflow failures must stop the active step safely, finalize or
retain ownership as appropriate, emit the canonical error event, preserve
debug evidence, and return to the relevant options menu. This includes
authentication failures, timeouts, spawn failures, non-zero exits, missing or
invalid artifacts, unknown decisions, invalid output contracts, missing
session IDs, resume mismatches, and unsupported effort or continuity choices.

Safety-critical failures must also cross a controlled error boundary, restore
the terminal, and present a clear explanation, but must not return to the
normal execution menu when continuing cannot be trusted. Invalid configuration,
ownership loss or ambiguity, unsafe artifact identity, event-output failure,
and internal invariant violations should enter a restricted recovery path or
exit safely with a non-zero status. No failure should escape as an unhandled
exception or leave the terminal in a broken state.

## Configuration Location

A real user configuration should have explicit precedence:

```text
--config <path>
project/.orc-smash.yaml
packaged default configuration
```

Relative role and skill paths resolve relative to the configuration file that
contains them.

Provider credentials and machine-specific executable settings remain outside
the project workflow manifest. Workflow structure belongs in the project;
secrets do not.

The new configuration is a clean contract, not a compatibility extension of
the current `skills.yaml`. Require an explicit `schemaVersion`, rewrite the
packaged defaults and test fixtures into the new shape, remove the old schema
and loader, and reject unsupported versions with a clear configuration error.
Do not maintain two manifest formats or two execution engines.

## Deliberate Limits

Do not generalize these areas initially:

- Arbitrary DAGs.
- Parallel stages.
- User-provided JavaScript validators.
- Arbitrary numbers of loop branches.
- Arbitrary verdict state machines.
- Automatically executing the next pipeline stage.
- Making every raw skill directly executable.

Use a small set of built-in output contracts:

- `decision-artifact`
- `completion-artifact`
- `required-artifact`

Special validation such as the implementation evidence ledger can initially
remain a named built-in validator.

## Recommended Delivery Sequence

### Phase 1: Foundational contracts

- Define the new project-local configuration schema with generic skills,
  approval loops, tasks, and linear pipelines.
- Add the complete provider, model, and optional effort runner identity.
- Add adapter capability declarations.
- Preserve typed events, debug logging, ownership, timeout, interruption, and
  process safety as explicit invariants.
- Replace the current schema atomically; do not add a compatibility loader.

### Phase 2: Artifact identity and global index

- Scan all declared outputs once.
- Normalize configured decisions into accepted, retry, and unknown states.
- Add pipeline, stage, chain, input fingerprint, runner, effort, and session
  provenance.
- Treat every artifact that fails the new contract as invalid or unclassified,
  regardless of its age or origin.
- Build the global project snapshot and pipeline display from that index.

### Phase 3: Approval-loop and task engines

- Implement one approval-loop executor.
- Implement one task executor.
- Remove hardcoded plan, implement, and review transitions.
- Add controlled error boundaries that return recoverable failures to menus.

### Phase 4: Operator menus and per-skill continuity

- Discover resume support through provider capabilities.
- Keep every action and capability visible, with disabled reasons.
- Add independent provider, model, effort, and session-strategy selection for
  each skill binding.
- Implement explicit fresh and continue actions.
- Port the existing provider-resume, session-identity, approval-boundary,
  runner-independence, and mismatch-safety tests to the new engine rather than
  deleting the continuity suites wholesale.

### Phase 5: Pipeline display and suggestions

- Add explainable next-stage suggestions.
- Add the iteration extension menu.
- Keep stage selection and execution entirely operator-confirmed.

## Continuity Behavior Migration

The continuity rewrite is a tested-subsystem migration, not merely removal of
two CLI flags. The current implementation contains three different layers that
must be treated separately:

1. The obsolete flag-policy layer: `AuditContinuityPolicy`,
   `applyAuditContinuityPolicy()`, flag-derived arming, menu filtering, and
   cross-skill provider/model binding.
2. Reusable continuity mechanics: provider-native resume, session-ID capture
   and provenance, exact runner matching, approval boundaries, mismatch
   detection, and fresh/resumed execution metadata.
3. Reusable runner-selection behavior: independent evaluate and repair
   runners, up-front selection, inheritance of only the applicable resumable
   runner, prompting for unresolved skills, and one-off selection.

Remove the first layer. Preserve or deliberately reimplement the second and
third layers behind the new generic contracts.

Do not delete `loop-continuity.test.ts` or `loop-followup-runner.test.ts`
wholesale. Classify every existing test as one of:

- port unchanged in behavioral intent;
- rewrite against the generic approval-loop/task engine;
- delete because it protects obsolete or regressive flag-policy behavior.

The following behavioral contracts must survive:

- Codex, OpenCode, and Claude resume the exact recorded session for the
  applicable skill binding.
- Provider, model, or effort mismatch never reuses another runner's session.
- A returned session-ID mismatch fails safely and remains visible.
- Acceptance forms a continuation boundary.
- A second opinion starts fresh.
- Missing or invalid session evidence produces an informed safe outcome.
- Evaluate and repair may use different provider/model/effort tuples.
- Only the applicable skill inherits its own resumable session.
- A one-off task selects only its own runner.

Remove tests whose intended contract is continuity CLI flags, flag-derived
arming, shared evaluate/repair runners, cross-skill session binding, or action
filtering. A passing test is evidence of an implemented behavior, but it does
not by itself prove that the behavior belongs in the target architecture.

## Reuse Policy

Reuse proven behavioral and safety boundaries: provider adapters, owned-process
safety, signal gates, timeout handling, typed runtime events, debug logging,
output backpressure, provider stream parsing, model validation, provenance
primitives, interruption handling, configured file discovery, implementation
artifact discovery, and chronological cross-loop status aggregation.

Replace orchestration structures where their abstraction is wrong: the current
manifest schema, hardcoded loop kinds and transitions, audit/follow-up-specific
scanner, stage-menu phases, default-loop heuristic, continuity policy layer,
and large loop-specific orchestration branches. Reuse sound contracts, not old
control flow merely to reduce implementation effort.

The generic artifact index should consolidate the separate scanners around
configured output contracts; it should not discard already-proven discovery,
deduplication, interruption synthesis, or chronological aggregation behavior
and rebuild those behaviors without equivalence coverage.

## Treatment of the Current Restoration Plan

The restoration plan is superseded by this architecture direction. Do not
invest in expanding or preserving the old action model. Removing continuity
flags, policy rewriting, cross-skill runner binding, and filtered menu actions
belongs inside the new orchestration work rather than a parallel compatibility
implementation.

Existing code should be reused only where it implements a sound contract or
safety property needed by the new design. Code should not be retained merely
to reduce rewrite effort. If an interim repair becomes necessary to make the
application usable before the new engine lands, keep it strictly minimal and
do not treat its control flow as the target architecture.

## Assessment

- Product-direction quality: **0.98**
- Technical feasibility: **0.93**
- Fit with the current codebase: **0.88**
- Amount already partially implemented: approximately **half of the
  foundation**
- Risk if implemented as one large rewrite: **high**
- Risk if delivered through the phased model above: **moderate**

The key architectural decision is that orc-smash should become a configurable
approval-loop and task runner, not a completely generic workflow engine. This
boundary preserves its identity as a thin subprocess harness.
