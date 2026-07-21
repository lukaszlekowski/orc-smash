---
confidence: 0.95
status: r1-complete
source: docs/dev/research.md
---

# Plan: Config-Driven Approval Loops, Tasks, Pipelines, and Continuity

> **Release status:** R1 is implemented, verified, and approved. Current work
> now focuses on R2 (F7–F8 and the R2 portion of F11). R3 remains deferred.

## Architectural Decision

orc-smash becomes a **configurable approval-loop and one-off-task runner with
linear pipelines**, not a general-purpose workflow engine. The workflow chain
(plan → implement → review) is removed from the runtime and reconstructed from
project configuration. The product remains a thin subprocess harness; every
provider call still crosses the existing ownership, kill-gate, lease, timeout,
interruption, typed-event, and debug-logging boundaries unchanged in behavior.

This is a clean-contract replacement, not a compatibility extension. There is
exactly one manifest format and one execution engine after this work.

## Full Target Architecture and Release Boundary

The full target is feature items **F1–F11** plus the **Pipeline Run Identity and
Eligibility** contract below. Because no compatibility loader is permitted
(research §Configuration Location), the manifest shape and the engine that
consumes it must change together. The work therefore ships in three
independently verifiable releases, not five isolated phases:

- **Release R1 — Generic engine.** F1, F2, the Pipeline Run Identity contract,
  F3, F4, F5, F6, and the R1 portion of F11. Ends with `orc smash` running a real
  approval loop and a real one-off task end-to-end against the new generic
  manifest, artifacts carrying full provenance, pipeline-run eligibility
  decidable from provenance, and old-format artifacts correctly classified as
  unclassified.
- **Release R2 — Operator surface and continuity.** F7, F8, and the R2 portion
  of F11. Ends with the new action menu, per-skill capability-driven continuity,
  and the migrated continuity test suite.
- **Release R3 — Pipelines and budget.** F9, F10. Ends with explainable
  suggestions and the iteration extension menu.

R1 is large by necessity: the no-two-engines rule forbids a half-converted
state. This is the "high risk if one large rewrite" the research flags; R1 is
kept reviewable by decomposing it into F1–F6 that are each independently
unit-verifiable, with a single end-to-end integration gate at the release
boundary.

## Preserved Runtime Invariants (canonical, stated once)

These must not weaken. Each is verified at its release boundary:

- Typed runtime events (`src/run-event.ts`) remain the single canonical event
  stream consumed by both plain and panel output. Renames permitted
  (`verdict.parsed` → `decision.parsed`, `iteration.started` → `round.started`,
  `plan.closeout` → `stage.completed`); semantic lifecycle coverage and
  operator-visible information must not decrease, although duplicate/noisy events
  may be consolidated. New events carry `pipelineId`, `pipelineRunId`, `stageId`,
  `chainId`, `loopId|taskId`, `skillId`, provider, model, effort, session
  strategy, session ID where applicable.
- Every error produces a concise visible event. Debug logging adds detail; it
  never hides the existence of an error.
- Owned-process safety, signal gates, lease expiry, per-agent timeout,
  interruption marker handling, output backpressure, and provider stream parsing
  are reused as-is.

---

## F1 — Configuration contract (Release R1)

### Design

A single v1 manifest format replaces `skills.yaml` for both the packaged default
and the project override. Filenames are pinned: the packaged default is
`config/orc-smash.yaml`; the project override is `<project>/.orc-smash.yaml`.
Both use the identical schema; the loader picks one by precedence. The build
ships `config/orc-smash.yaml` (not `skills.yaml`); no `skills.yaml` loader
remains. The manifest requires an explicit `schemaVersion` (currently `1`);
unsupported versions are rejected with a clear configuration error.

The manifest is a complete executable contract: every loop and task binding
declares its `target`, its prompt `inputs`, its `output.pattern`, and its
`output.contract` (one of `decision-artifact`, `completion-artifact`,
`required-artifact`). Skills are generic (no `kind`) — the workflow binding
decides what a skill does. Loops declare neutral `evaluate`/`repair` bindings;
tasks are single-invocation. Pipelines are linear sequences of loop/task
references. An `inputs.source` is one of the four built-ins (`target`, `version`,
`priorArtifact`, `outputPath`) or a key declared in the binding's `files:` map
(`files: Record<SafeIdentifier, RelativePath>`, e.g.
`files: { planPath: docs/dev/plan.md }`); a `files:` key must not shadow a
built-in name. `target.kind` is `file` or `worktree`. Pipeline stages are
instances with a `stageId` unique within their pipeline and a reference to a
reusable loop or task binding; the same binding may appear in multiple stage
instances, including in multiple pipelines. Every `output.pattern`
must contain `{version}` and `{provider}` exactly once each; `{provider}` is
restricted to the filename alphabet `[a-zA-Z0-9_-]+`, and no other `{...}`
tokens are permitted. Malformed patterns are rejected at manifest load with a
message naming the pattern and the problem.

**Path roots and existence timing.** Configuration definitions and project data
use separate roots; this distinction is part of the v1 contract:

| Manifest value | Resolution root | Absolute / escaping path | Existence check |
|---|---|---|---|
| `--config <path>` | relative values resolve from the invocation working directory; the result defines `manifestRoot` | absolute accepted | config load |
| role and skill `file` | relative values resolve from `manifestRoot` | absolute accepted as an explicit definition location; relative `..` segments are normalized from `manifestRoot` | config load; missing is invalid configuration |
| binding `target.path` and `files:` values | `projectRoot` | rejected; resolved path must remain below `projectRoot` (`.` is valid for a worktree target) | snapshot/action availability and execution preflight, not manifest validation |
| `output.pattern` | `projectRoot` | rejected; rendered path must remain below `projectRoot` | parent directory/output writability at execution preflight; the output itself is expected not to exist yet |

`projectRoot` is the resolved `--project` directory and never changes merely
because `--config` points elsewhere. Manifest loading validates the declaration,
safe-relative syntax, cross-references, and pattern grammar without requiring a
project input to exist. The global snapshot records each missing target or named
file dependency. F7 keeps the affected loop/task visible but disabled with the
exact missing project path; unrelated actions remain available. Non-interactive
execution performs the same preflight, emits `input.missing` followed by
`run.failed`, and exits 1 before runner resolution, ownership admission, or
provider spawn. This is a command-preflight failure outside the executor's
`RunOutcome` union (F6). If an input disappears after an interactive action was
shown as available, the same preflight emits `input.missing` and returns to the
action menu without admitting ownership.
Project-owned path classes use one purpose-named containment helper: reject
absolute manifest values and lexical `..` escapes first; for an existing input
resolve its real path and require it to remain under `projectRoot`, and for a
not-yet-created output resolve the nearest existing parent's real path before
accepting it. A symlink may not escape `projectRoot`. Definition files are
configuration-owned references rather than project artifacts, so an explicit
absolute path or a normalized path outside `manifestRoot` is allowed and is
retained as its resolved definition path; this also permits packaged
configuration under `config/` to reference packaged `roles/` and `skills/`
siblings.

**Built-in `priorArtifact` resolution.** `priorArtifact` is the prior workflow
artifact supplied to a step's prompt (as a path reference the agent reads). One
pure resolver (`src/binding-inputs.ts`) defines its value for every execution
state and is consumed by both prompt composition and provenance. The resolver
result is a canonical **prior-artifact snapshot**, never a bare path: for a
resolved artifact its canonical form is `{ path, artifactIdentity,
contentDigest }` — the artifact path, the artifact's `artifactIdentity`, and a
content digest of the exact resolved artifact bytes read when the step's inputs
are captured (before execution); the no-predecessor state is an explicit
canonical `none` encoding, not an empty string or a missing field. The caller
reads the bytes once and passes them with the parsed identity to the resolver,
so the digest provably pins the content the prompt's path reference held at
capture time: an operator edit, repair, or corruption of the referenced
artifact after completion changes the content digest and therefore the step's
`inputFingerprint` (see Pipeline Run Identity), even though the artifact's
`artifactIdentity` is unchanged. The snapshot algorithm (byte digest plus
canonical encoding) is owned solely by `src/binding-inputs.ts`, so prompt
composition and provenance can never diverge on what was supplied:

| Execution state | `priorArtifact` |
|---|---|
| Fresh first evaluate (pipeline start or ad-hoc) | `none` |
| Repair (evaluate that follows a rejected evaluate) | snapshot of the rejected evaluate artifact |
| Re-evaluate (evaluate that follows a completed repair) | snapshot of the immediately preceding repair artifact |
| `Start suggested stage` (successor) | snapshot of the selected predecessor (confirmed candidate) artifact |
| Second-opinion evaluation | `none` (independent chain root) |
| Direct ad-hoc binding start or explicit pipeline first-stage task | `none` |

In general, `priorArtifact` is the immediately preceding artifact in the current
chain/run for this binding — the rejected evaluate for a repair, the latest
repair for a re-evaluate, the selected predecessor for a continuation — or `none`
when there is none. The resolver replaces the legacy audit-specific
`priorAuditPath` parameter in `src/prompt-composer.ts`.

