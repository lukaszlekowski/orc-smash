# Plan — Optional research-first pipeline and plan-creation task (follow-up batch 6)

**Confidence: 0.96**

This plan implements **Batch 6 — Optional research-first pipeline** from
`docs/dev/archived/follow-up.md`: a standalone research approval loop, a
configured plan-creation task, and an optional
`research → create-plan → plan → implement → review` pipeline, while
retaining the existing `default` pipeline unchanged. Batch 7 (rejected-audit
scope triage) is out of scope.

## Status

Draft for the `plan` approval loop.

## Objective

Let the operator optionally front-load work with a research approval cycle
whose accepted artifact feeds a configured plan-creation task, without making
research a universal prerequisite and without adding any research- or
task-specific branching to TypeScript. The generic binding engine, pipeline
eligibility, menus, and evidence contracts already shipped must carry the new
pipeline as pure configuration and skill content.

## Scope

- Packaged manifest additions in `config/orc-smash.yaml`: one approval loop,
  one task, one pipeline, three skill definitions (no role changes);
- three new packaged skill files under `skills/` at the tool root;
- test-only seams in `src/adapters/fake.ts` and deterministic manifest,
  snapshot, menu, and e2e coverage;
- documentation synchronization (`AGENTS.md`, `README.md`,
  `docs/architecture/overview.md`).

## Non-goals

- No TypeScript execution, menu, eligibility, reducer, or renderer changes.
  The only `src/` edit is the deterministic fake-adapter test seam.
- No hardcoded `research`, `create-plan`, or pipeline-name branching anywhere
  in TypeScript (guarded by tests and review).
- No research-creation automation: `docs/dev/research.md` is authored outside
  the harness (operator or external agent), exactly like `docs/dev/plan.md`
  before this batch. Do not add a research-generation task or make research a
  prerequisite for the `default` pipeline.
- No plan-creation semantics inside the `plan` approval loop: it keeps
  auditing and repairing `plan.md`; it is not turned into a generator.
- No replacement/overwrite workflow for an existing `docs/dev/plan.md` (the
  follow-up defers that to a separately designed workflow).
- No automatic downstream transitions: every stage change remains an
  operator-confirmed action (suggested stage, pipeline start, or ad-hoc run).
- No new task-availability machinery: availability uses the existing generic
  missing-inputs contract plus the task's fail-safe `BLOCKED` outcome (D3).
- Batch 7 scope triage, and any change to the commit task, decision
  correction, telemetry, or ledger outcomes from earlier batches.

## Current state (verified)

- `pipeline-stage-state.ts` is fully generic: task stages produce successor
  evidence via `completion-artifact: completed` or `required-artifact: valid`;
  loop stages via an accepted evaluate in their chain; exact predecessor edges
  are single-use; target-fingerprint drift suppresses candidates with typed
  reasons.
- `target-snapshot.ts` worktree fingerprints exclude all configured output
  artifacts, so a task's own evidence artifact never causes self-drift; the
  created `plan.md` and `HEAD` are covered, so later edits/commits
  legitimately suppress the continuation (the documented "may invalidate it"
  behavior).
- Manifest validation supports any number of pipelines with mixed loop/task
  stages, per-pipeline unique stage IDs, and load-time skill/role file
  existence checks (`manifest.ts:479-491`).
- `binding-engine.ts` already resolves a stage-continuation task's
  `priorArtifact` from the recorded parent artifact identity — the exact
  accepted-research predecessor wiring, with zero new code.
- The pipeline-continuation warning the operator quoted already landed
  (`interactive.ts:107-114`, commit `027417c`) and is generic over eligible
  candidates; `create-plan` inherits it with no change.
- Packaged roles (`auditor`, `planner`, …) and skills live at the tool root;
  skill IDs are arbitrary strings. No research or create-plan skills exist
  today.