**Input labels.** Each input also carries a `label` for the prompt; the default
label derives from its source (`Target document`, `Audit version`, `Prior
artifact`, `Output path`, or the `files:` key name). The canonical example omits
labels for brevity; the live composer emits them.

Canonical v1 shape (the fragile contract this item owns):

```yaml
schemaVersion: 1
roles: { auditor: roles/auditor.md, implementer: roles/implementer.md }
skills:
  plan-auditor: { file: skills/.../SKILL.md, role: auditor, runnerProfile: audit }
  implement-plan: { file: skills/.../SKILL.md, role: implementer, runnerProfile: implement }
loops:
  plan:
    type: approval-loop
    target: { path: docs/dev/plan.md, kind: file }
    inputs: [ { source: target }, { source: version }, { source: priorArtifact }, { source: outputPath } ]
    evaluate:
      skill: plan-auditor
      output: { pattern: "docs/dev/plan-audit-v{version}-{provider}.md", contract: decision-artifact, decision: { heading: Verdict, accepted: APPROVED, retry: REJECTED } }
    repair:
      skill: plan-repair
      output: { pattern: "docs/dev/plan-followup-v{version}-{provider}.md", contract: completion-artifact }
tasks:
  implement:
    skill: implement-plan
    target: { path: ".", kind: worktree }
    files: { planPath: docs/dev/plan.md }
    inputs: [ { source: planPath }, { source: version }, { source: priorArtifact }, { source: outputPath } ]
    output: { pattern: "docs/dev/impl-v{version}-{provider}.md", contract: required-artifact, validator: implement-ledger }
pipelines:
  default:
    stages:
      - { stageId: research, loop: research }
      - { stageId: plan, loop: plan }
      - { stageId: implement, task: implement }
      - { stageId: review, loop: review }
```

`completion-artifact` is a machine-readable terminal contract, not merely an
existence check. It requires valid provenance plus exactly one `## Outcome`
section whose first non-blank line is exactly `COMPLETED` or `BLOCKED` (the
packaged repair skills are updated to emit it). `COMPLETED` permits an approval
loop to proceed from repair to its next evaluation and completes a one-off task.
`BLOCKED` stops the active loop/task without stage completion or successor
eligibility; interactive execution returns to the action menu and non-interactive
execution exits 1. A missing file, empty/multiple/malformed Outcome section, or
any other token normalizes to `unknown`, emits `artifact.missing` for absence or
`artifact.unknown` for invalid content, grants no completion/continuation/resume
evidence, and exits 1 non-interactively. The
contract parser never throws. `decision-artifact` similarly normalizes its
configured accepted/retry tokens or `unknown`; `required-artifact` completes only
when the artifact exists, has valid provenance, and its optional named built-in
validator succeeds, otherwise it is `unknown`. Provider/ownership failures are
execution outcomes, not artifact-contract results.

### Files affected

- `config/orc-smash.yaml` (new packaged default) and `<project>/.orc-smash.yaml`
  (project override) — replace `skills.yaml`. Same schema, different locations.
- `package.json` — build copies `config/orc-smash.yaml`; remove the
  `skills.yaml` copy.
- `src/manifest.ts` — new v1 Zod schema: generic skills, approval-loop and task
  bindings with `target`, `inputs`, `output.contract`, `decision` map, optional
  `validator`, and an optional `files:` dependency map; `schemaVersion` required
  and rejected if unsupported; each `inputs.source` must be a built-in or a key in
  the binding's `files:` map (sources that are neither are rejected); `files:`
  keys must not shadow built-in names and their paths must resolve under
  `projectRoot`; cross-reference validation (every skill/role/profile and pipeline
  stage binding reference exists); require `stageId` uniqueness within each
  pipeline while allowing reusable bindings; reject malformed
  `output.pattern` grammar. Project input existence is deliberately not part of
  manifest validation.
- `src/artifact-contract.ts` (new) — the `decision-artifact` /
  `completion-artifact` / `required-artifact` classifier, completion Outcome
  parser, and named-validator dispatch (the implementation ledger remains a
  named built-in validator); consumed by F3–F6.
- Packaged repair/follow-up `skills/*/SKILL.md` definitions — require the exact
  `## Outcome` / `COMPLETED|BLOCKED` contract and explain that `BLOCKED` must
  include a concise reason below the token; project-supplied skills must obey the
  same declared contract.
- `src/config.ts` — `loadConfig(projectRoot, configPath?)` returns an immutable
  `Config` carrying `projectRoot`, `manifestPath`, and `manifestRoot`; precedence becomes
  `configPath` > `<project>/.orc-smash.yaml` > packaged `config/orc-smash.yaml`;
  role/skill definition paths resolve against `manifestRoot`; project targets,
  named file inputs, and outputs resolve against `projectRoot`; remove the
  packaged-`skills.yaml`-first behavior.
- `src/prompt-composer.ts` — resolve role/skill files from `manifestRoot` (not
  the packaged tool root); compose each prompt from declared `inputs`, resolving
  built-in sources, each `files:` dependency (projectRoot-relative) by key, and
  the resolved `priorArtifact` snapshot from `src/binding-inputs.ts`; the legacy
  audit-specific `priorAuditPath` parameter is removed.
- `src/binding-inputs.ts` (new) — pure resolver for built-in inputs, chiefly
  `priorArtifact` per the table above; owns the canonical prior-artifact
  snapshot (`{ path, artifactIdentity, contentDigest }` or the explicit `none`
  encoding, digested from the caller-supplied artifact bytes); consumed by
  `src/prompt-composer.ts` and provenance. No I/O — artifact bytes and parsed
  identity are passed in by the caller.
- `src/cli.ts` — add `--config <path>` to both `smash` and `status`; add to
  `smash` a `--task <task-id>` option and `--pipeline <pipeline-id>` option,
  mutually exclusive with each other and with `--loop`. `--loop`/`--task`
  always mean an ad-hoc binding start; `--pipeline` starts that pipeline's first
  stage (loop or task). Thread all selections to the command actions.
- `src/commands/smash.ts`, `src/commands/status.ts` — accept `configPath`, call
  `loadConfig(root, configPath)`, emit `config.loaded` with the resolved
  `manifestPath` instead of a hardcoded `skills.yaml`. `smash.ts` additionally
  branches on `--pipeline` vs `--task` vs `--loop`: a pipeline selection resolves
  and dispatches its first stage binding; a task selection dispatches to the F6
  task executor with task-scoped runner-override validation (a `--runner`/
  `--runner-model`/`--runner-effort` entry for a skill not in the selected task is
  rejected), while `--loop` dispatches to the F5 loop executor. Pipeline runner
  overrides are scoped to the selected first stage only; later stages are separate
  operator-confirmed invocations and resolve their own runners.
- `bin/orc.js` — production launcher only; it holds no loader logic.
- Test helpers and all configuration fixtures (e.g. `tests/helpers/*`,
  `tests/manifest.test.ts`, `tests/config.test.ts`) — rewritten to the single
  new schema; `skills.yaml` fixtures removed.

### Verification

- Unit: manifest missing `schemaVersion`, or carrying an unsupported version, is
  rejected with a configuration error naming the problem.
- Unit: precedence `--config` > project `.orc-smash.yaml` > packaged default
  holds for both `smash` and `status`, including a config outside both the
  project and package roots whose relative role/skill files resolve against
  `manifestRoot`.
- Unit: `loadConfig` returns `projectRoot`/`manifestPath`/`manifestRoot`, and `prompt-composer`
  resolves role/skill paths from `manifestRoot` while resolving targets, named
  project files, and output paths from a distinct `projectRoot`.
- Unit: a task with declared `inputs` and a `files:` map (e.g. `planPath`)
  composes a complete prompt with the dependency path resolved from
  `projectRoot`; an `inputs.source` that is neither a built-in nor a `files:` key
  is a manifest validation error; a `files:` key shadowing a built-in is
  rejected; and a task run via `--config <external>` still resolves its `files:`
  paths from the selected project rather than that config's directory.
- Unit: absolute and `..`-relative role/skill definition paths resolve exactly as
  specified, while absolute, lexical/root-escaping, and symlink-escaping target,
  `files:`, and output paths are rejected; an external config may load its own
  definitions while operating on a distinct project root.
- Unit/integration (R1): a missing project target or `files:` dependency does not
  invalidate the manifest or prevent the status snapshot from opening; the
  snapshot records the affected binding and missing path, and a non-interactive
  attempt fails preflight before ownership admission and provider spawn. The
  visible disabled-action assertion is deferred to F7 in R2.
- Unit: `priorArtifact` resolves to `none` for a fresh/ad-hoc/first-stage start,
  to the rejected evaluate artifact for a repair, to the preceding repair for a
  re-evaluate, and to the selected predecessor for a `Start suggested stage`
  continuation (including across a restart).
- Unit: identical target content with a different resolved `priorArtifact` yields
  a different `inputFingerprint`, so the two invocations are not conflated.
- Unit: editing, repairing, or corrupting the referenced artifact's bytes after
  completion — with its `artifactIdentity` unchanged — changes the resolved
  prior-artifact snapshot's `contentDigest` and therefore the `inputFingerprint`,
  so the run is never presented as the same prompt context; this is asserted for
  both a repaired-loop predecessor (rejected evaluate / preceding repair) and a
  selected `Start suggested stage` predecessor.