- The fake adapter writes valid task completion artifacts generically but has
  no seam to write additional provider-side files (needed to simulate
  `plan.md` creation) or to emit a `BLOCKED` task outcome.

## Normative decisions

### D1 — Pure-configuration pipeline addition with preserved defaults

**Design.** All runtime behavior comes from the shipped generic engine. The
manifest gains, in YAML key order: `research` appended after `review` in
`loops:` (so the first configured loop — and therefore the no-activity
default-loop suggestion — stays `plan`), `create-plan` appended after
`commit` in `tasks:`, and `research-first` appended after `default` in
`pipelines:` (both pipelines render in manifest declaration order, `default`
first). Reference shape:

```yaml
loops:
  research:
    type: approval-loop
    target: { path: docs/dev/research.md, kind: file }
    inputs: [{ source: target }, { source: version }, { source: priorArtifact }, { source: outputPath }]
    evaluate:
      skill: research-audit
      output:
        pattern: "docs/dev/research-audit-v{version}-{provider}.md"
        contract: decision-artifact
        decision: { heading: Verdict, accepted: APPROVED, retry: REJECTED }
    repair:
      skill: research-follow-up
      output:
        pattern: "docs/dev/research-followup-v{version}-{provider}.md"
        contract: completion-artifact

tasks:
  create-plan:
    skill: 23-simple-create-plan
    target: { path: ".", kind: worktree }
    files: { researchPath: docs/dev/research.md }
    inputs: [{ source: researchPath }, { source: target }, { source: version }, { source: priorArtifact }, { source: outputPath }]
    output:
      pattern: "docs/dev/create-plan-v{version}-{provider}.md"
      contract: completion-artifact

pipelines:
  default:      # unchanged: plan → implement → review
  research-first:
    stages:
      - { stageId: research, loop: research }
      - { stageId: create-plan, task: create-plan }
      - { stageId: plan, loop: plan }
      - { stageId: implement, task: implement }
      - { stageId: review, loop: review }
```

**File impact.** `config/orc-smash.yaml` only.

**Verification.**

- Packaged config loads; both pipelines validate and display in declaration
  order (`default`, then `research-first`).
- The `default` pipeline remains exactly `plan → implement → review`; all
  existing pipeline tests pass unmodified.
- Loop/task ID namespace collision rules still hold; stage IDs repeat only
  across pipelines, never within one.

### D2 — Research approval loop: configured skills, ordinary contracts

**Design.** The research loop is an ordinary approval loop over the declared
`docs/dev/research.md` target with the existing decision/completion
contracts. Two new packaged skills, modeled on `21-simple-plans-audit` /
`22-simple-plans-follow-up` but scoped to research documents:

- `skills/10-simple-research-audit/SKILL.md` (role `auditor`, profile
  `audit`): audits research.md for feasibility, completeness, scope
  boundaries, and consistency with the actual codebase; versioned `vN`
  semantics (second opinions read the prior audit after forming their own
  verdict); never modifies research.md or source code; ends with exactly one
  `## Verdict` of `APPROVED` or `REJECTED`.
- `skills/11-simple-research-follow-up/SKILL.md` (role `planner`, profile
  `follow-up`): repairs research.md against a rejected audit, modifying only
  research.md; writes exactly one `## Outcome` of `COMPLETED` or `BLOCKED`.

Skill IDs/names are configuration data (`research-audit`,
`research-follow-up` in the manifest); the numeric prefixes follow the
existing series convention and may be adjusted at review without design
impact. The generic `auditor` role text ("Audit plan documents…") is left
unchanged — each skill carries its own research-specific instructions, and no
role edit is worth the churn. An accepted research artifact becomes successor
evidence only inside a `research-first` pipeline run; an ad-hoc research run
has null pipeline identity and therefore creates no candidates and never
starts another stage.

**File impact.** `skills/10-simple-research-audit/SKILL.md`,
`skills/11-simple-research-follow-up/SKILL.md` (new); `config/orc-smash.yaml`
(skill entries).