- Unit: a file matching an output pattern but failing its declared
  `output.contract` is classified unclassified via `src/artifact-contract.ts`.
- Unit: `completion-artifact` deterministically classifies `COMPLETED`, `BLOCKED`,
  and missing/malformed/duplicate/unknown Outcome content; loop and task tests
  assert the menu/exit/event behavior above and prove blocked/unknown artifacts
  never establish stage completion.
- Unit: a pattern missing or duplicating a token, using a forbidden token, or
  containing a `{provider}` value outside `[a-zA-Z0-9_-]+` is rejected at load
  with a message naming the pattern.
- Compiled-entrypoint coverage: the packaged default and a project override both
  load under schema v1 and no `skills.yaml` loader remains.
- Integration (R1 gate): `orc smash --config <project-config> --loop <id>` runs a
  configured loop and `orc smash --config <project-config> --task <id>` runs a
  configured task ad hoc, while `orc smash --config <project-config> --pipeline
  <id>` starts the selected pipeline's first stage; each runs through its public
  CLI surface and `orc status --config <project-config>` reads the same project
  config.

### Non-goals

- No compatibility loader, no dual manifest format, no `skills.yaml`, and no
  migration of existing on-disk artifacts (handled by F3's unclassified rule).

---

## F2 — Runner identity and adapter capabilities (Release R1)

### Design

The full runner identity is `provider + model + optional effort`. Effort is a
first-class, per-skill, adapter-declared dimension with a precedence contract
parallel to agent/model. Session-resume support is declared by each adapter as a
capability, not inferred from a provider-name allowlist. Changing any element of
the runner tuple starts a fresh session; a resumed session must match the
recorded tuple exactly.

Effort precedence (mirrors the existing agent/model resolution):

```text
1. --runner-effort <skill=level>   repeatable per-skill override
2. --effort <level>                global override
3. interactive selection           capability-gated; disabled-with-reason when effort:false
4. runnerProfile.effort            config/runners.yaml
5. provider catalogue default      config/providers/<provider>.yaml (or unset)
```

When the provider or model changes and the selected effort level is invalid for
the new provider, effort re-defaults (mirroring how a runner change re-defaults
model today). Unsupported choices remain visible in the UI with a concrete
reason rather than being hidden.

Capability declaration (the fragile contract this item owns):

```ts
capabilities: { resumeSession: boolean; effort: boolean }
```

### Runtime files affected

- `src/adapters/types.ts` — add `capabilities` to `AgentAdapter`; add optional
  `effort` to `RunInput`; document how each adapter's `buildRun` represents a
  supported effort level in its provider CLI args.
- `src/adapters/agy.ts`, `claude.ts`, `codex.ts`, `opencode.ts` — declare each
  adapter's `resumeSession` and `effort` capability and emit the provider effort
  flag when supported.
- `src/runner.ts` — `ResolvedRunner` gains optional `effort` plus source
  attribution (`effortSource`); add effort precedence, validation against the
  provider's declared levels, and re-default-on-runner-change.
- `src/runner-overrides.ts` — `PerSkillOverride` gains optional `effort`; parse
  `skill=level` alongside `skill=provider`/`skill=model`.
- `src/cli.ts` — add `--effort <level>` (global) and repeatable
  `--runner-effort <skill=level>`; extend `SmashOptions`.
- `src/commands/smash.ts` — forward effort overrides into runner resolution.
- `src/interactive.ts` — capability-gated effort prompt (disabled-with-reason
  when the selected adapter declares `effort:false`).
- `src/loops/runtime.ts` — `Runner` becomes `{ agent; model; effort? }`.
- `src/loops/runner-selection.ts` — `resolveRecordedRunner` matches the full
  `(provider, model, effort)` tuple.
- `src/loops/execution.ts` — forward `runner.effort` into `RunInput` (today it
  is constructed with `model` only).
- `src/config.ts` — `ModelRegistrySchema`/provider catalogue accepts optional
  effort levels per provider.
- `config/registry.yaml`, `config/providers/*.yaml`, `config/runners.yaml` —
  declare effort support, levels, and profile effort.
- `tests/runner.test.ts`, `tests/runner-overrides`/CLI precedence tests,
  `tests/adapters-contract.test.ts`, `tests/agy-contract.test.ts`,
  `tests/adapters-args.test.ts`, `tests/interactive.test.ts` — assert capability
  declarations, each effort-precedence tier, re-default on runner change,
  invalid effort, capability-disabled UI, and exact `(provider, model, effort)`
  resume matching.

### Verification

- Unit: each adapter exposes a `capabilities` object; agy reports
  `resumeSession: false`.
- Unit: each effort-precedence tier resolves as specified; an invalid level for
  the selected provider is rejected; a runner change re-defaults effort.
- Unit: a resumed run whose recorded `(provider, model, effort)` differs from
  the selected runner does not reuse the session.
- Targeted grep guard (test): no provider-name string equality
  (`'agy'`/`'codex'`/`'opencode'`/`'claude'`) in `src/stage-menu.ts`,
  `src/interactive.ts`, or generic runner-selection/menu policy functions.
  Provider-specific validation legitimately remains in `src/runner.ts` and
  `src/config.ts` and is covered by adapter/registry tests.
- Integration (R1 gate): adapter capability declarations load through the
  production registry; effort resolution/validation and resume eligibility are
  capability-driven and reject unsupported requests before provider spawn. The
  visible disabled-option acceptance gate belongs to F7/F8 in R2.

### Non-goals

- No new providers. No automatic effort negotiation across providers.

---

## Pipeline Run Identity and Eligibility (Release R1, precedes F3)

### Design

A pipeline run is the unit that joins stage instances across process restarts.
Two orthogonal properties govern provenance:

- **Binding reuse** — loops and tasks are reusable definitions. Each pipeline
  stage instance has a `stageId` unique within its pipeline and references one
  binding. A binding may appear in any number of stage instances or pipelines;
  `(pipelineId, stageId)` identifies the instance while `loopId|taskId`
  identifies the reusable binding.
- **Invocation mode** — how a particular run was started: **pipeline start**
  (`--pipeline` or the equivalent confirmed menu choice, always at that
  pipeline's first stage), **continuation** (`Start suggested stage`, advancing
  within an existing run), or **ad-hoc** (a direct `--loop`/`--task`/menu binding
  start).

Pipeline identity (`pipelineId` + `pipelineRunId`) is minted by a pipeline start
and inherited by a continuation. An **ad-hoc root artifact** records
`pipelineId`, `pipelineRunId`, `stageId`, and `parentArtifactIdentity` as null —
even when its binding is referenced by a pipeline — so a directly started
binding is valid without pretending to belong to any of its possible stage
instances and has no successor eligibility. Later artifacts in an ad-hoc
approval loop remain outside a pipeline but link to their immediate same-chain
predecessor. There is no ambiguous inference when a reusable binding is the
first or a later stage in several pipelines: only an explicit pipeline start
chooses one `(pipelineId, stageId)`.

Four distinct identity concepts are defined here and must not be collapsed into
one fingerprint:

- **`artifactIdentity`** — an immutable digest over a completed artifact's durable
  identity (`schemaVersion`, nullable `pipelineId`/`pipelineRunId`/`stageId`,
  `bindingKind`, `bindingId`, `chainId`, `chainMode`, `step`, `version`,
  `provider`, `model`, `effort`,
  `sessionMode`, `sessionId`, nullable `parentArtifactIdentity`,
  `inputFingerprint`, and `resultFingerprint`). It is computed after successful
  contract verification and is the join key a successor references.
  Including the reusable binding ID prevents two ad-hoc bindings with otherwise
  equal metadata from colliding; pipeline artifacts additionally include their
  stage-instance identity.
- **`inputFingerprint`** — a digest over the binding's **resolved prompt inputs
  that affect agent semantics**, captured before the step runs: the target
  snapshot (file content digest for `target.kind: file`, full worktree snapshot
  for `target.kind: worktree`), the resolved `priorArtifact` snapshot in
  canonical form (`{ path, artifactIdentity, contentDigest }`, or the explicit
  `none` encoding), and each resolved `files:` dependency's content digest, in
  canonical key order. Because the snapshot digests the resolved artifact bytes,
  mutating a referenced predecessor after completion yields a different
  `inputFingerprint` even when its `artifactIdentity` is unchanged.
  **Fingerprint scope rule:** the manifest also supplies `version` and
  `outputPath` to the prompt, but both are allocation-only values — they fix the
  artifact's version/position and output filename, never what the agent is asked
  to do — so they are deliberately excluded; the digest covers every semantic
  input, not every prompt-rendered value. It records what the step operated on
  and disambiguates identical targets run with different prior context.
- **`resultFingerprint`** — a digest of the binding's **target captured after the
  step completes**, taken after provider completion and output-contract
  verification and alongside the stable artifact write. It records what the step
  produced. `resultFingerprint` is always a target-only snapshot (used for the
  staleness check); `inputFingerprint` additionally covers the resolved
  `priorArtifact` snapshot and `files:` inputs, so the two differ whenever a step
  carries prior context.
- **`parentArtifactIdentity`** — the `artifactIdentity` of the immediate workflow
  predecessor for **every** non-root step. It is null only on an explicitly
  authorized chain root (`chainMode: pipeline-start | ad-hoc | second-opinion`).
  A `stage-continuation` root is not lineage-free: it points to the selected
  completed artifact from the preceding pipeline stage. Within an approval loop,
  repair points to the rejected evaluation, and re-evaluation points to the
  completed repair. Following immediate parent links therefore preserves both
  within-loop and cross-stage lineage without a second overloaded parent field.

**Worktree snapshot.** A `target.kind: worktree` fingerprint is a deterministic
snapshot covering HEAD, staged diffs, unstaged diffs, and untracked content —
not HEAD alone — so uncommitted or untracked changes are reflected. Declared
harness artifact paths (every configured `output.pattern`) are excluded so
writing provenance and outputs cannot alter the target identity. The snapshot,
exclusion list, and serialization are defined once in `src/pipeline-state.ts`.

**Stage transition rule (the non-negotiable eligibility contract).** A completed
predecessor artifact is a **candidate** for successor stage `S` of run `R` iff
all of the following hold:

1. **Run + structural predecessor.** `candidate.pipelineId === pipelineId`,
   `candidate.pipelineRunId === R`, and `candidate.stageId ===
   expectedPredecessor(pipelineId, S.stageId)` — the manifest stage instance
   immediately before `S`. This uses stage-instance identity, not the referenced
   binding ID, and is independent of which candidate is chosen.
2. **Recompute the predecessor's own target.** Resolve `predecessorBinding` from
   step 1 and compute `now = targetFingerprint(predecessorBinding, fsNow)`.
3. **Staleness check.** `now === candidate.resultFingerprint` — the **predecessor
   binding's** target has not drifted since the predecessor completed. This always
   compares one binding's target to itself across time, so it stays valid even
   when `S` has a different target kind.
4. **Completion check.** The predecessor stage completed validly
   (`decision === accepted` for a decision-artifact,
   `completionOutcome === completed` for a completion-artifact, or the
   required-artifact contract plus its named validator succeeded). A valid
   `BLOCKED` completion artifact is durable evidence but is not stage completion.
5. **Authorization is separate.** The pure predicate only produces selectable
   **candidates** with evidence; it never starts a stage. Only after the operator
   picks a candidate and confirms `Start suggested stage` (F7) does `S` start,
   with the chosen candidate's `artifactIdentity` bound as
   `S.parentArtifactIdentity`, `S.inputFingerprint` captured before execution, and
   `S.resultFingerprint` captured after successful completion.

A candidate failing any of (1)–(4) is not eligible. The predicate never compares
a predecessor artifact fingerprint to a different (successor) target.
`eligibleNextStages(stageS)` returns the ordered collection of candidates passing
all four (stable order by `pipelineRunId` then predecessor `version`), each with
its evidence.

Transition table (default pipeline):

| Transition | predecessor target | successor target | what step (3) recomputes and compares |
|---|---|---|---|
| plan → implement | `docs/dev/plan.md` (file) | worktree | `plan.md` content now vs the approval's `resultFingerprint` |
| implement → review | worktree | worktree | worktree snapshot now vs implement's `resultFingerprint` |

Because separate explicit pipeline starts mint distinct runs, several candidates
may be eligible concurrently; status renders all of them in stable order and the
operator selects one — there is no hidden latest-wins selection that would make
an older valid run impossible to advance.

Run creation and stage start:

- **Pipeline start** (first stage only): `--pipeline <pipeline-id>` or the
  equivalent explicit interactive choice resolves that pipeline's first stage
  instance and mints a fresh `pipelineRunId`/`chainId` with `chainMode:
  pipeline-start`, with `pipelineId` and its configured `stageId` set and
  `parentArtifactIdentity` null. This is the only fresh action that creates a
  pipeline run. A pipeline may begin with either a loop or a task.
- **Continuation** (`Start suggested stage`): advances within an existing run,
  inheriting its `pipelineId`/`pipelineRunId`, minting a fresh stage `chainId`
  with `chainMode: stage-continuation`, and binding the selected candidate's
  `artifactIdentity` as `parentArtifactIdentity` (step 5 above). It is the sole
  execution authorization for a suggested stage.
- **Ad-hoc** (direct binding start): `--loop`/`--task`/`Execute one-off task`/
  `Start fresh loop` mints a fresh `chainId` with `chainMode: ad-hoc` but records
  null `pipelineId`, `pipelineRunId`, and `stageId`; its root artifact also has
  null `parentArtifactIdentity`. This holds whether the binding is unused, first,
  middle, or repeated in configured pipelines. Later approval-loop artifacts
  link to their immediate same-chain predecessor while retaining null pipeline
  fields. The ad-hoc run has no successor eligibility or cross-stage suggestion;
  it never infers a stage instance or parent from another run.
- **Second opinion** (completed approval loop only): mints a new `chainId` with
  `chainMode: second-opinion`, uses no prior artifact or provider session, and
  has a null parent because it is an independent evaluation root. If the
  completed loop belonged to a pipeline, it retains that exact
  `pipelineId`/`pipelineRunId`/`stageId`; otherwise its pipeline/stage fields stay
  null. Its accepted result may therefore become another evidence-bearing
  candidate for that same stage/run, never for another pipeline.
- **`Continue current loop`** binds the next evaluate/repair step to the
  in-progress chain recovered from artifact provenance. It always reuses the
  existing `chainId`/`chainMode`; it also reuses pipeline fields when they are
  present, while an ad-hoc loop remains ad hoc. The new artifact's immediate
  parent is the last valid artifact in the chain. If none is recoverable the
  operator starts fresh.
- Artifact version numbers keep increasing across all starts to avoid filename
  collisions.

Cross-restart join evidence (the durable contract this section owns):

```yaml
pipelineId (nullable), pipelineRunId (nullable), stageId (nullable), chainId, chainMode,
artifactIdentity, inputFingerprint, resultFingerprint,
parentArtifactIdentity (nullable)
```

Serialization and hashing are defined once in `src/pipeline-state.ts` so the
executor, the index, and the suggestion logic cannot diverge.

### Files affected

- `src/pipeline-state.ts` (new) — pure functions only: `mintRunId`,
  `artifactIdentity(meta)`, `targetFingerprint(binding, fsNow)` (file content
  digest for `target.kind: file`; full worktree snapshot — HEAD + staged +
  unstaged + untracked, excluding declared artifact paths — for
  `target.kind: worktree`), `inputFingerprint(resolvedInputs)` (canonical digest
  over the target snapshot, the prior-artifact snapshot owned by
  `src/binding-inputs.ts`, and each resolved `files:` dependency digest, in
  canonical key order), `expectedPredecessor(pipelineId, stageS)`,
  `isFirstStage(pipelineId, stageId)`, `resolveChainMode(binding,
  startContext)` (pipeline-start | stage-continuation | ad-hoc | second-opinion),
  `eligibleNextStages(stageS)` (applies steps 1–4 by resolving the predecessor
  binding via `expectedPredecessor` and returning the ordered candidate
  collection with evidence), `recoverInProgressRun(artifacts)`,
  and `isAdHoc(meta)`. No I/O.
- `src/manifest.ts` — validate unique `stageId` values within each pipeline,
  reusable binding references, linear stage ordering, and `output.pattern`
  grammar (see F1).
- `src/next-step.ts` — replace the approval-only restart rule with
  `eligibleNextStages` (the ordered candidate collection).
- `src/stage-menu.ts`, `src/interactive.ts`, `src/loop-selector.ts`,
  `src/commands/smash.ts`, `src/commands/status.ts`, `src/status.ts`,
  `src/status-panel.ts`, `src/plain-event-renderer.ts` — consume `pipeline-state`
  for run recovery, render all eligible candidates with evidence, and select a
  specific candidate before `Start suggested stage`.
- `src/provenance.ts` (via F3) — stamp `pipelineId`/`pipelineRunId`/`stageId`/
  `chainId`/`chainMode`/`artifactIdentity`/`inputFingerprint`/`resultFingerprint`/
  `parentArtifactIdentity`; `inputFingerprint` is captured before execution and
  `resultFingerprint` after provider completion and output-contract verification,
  alongside the stable artifact write.

### Verification

- Unit: one loop/task binding may be referenced by two pipelines and twice in one
  pipeline under distinct stage IDs; duplicate stage IDs within one pipeline and
  unknown binding references are manifest errors.
- Unit: an explicit pipeline start sets the selected pipeline's identity and
  first `stageId` with null `parentArtifactIdentity`; every direct `--loop` or
  `--task` start is ad hoc with null pipeline/stage fields. `Continue` reuses only
  the in-progress chain's recorded mode and identity. (The operator-confirmed
  `Start suggested stage` action is verified under F7.)
- Unit: an ad-hoc run is never returned by `eligibleNextStages` as a predecessor
  for a successor stage, and never produces a cross-stage suggestion.
- Unit: `expectedPredecessor` returns the manifest stage id immediately before
  `S`; eligibility considers only candidates from that `(pipelineId, stageId)`,
  even when the same binding appears in another pipeline or stage instance.
- Unit: immediate lineage is exact across evaluate(retry) → repair(completed)
  → evaluate(accepted), across a restart, and from a selected predecessor into
  the first artifact of its successor stage; a broken parent link makes the
  claimed chain unclassified and ineligible.
- Unit: plan(file)→implement(worktree) eligibility recomputes the **plan**
  binding's target (`docs/dev/plan.md`) — not the implement worktree — and
  compares it to the plan approval's `resultFingerprint`; it holds while
  `plan.md` is unchanged and fails after the plan is edited.
- Unit: implement(worktree)→review(worktree) eligibility recomputes the
  **implement** binding's worktree target and compares it to implement's
  `resultFingerprint`; it holds immediately after implement and fails after a
  later uncommitted edit, an untracked-file change, or any non-artifact target
  change.
- Unit: two runs with identical target content and the same predecessor
  `artifactIdentity` but different predecessor artifact bytes (edited after
  completion) resolve different `inputFingerprint` values and are never treated
  as the same prompt context; `resultFingerprint` stays target-only and is
  unaffected by the predecessor edit.