**Verification.**

- The loop runs ad hoc (fake adapter) through evaluate/repair with the
  configured contracts; accepted, retry, and unknown outcomes behave exactly
  as the plan loop's.
- An ad-hoc accepted research artifact produces no pipeline candidates.
- The research loop starts `research-first` via the generic first-stage
  launch-context prompt; no TypeScript references the literal binding ID.

### D3 — `create-plan` task: research consumption, no-clobber, fail-safe evidence

**Design.** One new packaged skill, `skills/23-simple-create-plan/SKILL.md`
(role `planner`, profile `follow-up`), rather than reusing
`20-simple-plan`: the task needs contract behavior (prior-artifact
requirement, no-clobber, `## Outcome` evidence) that must not leak into the
interactive plan skill. The skill instructs the provider to:

- read `researchPath` (`docs/dev/research.md`) and the prior artifact, and
  require the prior artifact to be present (not `none`) and to record an
  accepted research verdict; otherwise write the task evidence with
  `## Outcome: BLOCKED` and the precise reason, creating nothing;
- create only the initial `docs/dev/plan.md` (following the project's plan
  quality standard: confidence header, design/file-impact/verification,
  non-goals) and its task evidence; never modify research.md, the research
  audit, or any other file;
- if `docs/dev/plan.md` already exists, write `## Outcome: BLOCKED` with the
  precise reason instead of overwriting — the separately designed replacement
  workflow is out of scope.

Availability stays on the two existing generic tiers — no new machinery:

1. **Menu disable:** a missing declared `researchPath` file makes the task
   unavailable in the Tasks menu with the standard missing-inputs reason.
2. **Runtime fail-safe:** running without an accepted research predecessor
   (e.g. ad hoc) or with an existing plan.md ends as a structurally valid
   `BLOCKED` completion artifact — never `unknown`, never a partial plan. A
   `BLOCKED` artifact is not successor evidence, so the research→create-plan
   edge remains unconsumed and the task can simply be rerun via the suggested
   stage. When an eligible research continuation exists, the generic task
   detail view already lists it with the landed "does not consume the
   pipeline continuation… may invalidate it" warning.

**File impact.** `skills/23-simple-create-plan/SKILL.md` (new);
`config/orc-smash.yaml` (task entry).

**Verification.**

- Missing `researchPath` disables the task with the precise missing-inputs
  reason.
- Ad-hoc execution without accepted research evidence and execution with an
  existing plan.md both end `BLOCKED` with precise reasons, create no plan,
  and unlock nothing.
- A completed run writes exactly the plan plus its evidence artifact and
  preserves the research artifacts byte-for-byte.

### D4 — Stage-transition semantics ride the shipped eligibility contract

**Design.** No eligibility changes; each edge behaves as follows under the
existing rules, and the plan pins the expected behavior as tests:

- **research → create-plan:** predecessor target is the research.md file;
  the accepted evaluate's result fingerprint matches an untouched research.md
  → eligible. Editing research.md after acceptance suppresses the candidate
  as `target-fingerprint-drift` (correct: the basis changed).
- **create-plan → plan:** predecessor target is the worktree. The task's
  evidence artifact is fingerprint-excluded, but the created plan.md and
  `HEAD` are covered — so committing or editing after the task suppresses
  the continuation with the documented drift reason, and the operator runs
  the plan stage ad hoc or via a fresh pipeline start (identical to today's
  implement → review behavior after a commit). This is accepted, documented
  behavior, not a defect to engineer around.
- **plan → implement → review:** identical to the `default` pipeline.
- Exact edges are single-use: one create-plan run per accepted research
  artifact, one plan continuation per create-plan artifact; a `BLOCKED`
  create-plan consumes nothing.

**File impact.** None (tests only).

**Verification.**

- e2e: the full `research → create-plan → plan → implement → review` chain
  advances through operator-equivalent stage-continuation contexts with
  correct parent identity at every hop.