- Unit: a harness-artifact-only write (excluded from the snapshot) does not
  change the worktree fingerprint and does not break eligibility.
- Unit: with two concurrently eligible runs for the same stage,
  `eligibleNextStages` returns both in stable order; a stale candidate beside a
  valid one is presented with its drift shown.
- Integration (R1 gate): `orc smash --pipeline <pipeline-id>` begins its first
  stage with non-null `pipelineId`/`pipelineRunId`/`stageId`; `orc smash --loop
  <binding-id>` and `orc smash --task <binding-id>` run ad hoc with all pipeline
  fields null and no successor eligibility; all
  stamp `inputFingerprint`/`resultFingerprint`; `eligibleNextStages` returns the
  correct candidates from scanned artifacts and never surfaces an ad-hoc run as a
  pipeline predecessor. (The operator-confirmed same-run continuation is an R3
  gate — F9.)

### Non-goals

- No branching or conditional pipelines.

---

## F3 — Artifact identity and provenance contract (Release R1)

### Design

Artifacts remain the durable state; orc-smash stays stateless. The provenance
front-matter contract is extended so an approval is provably bound to a specific
pipeline run, stage, chain, target revision, runner tuple, and session. The
pipeline-identity fields (`pipelineId`, `pipelineRunId`, `stageId`,
`chainId`, `chainMode`, `artifactIdentity`, `inputFingerprint`, `resultFingerprint`,
`parentArtifactIdentity`) and their algorithms are defined in **Pipeline Run
Identity and Eligibility** above; this item owns their storage. Ad-hoc bindings
carry null `pipelineId`/`pipelineRunId`/`stageId` and remain valid artifacts.
Only the root artifact in an authorized fresh chain has a null
`parentArtifactIdentity`; later approval-loop artifacts link to their immediate
predecessor. Validity is **mode-aware** (see Pipeline Run Identity): every
pipeline-run artifact (non-null `pipelineId`) carries `pipelineRunId`, `stageId`,
`chainMode`, `artifactIdentity`, `inputFingerprint`, and `resultFingerprint`.
Only `pipeline-start` or `second-opinion` roots may have a null parent;
`stage-continuation` roots require the selected prior-stage parent, and all later
steps require their immediate same-chain parent. An artifact with null
`pipelineId` must also have null `pipelineRunId`/`stageId`; an `ad-hoc` or
`second-opinion` root has a null parent and later steps link immediately, but the
artifact has no successor eligibility.
Any artifact that claims pipeline membership but omits a required field — or that
is interrupt/incomplete — is **unclassified** and never advances a pipeline,
establishes stage completion, enables continuation, or provides a resumable
session, regardless of its age or filename.

Provenance identity tuple (the fragile contract this item owns):

```yaml
schemaVersion, pipelineId (nullable), pipelineRunId (nullable), stageId (nullable),
bindingKind, bindingId, chainId, chainMode, artifactIdentity, inputFingerprint,
resultFingerprint, parentArtifactIdentity (nullable), step, version, provider,
model, effort, sessionStrategy, sessionMode, sessionId
```

### Files affected

- `src/provenance.ts` — extend `ArtifactMeta` with the identity fields above;
  `parseArtifactMeta` returns an explicit `unclassified` result when required
  identity fields are absent (front-matter present-but-incomplete or legacy
  shape). The no-front-matter fallback path is retained only for non-artifact
  files and never yields a valid workflow artifact.
- `src/artifact-contract.ts` (from F1) — classifies an artifact against its
  declared `output.contract`; a contract failure yields `unclassified`.
- `src/loop.ts`, `src/loops/execution.ts`, and the new generic executors (F5/F6)
  — stamp the full identity tuple at every `writeArtifactWithMeta`, sourcing the
  pipeline fields from `src/pipeline-state.ts`.
- `tests/provenance.test.ts`, `tests/interrupted-artifact.test.ts` — assert
  full-tuple stamping, the unclassified-artifact rule, and that an interrupted
  (partial) artifact is stamped-and-classified as interrupted rather than
  complete or silently unclassified.

### Verification

- Unit: a freshly produced artifact carries every required identity field for its
  invocation mode.
- Unit: a pipeline-run artifact (non-null `pipelineId`) missing `stageId`,
  `bindingKind`, `bindingId`, `chainMode`, `artifactIdentity`, `inputFingerprint`,
  `resultFingerprint`, `pipelineRunId`, or a non-null
  `parentArtifactIdentity` when its `chainMode`/step requires one is classified
  unclassified and excluded from next-step, continuation, and resume decisions.
  A later `second-opinion` chain root in an existing pipeline run is separately
  verified as valid with a null parent.
- Unit: an ad-hoc direct start of a mid-pipeline-stage binding (e.g. `--task
  implement`) records null `pipelineId`/`pipelineRunId`/`stageId` and a null
  initial `parentArtifactIdentity`,
  is valid and classified, has no successor eligibility, and never produces a
  successor suggestion.
- Unit: later artifacts in both pipeline and ad-hoc approval loops carry the
  immediate same-chain parent link defined above; missing or non-immediate links
  make the claimed chain unclassified. The sole cross-chain parent form is a
  `stage-continuation` root pointing to the selected immediately preceding stage
  in the same pipeline run. An ad-hoc artifact remains valid and classified but
  has no successor eligibility.
- Unit: `chainMode` enforces its root rule: pipeline-start/ad-hoc/second-opinion
  roots accept null parents, stage-continuation roots require the selected
  prior-stage parent, and no later artifact may silently start a second root.
- Unit: two approvals with different `artifactIdentity` values are not treated as
  the same stage completion.
- Unit: an interrupted artifact is quarantined/classified as interrupted before
  the index can read it as a completed stage.

### Non-goals

- No artifact rewriting or migration of legacy files — they are unclassified.
- No database or out-of-band state store; artifacts remain the only state.

---

## F4 — Generic artifact index and global snapshot (Release R1)

### Design

A single generic artifact index scans every output pattern declared by every
configured loop and task, classifies each matching file against its contract
(via `src/artifact-contract.ts`), and yields the global project snapshot. This
consolidates the current audit/follow-up-specific scanner and the separate
implementation scanner around configured output contracts, preserving existing
discovery, deduplication, interruption-marker synthesis, and chronological
cross-loop aggregation with equivalent coverage. Artifact path tokens become
`{version}` and `{provider}` (replacing `{n}` and `{agent}`). Interrupted
artifact quarantine runs **before** index scanning so a partial artifact is
never read as a completed stage.

### Files affected

- `src/patterns.ts` — rename tokens to `{version}`/`{provider}`; keep render and
  parse directions as the single filename-semantics source; enforce the pattern
  grammar (each token exactly once, `{provider}` in `[a-zA-Z0-9_-]+`, no other
  braces) consumed by `src/manifest.ts` validation.
- `src/state.ts` — replace `scan`, `scanImplementArtifacts`, `scanImplementAsSteps`,
  `resolveImplementFacts`, and the per-loop status helpers with one
  contract-driven index; preserve `scanAllForStatus`'s chronological, deduped,
  interruption-aware behavior as the global view.
- `src/status.ts` — `PanelContext` (the rendering contract consumed by six
  production modules) is the seam; extend it to carry the per-stage snapshot
  (latest evaluation + runner + effort, latest repair + runner + effort, latest
  execution) from the index.
- `src/status-panel.ts` (rich panel), `src/plain-event-renderer.ts` (plain path
  via `renderRunEvent`), `src/cli-output.ts`, `src/commands/status.ts` — render
  the snapshot. Note: `src/plain-render.ts` is currently **orphaned**
  (`renderPlainPanel` has no production callers; plain output does not route
  through it). Decide during R1 whether to delete it or wire it in; do not
  assume it is part of the live plain path.
- `tests/state.test.ts`, `tests/patterns.test.ts`, `tests/status-core.test.ts`,
  `tests/status-panel.test.ts`, `tests/interrupted-artifact.test.ts`,
  `tests/plain-render.test.ts` — rewritten around the generic index (the
  plain-render test is revised or removed per the orphaned-code decision).

### Verification

- Unit: every declared loop/task output pattern is scanned into one index;
  selecting a loop filters the view but does not change what the index knows.
- Unit: an unclassified artifact (per F3) appears in the snapshot as
  unclassified and contributes no stage-completion signal.
- Unit: dedup, chronological ordering, and interrupted-step synthesis behave as
  today (equivalence tests ported from the current scanners).
- Unit: a partial/interrupted artifact is quarantined before scanning and never
  appears as a completed stage in the index.
- Integration (R1 gate): `orc status` renders the global snapshot across
  research/plan/implement/review from a single scan.

### Non-goals

- No arbitrary file interpretation; only configured-pattern files are workflow
  artifacts.

---

## F5 — Generic approval-loop engine and decision normalization (Release R1)

### Design

One approval-loop executor implements `evaluate -> accepted -> stage complete`
and `evaluate -> retry -> repair -> evaluate`. Configured decision tokens
(`APPROVED`/`REJECTED` or any user-chosen pair) normalize to the canonical
internal states `accepted`/`retry`/`unknown`, so the runtime state machine stays
stable while users relabel decisions. The hardcoded plan/implement/review
transitions and all literal loop-name coupling (`loops['plan']`, etc.) are
removed; loop transitions are derived from pipeline configuration. The iteration
model is "one iteration = one evaluator invocation"; repair is part of the
rejected round. A repair `completion-artifact` classified `COMPLETED` advances to
the next evaluation; `BLOCKED` returns the shared blocked outcome; `unknown`
returns the shared unknown outcome. Neither blocked nor unknown consumes another
evaluation round or establishes stage completion.

### Files affected

- `src/loop.ts` — replace the audit/follow-up/implement-specific `runLoop` with
  the generic executor; remove recursive `runLoop('implement'|'review', …)`
  calls and all `config.manifest.loops['plan'|'implement'|'review']` lookups.
- `src/next-step.ts` — generalize the restart rule to evaluate/repair and
  accepted/retry/unknown, sourcing stage eligibility from `src/pipeline-state.ts`.
- `src/verdict.ts` — replace fixed `APPROVED`/`REJECTED` detection with
  configurable-token detection that normalizes to the canonical states.
- `src/loops/execution.ts` — keep as the single per-step provider executor;
  parameterize labels on configured evaluate/repair terms.
- `src/artifact-contract.ts` (from F1), `src/plan-closeout.ts`,
  `src/plan-metadata.ts`, `src/implement-ledger.ts` — remain as named built-in
  validators/contracts (research §Deliberate Limits), invoked by configured
  task/loop output contracts rather than by loop name.
- `src/binding-inputs.ts` (from F1) — resolves the `priorArtifact` snapshot for
  each evaluate/repair state in the generic loop executor.
- Safety suites ported/extended through the generic executor:
  `tests/lease-expiry.execution.test.ts`, `tests/ownership-fence.test.ts`,
  `tests/kill-gate.test.ts`, `tests/kill-gate.scan.test.ts`,
  `tests/adapters/utils-timeout.test.ts`, `tests/run-event.test.ts`,
  `tests/cli-output.test.ts`, `tests/cli-output-live.test.ts`,
  `tests/debug-harness-event.test.ts`, plus `tests/loop-implement.test.ts`,
  `tests/loop-completion.test.ts`, `tests/loop-live.test.ts`,
  `tests/verdict.test.ts`, `tests/next-step.test.ts` rewritten against the
  generic engine and normalized decisions.

### Verification

- Unit: a loop with relabeled decision tokens (e.g. `accepted: PASS`,
  `retry: FAIL`) drives the same accepted/retry/unknown state machine.
- Unit: retry on the final permitted round does not close the loop; accepted on
  the final round closes immediately (off-by-one guard).
- Unit: ownership loss before spawn and at completion surfaces as the
  ownership-lost outcome through the generic executor (no throw); lease expiry
  mid-step behaves as today.
- Unit: timeout and provider error render as visible events in both plain and
  panel output; debug-harness events are preserved.
- Integration (R1 gate): a plan loop runs evaluate→repair→evaluate to acceptance
  with zero references to the literal names plan/implement/review in control
  flow, and ownership/interruption/timeout behavior is unchanged from today.

### Non-goals

- No arbitrary verdict state machines, no loop branching beyond the two-skill
  approval model, no conditional pipeline branches.

---

## F6 — Generic one-off task engine (Release R1)

### Design

One task executor runs a configured task once and returns a structured terminal
result. In R1 a task is reachable through the public `--task <task-id>` CLI
surface (F1, mutually exclusive with `--loop`); the interactive `Execute one-off
task` menu arrives in R2 (F7). `Execute one-off task` lists configured tasks, not
raw skills, because a raw skill may lack the input/output configuration required
for safe execution. Task inputs are composed from the binding's declared `inputs`
(F1), its output is classified by its declared `output.contract` (F1/F3), and its
runner is resolved per F2. Per the Pipeline Run Identity contract, an explicit
pipeline start mints a `pipelineRunId`, a confirmed continuation reuses it, and a
direct `--task` start is ad hoc with no pipeline identity. The task executor and
the loop executor share one terminal-result type — `RunOutcome` in
`src/loops/runtime.ts`, generalizing today's `LoopReturn` — consumed by
`smashAction`, which maps every **returned executor outcome** to one canonical
terminal event, the appropriate ownership disposition, and an exit code
(asserted in Verification). Asynchronous operating-system signals remain an
intentional exception: the existing signal boundary terminates children and
exits immediately rather than waiting for the executor to return.

The exhaustive executor terminal contract is:

| `RunOutcome.kind` | Produced when | Canonical terminal behavior |
|---|---|---|
| `completed` | loop decision is `accepted`, or task output is contract-valid and completed | emit `stage.completed`, then `run.completed`; finalize ownership; exit 0 |
| `blocked` | a valid `completion-artifact` says `BLOCKED` | emit `stage.blocked`, then `run.failed`; no stage completion/successor; finalize ownership; interactive menu or non-interactive exit 1 |
| `unknown` | missing/malformed artifact, unknown decision, or failed output contract/validator | emit the specific `artifact.missing`, `artifact.unknown`, or `decision.unknown`, then `run.failed`; no mutation, completion, continuation, or resume evidence; finalize ownership; interactive recovery menu or non-interactive exit 1 |
| `provider-failed` | auth, timeout, spawn, transport, non-zero exit, or unverified provider completion | provider-specific failure event, then `run.failed`; quarantine any partial artifact; finalize ownership when safe; interactive recovery menu or non-interactive exit 1 |
| `budget-exhausted` | the final permitted evaluation is `retry` and the operator declines/has no interactive extension | emit `stage.incomplete`, then `run.failed`; preserve the retry artifact for a later Continue; finalize ownership; menu return or non-interactive exit 1 |
| `ownership-lost` | the ownership fence cannot verify the run | emit `ownership.lost`, then `run.failed`; release admission only after fresh-capability cleanup is proven complete, otherwise retain it fail-closed; restricted recovery or exit 2 |

This union is exhaustive for values returned by the loop/task executor to
`smashAction`; adding a returned executor outcome requires an explicit terminal
event, ownership, and exit mapping. It deliberately does **not** model
SIGINT/SIGTERM. `handleInterruptSignal` owns that direct signal boundary: emit
`run.interrupted` once, persist the full durable marker, terminate only through
the existing fresh-capability gate, and exit with the conventional signal code.
It must not route a signal through ordinary finalization or turn it into a
provider failure. Command validation and project-input preflight occur earlier
and use their explicitly defined command-failure behavior (F1/F11), not a
synthetic executor outcome. Lower-level parsers return facts and never emit a
competing terminal event.

`RunOutcome.artifactPath` is executor-internal evidence used to populate
`LoopReturn.lastAuditPath` and summaries. R1 does not add artifact paths to the
public `CommandResult` or terminal `run.*` events; artifact-specific events and
the persisted index remain the operator-visible source for paths. Do not create
command-layer plumbing solely to echo this internal field.

### Files affected

- `src/loops/runtime.ts` — defines the shared `RunOutcome` terminal-result type
  consumed by both the loop and task executors and by `src/commands/smash.ts`.
- `src/loop.ts` (or a new `src/task-engine.ts`) — task executor reusing F2
  runner resolution, F3 provenance stamping, F5's per-step executor, the
  Pipeline Run Identity contract, and the F11 error boundary; returns a
  `RunOutcome`.
- `src/cli.ts`, `src/commands/smash.ts` — the `--task <task-id>` surface and
  task-aware dispatch/runner-override validation (F1).
- `src/loop-selector.ts` (or a purpose-named `src/task-selector.ts`) — resolves a
  `--task` id to its binding and validates it exists in the manifest.
- `src/artifact-contract.ts` (from F1) — classifies task output.
- `src/stage-menu.ts` → replaced by the F7 menu (R2), which surfaces tasks from
  config interactively; R1 does not depend on it.