- create-plan's provenance records the exact accepted research artifact as
  `parentArtifactIdentity`, and the plan stage's evaluate receives the
  create-plan artifact as its prior artifact.
- Drift cases (edited research.md; edited plan.md; intervening commit) flip
  the matching candidate to its typed unavailable reason.

### D5 — Deterministic coverage via two small fake-adapter seams

**Design.** `src/adapters/fake.ts` (test-only adapter) gains:

- `extraWrites: Array<{ path: string; content: string }>` — files written
  during `run`, letting a simulated create-plan provider create
  `docs/dev/plan.md` inside the fingerprint window; and
- `taskOutcome?: string` — overrides the task artifact's `## Outcome` token
  (default `COMPLETED`) to drive `BLOCKED` paths.

Both follow the existing `fakeAdapterState` pattern; no production adapter or
engine changes. New e2e coverage lives in a dedicated
`tests/e2e/research-first-pipeline.test.ts`; manifest/menu/snapshot coverage
extends `tests/manifest.test.ts`, `tests/config.test.ts`,
`tests/project-snapshot.test.ts` / `tests/stage-menu.test.ts`.

**File impact.** `src/adapters/fake.ts` (test seams), new e2e spec, the
listed test files.

**Verification** (maps the follow-up's required list one-to-one).

- Both pipelines displayed in declaration order; `default` unchanged;
  research-first runs the five-stage chain.
- Research runs ad hoc with no downstream effect; create-plan receives the
  exact accepted research predecessor.
- Missing research evidence (menu disable) and existing plan.md (`BLOCKED`)
  carry precise reasons.
- A renamed-manifest fixture (research loop and create-plan task renamed)
  drives the same chain, proving no literal-name branching.
- The default pipeline never requires or infers research state.

### D6 — Documentation synchronization

**Design.** `AGENTS.md` §6 currently states research.md "is not a stage in
the current pipeline" — that becomes false and must be rewritten: research
remains optional, is the first stage of the packaged `research-first`
pipeline only, and the `default` pipeline is unchanged. `README.md`'s
manifest-model section gains the two-pipeline description;
`docs/architecture/overview.md` notes the packaged research loop/create-plan
task as ordinary configuration (its generic-engine statements remain true).
`AGENTS.md` keeps its "no hardcoded research branching" invariant explicitly.

**File impact.** `AGENTS.md`, `README.md`, `docs/architecture/overview.md`.

**Verification.** Docs land in the same release as the manifest change; no
statement contradicts the shipped configuration.

## Release boundaries

Each release is independently verifiable with `pnpm typecheck && pnpm test`.

### Release 1 — Skills, manifest, and docs (D1–D3, D6)

- Three packaged skills; research loop, create-plan task, and research-first
  pipeline in the manifest; AGENTS.md/README/overview sync; manifest, config,
  snapshot, and menu tests (declaration order, availability, defaults
  preserved).
- Gate: packaged config loads; full suite green with no changes to existing
  behavior; both pipelines and the new task render correctly.

### Release 2 — Pipeline chain coverage (D4–D5)

- Fake-adapter seams and the research-first e2e: full five-stage chain,
  prior-artifact identity, drift cases, ad-hoc research, `BLOCKED` paths,
  renamed-binding fixture.
- Gate: all new and existing tests green.

### Release 3 — Operator smoke (manual, recommended)

- On this repository: author a small `docs/dev/research.md`, run
  `research-first` end to end interactively (research accept → suggested
  create-plan → suggested plan loop), and confirm the menus, fingerprint
  behavior, and the create-plan → plan hand-off on a real provider. Evidence
  is operator-visible; no automated gate.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

All automated coverage is deterministic (fake adapter, fixture manifests,
temp workspaces). No real-provider contract gate is required: the batch adds
no adapter or engine behavior — only configuration, skill content, and tests.