- `src/binding-inputs.ts` (from F1) — resolves the `priorArtifact` snapshot for a
  task (`none` for ad-hoc/first-stage; the selected predecessor's snapshot for a
  confirmed successor).
- Safety suites ported/extended: `tests/interrupted-artifact.test.ts`,
  `tests/ownership-*.test.ts`, `tests/adapters/utils-timeout.test.ts`,
  `tests/run-event.test.ts`, plus `tests/loop-implement.test.ts` and a new
  task-engine test asserting single invocation via `--task`.

### Verification

- Unit: a task runs exactly once per `--task` invocation and returns a
  `RunOutcome`.
- Unit: a compact command-mapping table covers every **returned** `RunOutcome`
  kind and asserts its canonical terminal event, exit code, and ordinary
  finalization behavior — no duplicated or missing `run.completed`/`run.failed`.
  Executor tests separately assert stage/provider-specific events and internal
  `artifactPath`; those events need not be recreated by a mocked `smashAction`
  table.
- Unit: a `--runner`/`--runner-model`/`--runner-effort` entry for a skill not in
  the selected task is rejected.
- Unit: a raw skill not bound to a task is not executable via `--task`.
- Unit: a task whose output fails its declared contract is reported as a
  recoverable failure with no stage completion.
- Unit: a completion task yielding `COMPLETED`, `BLOCKED`, or malformed/missing
  Outcome returns `completed`, `blocked`, or `unknown` respectively; approval-loop
  repair exercises the same classifier and mapping.
- Unit: ownership loss and timeout during a task surface through the same
  executor boundaries as a loop step. Ownership-loss coverage proves both clean
  fresh-capability cleanup (admission released) and ambiguous/blocked cleanup
  (admission retained).
- Signal-boundary test: SIGINT/SIGTERM emits exactly one `run.interrupted`, writes
  the full marker, terminates through the gate, and requests the conventional
  signal exit without ordinary `RunOutcome` finalization.

### Non-goals

- No making every raw skill directly executable.

---

## F7 — Operator menus and action visibility (Release R2)

### Design

A small top-level menu (`Start loop` / `Execute one-off task` / `Change loop` /
`Display pipeline and project state` / `Stop for manual review`) with a
`Start loop` submenu (`Continue current loop` / `Start fresh loop` / `Run second
opinion` / `Back`).
Every action remains visible; an unavailable action is disabled with a concrete
reason and is never filtered out. `Continue` is visible-but-disabled after
acceptance; `Run second opinion` is enabled only for a completed approval loop
and follows the independent-chain identity/session rules above. `Continue` shows
the next skill, artifact version, runner, model, effort, and session strategy.
Freshness, run-id minting, and version-collision avoidance
are owned by the Pipeline Run Identity contract and are not restated here. After
choosing a fresh loop or task whose binding is a first-stage reference, the menu
offers explicit launch contexts: `Start ad hoc` plus one entry for each pipeline
where it is the first stage, labeled with that pipeline and stage ID. Choosing a
pipeline entry is the interactive equivalent of `--pipeline`; choosing ad hoc
never acquires pipeline identity. Thus reuse across pipelines is explicit and no
latest/first manifest match is inferred. When
F9 offers one or more eligible candidates, the menu adds an operator-confirmed
**`Start suggested stage`** action: the operator first selects a specific
candidate from the rendered list (each with its evidence), then the selected
stage runs bound to that candidate's `pipelineId`/`pipelineRunId`/predecessor
`artifactIdentity`/`stageId` — the only action that carries an existing run's
identity into a downstream stage.

### Files affected

- `src/stage-menu.ts` — replaced by a config-driven menu builder; the current
  five `MenuPhase` literals and hardcoded action sets are removed.
- `src/interactive.ts`, `src/loop-selector.ts` — drive the new menu, submenu, and
  the `Start suggested stage` confirmation.
- `src/commands/smash.ts` — wire the new menu and the suggested-stage start
  (binding the existing run identity) into the smash action.
- `src/pipeline-state.ts` (from Pipeline Run Identity) — supplies the candidate
  evidence and run identity consumed by `Start suggested stage`.
- `tests/stage-menu.test.ts`, `tests/interactive.test.ts`,
  `tests/loop-selector.test.ts` — rewritten.

### Verification

- Unit: for every loop/task state, the full action set is present; disabled
  actions carry a non-empty reason; no action is filtered out.
- Unit: `Continue` is disabled (not absent) after acceptance; every Fresh action
  mints a new `chainId` and resumes no session. An explicitly selected pipeline
  start also mints `pipelineRunId`; an ad-hoc Fresh start leaves pipeline/stage
  fields null. A binding reused as the first stage of two pipelines shows both
  labeled pipeline contexts plus ad hoc, with no implicit choice.
- Unit: `Run second opinion` is visible but disabled before completion; after
  acceptance it creates the exact `second-opinion` chain root defined by the
  identity contract and starts no inherited session.
- Unit: `Start suggested stage` runs the operator-selected candidate's stage
  bound to its `pipelineRunId` and predecessor `artifactIdentity`; it is the only
  action that carries an existing run's identity into a downstream stage.
- Integration (R2 gate): unsupported resume and effort choices remain visible
  and disabled with capability-derived reasons; a missing target or named project
  file disables only affected starts and does not prevent the menu from opening.

### Non-goals

- No auto-selection of the suggested stage (see F9).

---

## F8 — Per-skill continuity and runner selection (Release R2)

### Design

Each skill binding gets an independent `provider + model + effort + session
strategy` (effort resolution is defined in F2). Resume support is discovered
from adapter capabilities (F2), not a provider-name allowlist. Selection order
is evaluate(provider, model, effort, session strategy) then repair(provider,
model, effort, session strategy). There is no shared same-chain session setting
(it would create cross-skill binding). Both intent (`sessionStrategy:
resume-per-skill`) and observed execution (`sessionMode`, `sessionId`) are
persisted so a fresh first invocation under a resume strategy reconstructs
correctly across restarts.

This is the **continuity behavior migration** (research §Continuity Behavior
Migration): the obsolete flag-policy layer is removed; the reusable mechanics
and runner-selection behavior are preserved or deliberately reimplemented behind
generic contracts.

### Runtime files affected

- `src/stage-menu.ts` — delete `AuditContinuityPolicy`,
  `applyAuditContinuityPolicy`, `deriveContinuity`, and flag-derived arming;
  port `findResumableSession`/`findResumableSessionDetail` to generic
  evaluate/repair kinds and to the full `(provider, model, effort)` tuple.
- `src/loops/runner-selection.ts`, `src/interactive.ts` — per-skill independent
  selection; only the applicable skill inherits its own resumable runner.
- `src/cli.ts`, `bin/orc.js` — remove `--audit-continuity` and
  `--codex-audit-continuity` flags.
- `src/provenance.ts` (via F3) — persist `sessionStrategy` alongside
  `sessionMode`/`sessionId`.

### Continuity test migration

Classify every existing continuity test as: **port** (behavioral intent
unchanged), **rewrite** (against the generic engine), or **delete** (protects
obsolete flag-policy behavior). These contracts must survive the migration:
codex/opencode/claude resume the exact recorded session for the applicable
binding; runner-tuple mismatch never reuses another session; returned
session-ID mismatch fails safely and stays visible; acceptance forms a
continuation boundary; a second opinion starts fresh; missing/invalid session
evidence yields an informed safe outcome; evaluate and repair may use different
tuples; only the applicable skill inherits its own session; a one-off task
selects only its own runner. Delete tests whose intent is continuity CLI flags,
shared evaluate/repair runners, cross-skill session binding, or action filtering.

### Test files affected

The continuity behavior is spread across more than the two headline suites;
classify each by intent, not by file:

- **Delete (obsolete flag-policy):** the `--audit-continuity` /
  `--codex-audit-continuity` validation cases in `tests/smash-action.test.ts`
  and the option-parsing cases in `tests/cli.test.ts`; the
  `applyAuditContinuityPolicy` arming case in `tests/stage-menu.test.ts`; the
  single flag-arming case in `tests/loop-continuity.test.ts`.
- **Port (reusable mechanics, intent unchanged):** the session-resume,
  thread-ID-mismatch, missing-session fallback, approved-boundary,
  new-round-boundary, provider-mismatch, and second-opinion-fresh cases in
  `tests/loop-continuity.test.ts`; the `findResumableSession` walk case in
  `tests/stage-menu.test.ts`; the inheritance/multi-iteration/review-parity
  cases in `tests/loop-followup-runner.test.ts`; the session-ID capture and
  resumed-mismatch cases in `tests/opencode-run.test.ts`,
  `tests/opencode-stream.test.ts`, `tests/claude-result.test.ts`,
  `tests/codex-json.test.ts`, and the sessionMode/sessionId round-trip in
  `tests/provenance.test.ts`.
- **Rewrite (mechanics that change derivation):** the `deriveContinuity`
  capability-map case in `tests/stage-menu.test.ts` (becomes adapter-capability
  driven, not a provider-name allowlist) and the fresh/resumed argument
  branches in `tests/adapters-args.test.ts` (mode is now capability-derived, but
  the per-adapter `buildRun` argument construction is still required).

### Verification

- Unit: every surviving contract above has a passing test against the generic
  engine.
- Unit: a provider/model/effort mismatch never resumes another runner's session.
- Unit: resume offered for an `resumeSession:false` adapter is disabled with a
  reason, never hidden and never silently fresh.
- Grep guard: no continuity CLI flags remain in `src/cli.ts` or `bin/orc.js`.

### Non-goals

- No shared cross-skill session. No provider-name resume checks.

---

## F9 — Pipeline display and explainable suggestions (Release R3)

### Design

From the F4 index and the Pipeline Run Identity eligibility predicate, the
application computes an **ordered collection** of explainable next-stage
candidates, each with its evidence (pipeline, run, previous stage, completion
artifact, decision, and the predecessor `artifactIdentity`/`resultFingerprint`
match). Several runs may be eligible for the same stage concurrently. It never
automatically selects or starts any candidate. Status renders all eligible
candidates in stable order; the operator either ignores them, chooses another
loop/task (a fresh-run start), or picks a specific candidate and selects
**`Start suggested stage`** (F7) — the only confirmed path that advances within
that candidate's existing `pipelineRunId`, binding its predecessor
`artifactIdentity` and target `stageId` into the executor.

### Files affected

- `src/next-step.ts` (suggestion logic, consuming `src/pipeline-state.ts`),
  `src/commands/status.ts`, `src/status.ts`, `src/status-panel.ts`,
  `src/plain-event-renderer.ts` — render the ordered candidate collection with
  per-candidate evidence.
- `tests/next-step.test.ts`, `tests/status-action.test.ts` — assert
  evidence-bearing suggestions and no auto-advance.

### Verification

- Unit: a candidate appears only when it satisfies the full eligibility predicate
  (same run, manifest predecessor stage, valid completion, and the **predecessor
  binding's** current target fingerprint equal to the candidate's
  `resultFingerprint`).
- Unit: a predecessor whose target has since drifted, or a foreign-run approval,
  is not a candidate.
- Unit: with two concurrently eligible runs, status renders both in stable order
  and the operator's selected candidate is the one advanced.
- Unit: selecting `Start suggested stage` runs the stage in the selected
  candidate's `pipelineRunId` with the predecessor identity bound; selecting
  ordinary `Execute one-off task` (or `--task`) instead mints a distinct ad-hoc
  chain with null pipeline/stage fields.
- Integration (R3 gate): after a plan approval, `orc status` shows
  `Suggested: implement` with evidence and does not start it; confirming a
  specific candidate via `Start suggested stage` runs implement in that run.

### Non-goals

- No automatic next-stage execution.

---

## F10 — Iteration budget and extension menu (Release R3)

### Design

Default budget is four evaluator rounds. If the latest result is `retry` when the
budget ends, offer extend-by-3 / extend-by-5 / custom / return-to-menu; "extend
by 3 after four completed rounds" sets the new total to 7. Required ordering:
provider completion → artifact verify + provenance → decision parse → accepted
closeout (if accepted) → budget check (only when retry). Infrastructure errors
and `unknown` decisions do not count as budget exhaustion. Display both counts:
`Round 3/4 - provider calls 5`. No extension offered after acceptance.

### Files affected

- `src/loop.ts` (generic executor), `src/loops/execution.ts` (provider-call
  counter), `src/cli.ts` (default `--max-iterations` becomes 4), the F7 menu
  (extension choices).
- `tests/loop-completion.test.ts`, `tests/loop-live.test.ts`,
  `tests/cli.test.ts` — assert ordering, off-by-one safety, and the extension
  menu.

### Verification

- Unit: accepted on the final permitted round closes immediately with no
  extension prompt.
- Unit: retry on the final round offers exactly the configured extension
  choices; an `unknown` decision returns to the error menu instead.
- Unit: the displayed round and provider-call counts are accurate across a
  multi-round loop.

### Non-goals

- No per-stage asymmetric budgets; one budget per approval loop.

---

## F11 — Controlled error boundaries (cross-cutting; anchored in R1)

### Design

Recoverable workflow failures (auth, timeout, spawn, non-zero exit, missing
project input, missing or invalid artifact, unknown decision, invalid output
contract, missing session ID, resume mismatch, unsupported effort or continuity
choice) stop safely, finalize or retain ownership as appropriate, emit the
canonical error event, and preserve debug evidence. A missing-project-input
preflight follows F1: `input.missing` then `run.failed`, no ownership admission
or provider spawn, interactive return to the action menu or non-interactive exit
1. Other failures reached after execution begins use F6's `RunOutcome` contract.
Recovery is **mode-specific** so the boundary
does not contradict the non-interactive R1 task contract (F6): an **interactive**
run returns to the appropriate menu; a **non-interactive** `--pipeline`/`--loop`/`--task`
command emits the visible failure event, handles ownership according to whether
admission occurred, and returns the specified command-preflight or `RunOutcome`
exit code (it never opens a menu). Safety-critical
failures (invalid configuration, ownership loss or ambiguity, unsafe artifact
identity, event-output failure, internal invariant violation) cross a controlled
boundary, restore the terminal, and enter a restricted recovery path or exit
non-zero — never return to the normal execution menu and never escape as an
unhandled exception. The required property is containment at the command
boundary, not the absence of `throw` in lower-level safety functions (several of
which intentionally throw to signal configuration or ownership failure).

### Files affected

- `src/run-event.ts` (error events), `src/cli-output.ts`,
  `src/plain-event-renderer.ts` (visible error rendering), `src/commands/smash.ts`,
  `src/commands/status.ts` (command boundaries), `src/run-ownership.ts`,
  `src/interrupted-artifact.ts` (ownership retention/finalization reused).
- `tests/errors.test.ts`, `tests/smash-action.test.ts`, `tests/status-action.test.ts`,
  plus `tests/ownership-*.test.ts`, `tests/interrupted-artifact.test.ts`,
  `tests/lease-expiry.execution.test.ts`, `tests/kill-gate*.test.ts`,
  `tests/adapters/utils-timeout.test.ts`, `tests/run-event.test.ts`,
  `tests/cli-output*.test.ts`, `tests/debug-harness-event.test.ts`.

### Verification

- Unit (R1): test each **distinct command-boundary branch**, not the Cartesian
  product of every provider error label and invocation mode. At minimum cover
  pre-admission input/setup failure, post-admission recoverable provider/artifact
  failure, clean ownership loss, blocked ownership loss, and output/terminal
  failure. Interactive representatives return to the appropriate menu;
  non-interactive representatives return the specified exit without opening a
  menu. Provider-specific auth/timeout/spawn distinctions remain covered at the
  adapter/executor layer where they are produced.
- Unit (R1): representative safety-critical branches exit non-zero or enter the
  restricted path; none leaves the terminal un-restored. Equivalent errors that
  share the same production branch do not require duplicate command tests.
- Boundary test (R1): `smashAction` and `statusAction` with injected failures
  assert terminal restoration, a visible event/error, correct ownership
  disposition, and the exit/restricted-recovery outcome. Static checks are
  reserved for narrowly forbidden patterns (e.g. no continuity CLI flags),
  not for `throw` in general.

### Non-goals

- No retry automation inside the boundary; the operator drives recovery.

---

## Global Non-Goals (research §Deliberate Limits)

- Arbitrary DAGs, parallel stages, conditional branches, stage dependencies.
- User-provided JavaScript validators.
- Arbitrary numbers of loop branches or arbitrary verdict state machines.
- Automatic execution of the next pipeline stage.
- Making every raw skill directly executable.
- A second manifest format or a second execution engine.

## Verification Strategy Summary

Every feature item carries unit tests. The preserved safety boundaries are
verified primarily by **deterministic generic-executor regressions** — the
existing ownership, interruption, lease, kill-gate, timeout, event, plain/panel,
and debug suites ported/extended through the new generic loop and task executors
(named in F3–F6 and F11) — not by manual smoke alone. Each release additionally
passes one end-to-end integration gate on a real project:

- **R1:** `orc smash --pipeline <pipeline-id>` begins its configured first stage;
  direct `orc smash --loop <binding-id>` and `orc smash --task <binding-id>` run
  ad hoc (null pipeline/stage fields, no successor eligibility), each through its
  public CLI surface against a generic project config. `orc status` renders the
  global snapshot; a missing project input is represented as binding-scoped
  unavailability and fails only that binding's headless preflight; a legacy
  artifact is shown unclassified; a stale, foreign-run, or ad-hoc artifact
  never advances a stage; and the ported safety suites pass through the generic
  executors.
- **R2:** the action menu shows every action with disabled-reasons; a resume
  attempt on a non-resume adapter is disabled with a reason; the migrated
  continuity suite passes.
- **R3:** `orc status` shows an evidence-bearing suggestion it does not execute;
  a final-round retry offers the extension menu; a final-round acceptance closes
  immediately.

Manual smoke (each release, supplementary sign-off only): run
`orc smash --plain` and `orc status` against a scratch project; confirm typed
events, debug log detail under `--debug-spawn`, and ownership/kill-gate/
timeout/interruption behavior are unchanged from today.
