---
status: ready
confidence: 0.96
owners: cli-runtime
scope: orc-smash-only
---

# Append-Only Plain Output and Per-Skill Runner Overrides

## Summary

Make `--plain` a true chronological terminal event stream rather than a textual
projection of the interactive status panel. Every meaningful run milestone, decision,
check, warning, and error should appear once, line by line, without alternate-screen
control sequences, redraws, spinners, or repeated panel snapshots.

Add manifest-driven, per-skill non-interactive runner options so operators can select
different agent/model pairs for audit, follow-up, review, and implementation steps
without opening interactive menus. Existing run-wide `--agent` / `--model` options
remain supported.

This plan changes `orc-smash` only. It does not extend the supervisor protocol or make
the current supervisor host client interactive. Those integrations remain a later,
separately reviewed phase.

## Goals

1. `--plain` produces readable append-only output suitable for a normal terminal,
   tmux scrollback, logs, CI, and a future supervisor client.
2. Runtime milestones are emitted from one typed source and projected by independent
   panel and plain renderers.
3. Errors remain immediately visible and terminal outcomes are unambiguous.
4. Operators can provide a different validated runner for every skill used by the
   selected loop.
5. Runner behavior remains manifest-as-data: adding a loop that references existing
   skills requires no new TypeScript option wiring.
6. Interactive behavior, artifact naming, provenance, runner continuity, ownership,
   and provider adapters remain compatible.

## Non-Goals

- Do not add a PTY proxy, interactive supervisor transport, or supervisor protocol
  fields.
- Do not stream raw provider stdout/stderr by default. Raw process diagnostics remain
  behind `--debug-spawn` / `--debug-spawn-file`.
- Do not turn plain output into a stable machine API in this phase. A future JSONL
  renderer may consume the typed event contract, but `--plain` remains human-readable.
- Do not change provider authentication, timeout policy, session-continuity semantics,
  verdict parsing, workflow artifact paths, or ownership/signal behavior.
- Do not hardcode the current plan/review skill IDs into CLI parsing.

## Current Problems

### Plain mode is still a panel projection

`createPlainCliOutput()` currently accepts `renderPanel(context)`, reduces the
`PanelContext`, and prints `renderPlainPanel(context)` whenever that snapshot changes.
The result repeats layout concepts such as Loop, Iteration, Active, Next, and Timeline
instead of reporting what happened. It is append-only mechanically, but it still reads
like successive dashboard screenshots.

Runtime information is also split between:

- `CliOutput` lifecycle methods;
- adapter `LifecycleEvent` values;
- stringly `debugHarnessEvent()` calls; and
- panel-only `PanelContext` snapshots.

That makes it difficult to guarantee that plain mode reports every important event
once without duplicating orchestration logic.

### Non-interactive runner choice is run-wide only

`orc smash --agent ... --model ...` applies one coupled runner pair to every skill in
the run. Interactive mode can select the full upcoming skill pair, but a headless run
cannot express, for example, Codex for `plan-audit` and Claude for
`plan-follow-up`.

## Phase 1 — Typed Runtime Events and True Plain Rendering

### 1. Introduce a stable runtime-event contract

Add a purpose-named module such as `src/run-event.ts` containing a discriminated
`RunEvent` union and a minimal `RunEventSink` contract. Events must carry `atMs` and
only the structured fields relevant to their type.

The initial catalogue must cover the meaningful operator-visible lifecycle:

- `run.started`
- `config.loaded` / `config.failed`
- `loop.selected`
- `runner.resolved` / `runner.rejected`
- `state.scanned`
- `iteration.started`
- `step.started`
- `provider.started`
- `provider.progress`
- `provider.completed` / `provider.failed`
- `artifact.verified` / `artifact.missing`
- `verdict.parsed` / `verdict.unknown`
- `follow-up.outcome`
- `stage.action`
- `implementation.ledger-validated`
- `plan.closeout`
- `ownership.opened` / `ownership.finalized`
- `ownership.lost`
- `run.interrupted`
- `run.completed` / `run.failed`
- operator-facing `note`, `warning`, and `error`

The exact union may consolidate events that have identical semantics, but event names
must be centralized and typed rather than scattered string literals.

Event fields must be allow-listed. Never emit prompts, credentials, environment
values, reconnect/ownership tokens, full provider buffers, or unbounded artifact
content. Bound and normalize provider progress text before creating an event.

Compatibility policy: this is a versioned internal runtime contract in this phase,
with `schemaVersion: 1` on every event. Event names and required fields are
append-only within v1; a rename, removal, or semantic change requires a new schema
version and a renderer that explicitly supports it. `--plain` is still a human
interface, not a promised JSONL API, but this policy prevents a future JSONL
consumer from silently depending on an unstable union.

### 2. Emit each event once at its owning boundary

Keep orchestration thin and assign event ownership deliberately:

- command setup owns config, loop, state-scan, and initial runner-resolution events;
- loop orchestration owns iterations, decisions, verdicts, outcomes, and final state;
- step execution owns step/provider lifecycle and duration;
- artifact/ledger/closeout modules return facts which the orchestrator emits once;
- interruption and ownership-loss boundaries own their terminal events.

`CliOutput` is migrated rather than bypassed. Add `emit(event: RunEvent): void` and
`flush(): Promise<void>` as its durable operator-event contract; retain the current
named methods only as a temporary compatibility facade that constructs the exact
mapped event and calls `emit`, then remove each facade method once its caller is
migrated. The facade must never render directly. This permits output construction
before setup while still making setup facts typed.

The migration inventory is mandatory. `smashAction` emits one typed failure plus
one `run.failed` terminal event for: missing `--project`, ownership admission
failure, config/manifest load failure, no loops, invalid/failed loop selection,
continuity/override validation failure, implement-plan preflight failure,
state-scan failure, runner-resolution failure, invalid max iterations, a thrown
`runLoop` error, and ownership-finalization failure. It emits `ownership.opened`
after admission and `ownership.finalized` after successful closeout. Admission is
moved after config loading, explicit-loop selection, and all non-prompting option
validation; app-owned launch input is parsed early but no ownership record is
opened until validation passes. `runLoop` maps every existing `note`, iteration,
stage/second-opinion decision, artifact/verdict, closeout, final summary, and
terminal branch to the catalogue. `executeLoopStep` maps pre-step/pre-spawn
ownership loss, provider start/progress/completed/failed, and race completion.
No direct `CliOutput.note/warn/error/step*/finalSummary` call remains on the
`smash` command path outside the facade or event projector after the migration.
Read-only `orc status` and ownership commands are explicitly outside this feature's
event-contract migration boundary.

Do not emit the same semantic milestone independently through `CliOutput` and
`debugHarnessEvent`. Adapt the debug log to consume or mirror the canonical typed
event at one boundary. Process-only spawn diagnostics may remain separate because
they contain debug data that is intentionally excluded from normal output.

Adapter `LifecycleEvent` remains the provider adapter seam. Convert it to canonical
run events in `loops/execution.ts`; do not make adapters depend on terminal renderers.
Use this deterministic per-step progress policy: emit `provider.started`, then at
most 8 `provider.progress` events. Normalize and truncate each message to 240
display characters; emit the first distinct message, then every fourth distinct
message until the budget is exhausted. Repeated messages emit no progress event.
All lifecycle tool calls are accumulated, but the rendered count is capped at
`999+`. On completion/failure, include `toolCalls`, `progressEmitted`, and
`progressSuppressed`; if anything was suppressed, emit one final
`provider.progress` marker `message="progress suppressed"` within the same budget
(reserving its final slot). Limits, normalization, and overflow markers are
constants in `run-event.ts`, while `execution.ts` owns sampling state.

### 3. Separate event projection from panel state projection

Refactor `CliOutput` so operator milestones flow through the event sink. Preserve
panel-specific live-region methods only for interactive display state; they must not
be the source of plain output.

Recommended boundaries:

- `src/run-event.ts`: typed domain event and sink;
- `src/plain-event-renderer.ts`: pure one-event-to-lines formatting;
- `src/cli-output.ts`: injected writable-stream wiring and panel/plain output construction;
- existing `status-panel.ts`: interactive dashboard projection;
- existing `plain-render.ts`: retain only for the read-only `orc status` command if
  that command still needs a non-dashboard textual projection, or remove it when no
  production caller remains.

Do not create a generic `events.ts`, `helpers.ts`, or `common.ts` bucket.

### 4. Define the plain line format

Every plain event is written immediately and never redrawn. The human-readable shape
is:

```text
HH:MM:SS LEVEL event.name key=value ... message="bounded text"
```

Example:

```text
00:42:11 INFO run.started project=/work/app loop=plan maxIterations=3
00:42:11 INFO runner.resolved skill=plan-audit agent=codex model=gpt-5.6-terra
00:42:11 INFO runner.resolved skill=plan-follow-up agent=claude model=glm-5.2[1m]
00:42:12 INFO step.started skill=plan-audit kind=audit version=1
00:47:35 PASS artifact.verified path=docs/dev/plan-audit-v1-codex.md
00:47:35 INFO verdict.parsed verdict=REJECTED
00:47:36 INFO step.started skill=plan-follow-up kind=follow-up version=1
00:53:08 PASS run.completed verdict=APPROVED
```

Formatting rules:

- no ANSI escapes, cursor controls, alternate screen, spinners, boxes, or panel
  headings;
- one physical output line per event after escaping newlines/control characters;
- stable field ordering per event type;
- quote values containing whitespace and escape quotes/backslashes;
- quote values containing a control/non-printable character; escape `\\`, `"`,
  `\n`, `\r`, `\t`, and remaining controls as `\u00XX`; arbitrary printable
  punctuation (including `[` and `]`) is bare unless quoting is otherwise required;
- timestamps derive from `event.atMs`, not a second renderer-time clock read;
- every chronological plain event, including warnings and errors, goes through one
  injected stdout `write()` primitive, so a merged/piped transcript has the same
  sequence as a terminal. Severity is carried by `LEVEL`; stderr is reserved for
  process diagnostics outside the canonical stream;
- assign a monotonically increasing `sequence` when `CliOutput.emit` accepts an
  event, before projection. A write is serialized in sequence order; honor stream
  backpressure by queueing later writes until `drain`. A renderer/write failure is
  reported through the non-canonical diagnostic path and makes the command fail
  without attempting to fabricate a second terminal event;
- `flush()` resolves only after every event accepted before the call has been
  written and all `false`-return backpressure queues have drained. It rejects on a
  writer error or premature stream close and records a fatal writer state that
  causes later `emit` calls to be ignored rather than reordered or retried;
- `smashAction` centralizes all returns through a `finish(result)` helper. After it
  emits the terminal event and performs required ownership finalization, `finish`
  awaits `output.flush()` before returning the `CommandResult`; this applies to
  missing-project, setup, ownership-admission/finalization, thrown-loop, normal,
  and every other return path. A flush rejection writes one non-canonical stderr
  diagnostic (never a further `RunEvent`), preserves an already-nonzero exit code,
  or changes an otherwise-successful result to exit code 1 with a writer-failure
  message. `process.exitCode` is assigned only from that finished result;
- `failed`, `unknown`, timeout, auth, transport, interruption, and ownership-loss
  endings must include the reason/error kind and final nonzero outcome;
- final output must not append a second panel-like project snapshot. Emit explicit
  final and next-action events instead.

Approximately 25 meaningful events are acceptable in the default stream. Avoid a
new verbosity flag until real use shows that the canonical catalogue is too noisy.
Raw provider chunks, polling ticks, repeated identical progress, and internal render
state are never default plain events.

### 5. Keep interactive mode behavior stable

Interactive mode may continue using the alternate-screen dashboard and spinners.
It should consume the same canonical milestones for its durable event log/error
handling while maintaining its separate live `PanelContext` projection.

Preserve:

- current menus and runner selection;
- live panel refresh behavior;
- errors flushed to the main screen after alternate-screen teardown;
- current terminal exit codes and final workflow decisions.

The refactor must not print every plain event underneath the active panel.

## Phase 2 — Manifest-Driven Per-Skill Runner Overrides

### 6. Add repeated skill-addressed CLI options

Add the following repeatable `orc smash` options:

```text
--runner <skill-id>=<agent>
--runner-model <skill-id>=<model>
```

Example:

```sh
node bin/orc.js smash \
  --project /work/app \
  --loop plan \
  --runner plan-audit=codex \
  --runner-model plan-audit=gpt-5.6-terra \
  --runner plan-follow-up=claude \
  --runner-model 'plan-follow-up=glm-5.2[1m]' \
  --max-iterations 3 \
  --plain
```

Use separate agent and model options rather than packing both into a colon/slash
syntax: provider model namespaces contain slashes, configured names may contain
spaces, and future model IDs must remain opaque.

Create a focused parser module such as `src/runner-overrides.ts`. It owns repeated
`skill=value` parsing, duplicate detection, selected-loop membership checks, and
normalization into a typed map. Commander wiring remains thin.

Commander declares `.option('--runner <skill-id=agent>', description, collect, [])`
and `.option('--runner-model <skill-id=model>', description, collect, [])`; the
collector appends raw values without splitting. `SmashOptions` carries `runner` and
`runnerModel` as `string[]`. `collect` is tested both at CLI parsing and at the
compiled-command boundary so repeated options cannot be overwritten by Commander.

### 7. Validate against the selected manifest loop

After loop selection and config loading, compute the selected loop's skill IDs from
the manifest. Reject before ownership/provider spawn when:

- an entry has no `=` or an empty skill/value;
- the same skill appears twice in `--runner` or twice in `--runner-model`;
- the skill does not exist;
- the skill exists but is not used by the selected loop;
- the agent is unavailable from the production registry/configuration;
- the effective agent/model pair violates the provider namespace/allow-list rules;
- headless per-skill overrides are supplied without an explicit `--loop`.

Error messages must name the offending option and list the selected loop's accepted
skill IDs. No partial runner map may reach `runLoop`.

Interface and timing policy:

| Invocation | Policy | Timing |
| --- | --- | --- |
| `--loop <name>` with zero or more per-skill options | Headless; validate for that loop | config + selected-loop validation, before `openOwnedRun()` |
| no `--loop`, no per-skill options | Existing interactive loop and runner prompts | prompts occur before ownership admission |
| no `--loop` with either per-skill option | Reject; options cannot be scoped before the loop prompt | before `promptLoopSelect`, ownership admission, or adapter creation |
| interactive stage/second-opinion after a normal interactive start | Existing menus choose the full pair | as today; per-skill map is absent |

`smashAction` therefore parses launch input, loads config, selects/validates the
loop and runner map, and only then opens ownership. Rejection has no prompt, owned
run record, provider process, artifact mutation, or adapter `run()` call. The
normal app-owned authorization checks still run when ownership is opened.

### 8. Pin coupled-pair precedence

Resolve every selected skill independently using this precedence:

```text
interactive selection
> per-skill CLI override
> run-wide --agent / --model
> skill runnerProfile
> provider catalogue default model
```

Coupled-pair rules:

- a per-skill agent with a per-skill model uses that exact validated pair;
- changing a per-skill agent without a per-skill model re-defaults the model to that
  agent's catalogue default and must not inherit a global/profile model from a
  different namespace;
- a per-skill model without a per-skill agent applies to the otherwise effective
  agent and is validated in that agent's namespace;
- skills without per-skill fields retain the existing run-wide/profile behavior;
- catalogues and profiles are never mutated;
- second-opinion runner selection remains fresh and interactive when the run is
  interactive; a later design may add a separate headless second-opinion policy.

Refactor `resolveRunner()` only as needed to accept the typed per-skill override.
Keep all model validation in the existing runner boundary.

`runner-overrides.ts` exposes `{ [skillId]: { agent?: string; model?: string } }`;
it does not resolve a pair. `runner.ts` returns:

```ts
type ResolvedRunner = {
  agent: string; model: string;
  agentSource: 'interactive' | 'skill' | 'global' | 'profile' | 'default' | 'session';
  modelSource: 'interactive' | 'skill' | 'agent-default' | 'global' | 'profile' | 'default' | 'session';
  inheritedSession?: { agent: string; model: string; sessionId: string };
};
```

Resolution is independently attributable and follows this table (each model is
validated in the resulting agent namespace):

| Agent input | Model input | Effective pair / sources |
| --- | --- | --- |
| interactive pair | interactive pair | selected pair; both `interactive` |
| skill agent | skill model | exact pair; both `skill` |
| skill agent | none | skill agent + that agent default; `skill` / `agent-default` |
| none | skill model | otherwise-effective agent + skill model; agent retains its source, model `skill` |
| no skill fields, global agent + global model | exact global pair; both `global` |
| global agent only | global agent default; `global` / `agent-default` |
| global model only | profile/default agent + global model; agent retains source, model `global` |
| no CLI fields | profile pair if fully valid, otherwise provider default; `profile` or `default` |
| eligible resumed primary audit step | recorded pair/session only when it agrees with the resolved provider/model; both `session` |

An explicit effective provider/model that differs from recorded continuity metadata
does not resume: fail before spawn with an actionable continuity conflict. A
matching explicit pair may resume but never rewrites recorded `sessionMode` or
`sessionId`. `SmashRunSetup`, `LoopOptions`, `runLoop`, interactive prompting, and
recursive plan→implement→review calls carry the `ResolvedRunner` map; they must not
call the old global-only fallback. Overrides are validated against the originally
selected loop only. Recursive transitions receive no newly applicable override map
and resolve their skills through normal selected/interactive/default rules, which
prevents a plan-only option from silently controlling implementation or review.

### 9. Make headless decisions visible

Before the first provider spawn, plain output must print the final effective
agent/model pair for every skill in the selected loop, including whether each came
from a per-skill override, run-wide override, profile, or inherited resumable
session where applicable.

Provenance stamps and artifact filenames continue recording the actual runner used
for each step. Audit continuity continues to inherit only where existing rules allow;
explicit per-skill options configure fresh steps but must not silently forge or
overwrite recorded session metadata.

Plain `runner.resolved` events include `agentSource`, `modelSource`, and, when
used, `inheritedSession` identity; never emit session tokens beyond the existing
safe session ID metadata.

### 10. Preserve existing CLI compatibility

- Existing `--agent` and `--model` remain supported and keep their current meaning.
- Existing non-interactive runs without per-skill flags behave identically.
- Existing interactive runs behave identically unless the operator explicitly uses
  the new flags; reject incompatible mixtures rather than silently skipping menus.
- Restore the required audit-continuity command surface: declare
  `--audit-continuity` and legacy `--codex-audit-continuity` in `src/cli.ts`, carry
  their booleans through `SmashOptions`, reject their mutual use before ownership,
  and apply the concrete policy below. This restores the public behavior documented
  by README and AGENTS rather than changing that governing contract.
- `fake` remains test-only and cannot be selected in production.
- `agy` continues accepting only exact configured human-readable model names.
- The build, stable `bin/orc.js`, and `supervisor-contract` schema remain unchanged.

### 10a. Audit-continuity policy and stage-action wiring

Define and pass this typed policy from `src/commands/smash.ts` through
`SmashRunSetup` into `LoopOptions`:

```ts
type AuditContinuityPolicy =
  | { enabled: false }
  | { enabled: true; requestedBy: 'audit-continuity' | 'codex-audit-continuity' };
```

`smash.ts` accepts the two declared flags, rejects their simultaneous use before
ownership, and derives `{ enabled: false }` when neither is passed. It rejects an
enabled policy for any loop except plan/review. Before the first provider spawn it
resolves both primary-chain runners (audit and follow-up), requires the same
agent/model pair for both, and requires that agent to be one of codex, opencode, or
claude. The legacy alias additionally requires Codex. This is necessary because one
persisted session ID may be resumed only by its recorded provider/model; a mixed
per-skill pair is a continuity conflict, not a reason to fall back silently. The
same pre-spawn validation occurs when a persisted rejected chain is entered.

`stage-menu.ts` owns an `applyAuditContinuityPolicy(actions, state, policy)` rule;
`loop.ts` calls it immediately after `buildStageActions()` and before either prompt
or automatic recommendation. With policy disabled, it rewrites every primary-chain
`resumed` value—single or `{ followUp, audit }`—to `new`, and removes the
`start-new-same-session` action. Thus an ordinary rejected chain is fresh by
default, even if old artifacts contain a session ID. With policy enabled, it removes
the optional same-session start action, keeps `continue` values as
`{ followUp: 'resumed', audit: 'resumed'}`, and marks a new primary chain as armed
after its first audit returns `REJECTED`. The seed audit itself is always `new`; once
armed, its follow-up and every subsequent audit/follow-up in that same rejected
chain are forced to `resumed`. One-step actions remain `new`.

`loop.ts` owns the execution boundary: add `auditContinuity: AuditContinuityPolicy`
to `LoopOptions`, carry the armed state only in the active loop invocation, and use
the policy-derived session value instead of reading raw `StageAction.sessionPolicy`
directly. For flag-on re-entry, `findResumableSessionDetail()` reads only persisted
artifact metadata, stopping at an approved boundary; it must find the same recorded
agent/model and a non-`none` session ID before a resumed spawn. A mismatch,
unconfigured recorded runner, unsupported provider, missing session ID after the
seed audit, or approved-boundary conflict is a typed continuity failure before the
affected provider spawn—never a fresh fallback. The first fresh audit must persist
its session ID before its rejected outcome can arm the chain. No session ID is
passed through `--last` or process history.

The policy applies only to the primary rejected plan/review chain. Second opinions,
approved/new chains, implement, recursive plan→implement→review transitions, and
one-step actions always receive `{ mode: 'fresh' }` and no inherited session.
Runner overrides remain valid, but an enabled policy rejects a pair that differs
from the persisted anchor before spawn; a matching pair may resume without altering
the artifact's `sessionMode` or `sessionId`.

## Verification Plan

### Typed event and formatter tests

- Exhaustively format every `RunEvent` variant with an injected timestamp.
- Prove stable field order, quoting, newline/control-character escaping, bounded
  progress, and absence of secrets.
- Prove no rendered line contains ANSI/alternate-screen/cursor sequences.
- Prove warnings/errors and ordinary milestones use the selected single stdout
  canonical stream, with severity represented by `LEVEL`.
- Prove the selected all-stdout chronological contract with injected writable
  streams: sequence numbers increase, queued writes preserve order through
  backpressure, and renderer failure changes the exit result without creating a
  duplicate canonical terminal line.
- Use a writable test double whose final `write()` returns `false` and delays
  `drain`; prove `smashAction()` remains pending and then resolves only after the
  final `run.completed`/`run.failed` line is observed. Cover writer error and
  premature close: one stderr diagnostic, no recursive event, and the documented
  result-code precedence.
- Prove identical provider progress is deduplicated without losing cumulative
  tool-call counts.

### Plain-mode integration tests

- Replace panel-block assertions with ordered milestone assertions for:
  `REJECTED → follow-up → APPROVED`, terminal `unknown`, missing artifact, auth
  failure, timeout, transport failure, max iterations, interruption, ownership loss,
  implementation closeout success, and blocked closeout.
- Assert each semantic milestone appears exactly once.
- Assert `renderPlainPanel`, `renderPanel`, `ora`, `console.clear`, alternate-screen
  bytes, and periodic redraw timers are never used by `orc smash --plain`.
- Exercise real `bin/orc.js --plain` output from the compiled build and prove lines
  remain append-only when stdout is piped/non-TTY and when stdout+stderr are merged.
- Invoke compiled `bin/orc.js` for every command early/terminal path: missing
  project, ownership admission, config/manifest, no/invalid loop, interactive-flag
  rejection, state/implement preflight, runner resolution, max iterations, thrown
  loop, ownership finalization, and each loop/execution terminal branch. Assert
  one typed `run.failed` or `run.completed` event, correct exit status, no legacy
  text-only line, and the precise ownership opened/finalized facts where applicable.
- Repeat representative early-error, thrown-loop, ownership-finalization, and
  success paths with delayed `drain` to prove terminal output is flushed before the
  command promise and compiled process exit resolve.
- Feed adversarial unique lifecycle messages and tool-call bursts; assert the
  eight-event budget, stable sampling, suppression marker, and aggregate counts.
- Retain panel-mode regression coverage for menus, spinners, live region, errors, and
  final main-screen restoration.

### Runner-override unit tests

- Parse repeated valid entries for two or more skills.
- Reject malformed, empty, duplicate, unknown, and off-loop entries.
- Cover the complete precedence/coupled-pair matrix.
- Prove agent changes re-default their model.
- Prove model-only overrides validate against the effective agent.
- Cover OpenCode namespace validation, Codex/Claude separation, and the strict agy
  configured allow-list.
- Prove configs/profiles are not mutated.
- Test the `ResolvedRunner` source fields for every table row, map propagation
  through recursive transitions, and the policy that a plan-selected override is
  not consumed by a later implement/review loop.

### End-to-end runner tests

- Run the plan loop non-interactively with different audit and follow-up agents/models;
  prove adapter selection per step, artifact filenames, and provenance.
- Run the review loop with different review and review-follow-up runners.
- Run the implement loop with its explicit skill override.
- Prove unspecified skills fall back correctly and run-wide options still work.
- Prove invalid overrides fail before provider spawn and do not leave a resumable
  artifact or incorrectly advance workflow state.
- Prove mixed-runner interrupted/resumed chains preserve existing session-continuity
  rules, including matching explicit overrides, mismatched-provider/model rejection
  before spawn, and metadata that remains artifact-derived.
- Cover `--audit-continuity`, the Codex legacy alias, mutual-exclusion rejection,
  unsupported-loop/provider rejection, second-opinion freshness, and continuity
  combined with per-skill overrides in `tests/loop-continuity.test.ts` and
  command-level tests. From persisted metadata, prove flag-off follows a fresh
  rejected chain, flag-on resumes the same session for follow-up and next audit,
  the seed audit is fresh, and no `--last`/history lookup occurs. Cover missing
  seed session, runner mismatch, approved boundary, and unconfigured recorded
  runner as fail-before-spawn continuity failures.
- For CLI grammar, prove repeated Commander collection, all decision-table modes,
  invalid per-skill flags without `--loop`, and that every rejection makes no
  prompt, no ownership record, no adapter run, and no artifact.

### Repository gates

- `pnpm typecheck`
- `pnpm build`
- `pnpm test`
- env-gated real-provider contract checks remain release sign-off requirements;
  deterministic adapter seams cover per-skill routing in normal CI.

## Documentation Changes

Update together with implementation:

- `README.md`: define panel vs plain vs debug output and document per-skill examples;
- `README.md`: document v1 event compatibility, single-stream plain ordering, and
  escaping rules;
- `AGENTS.md`: record the event-stream boundary and new runner precedence;
- `docs/architecture/overview.md`: add the typed event projection and headless runner
  resolution flow;
- CLI `--help`: describe repeatable `--runner` and `--runner-model` options;
- remove or narrow documentation for `plain-render.ts` if it is no longer part of
  live `smash --plain` output.

Do not update `orc-smash-supervisor` yet. Its closed protocol allow-list does not
accept the new per-skill options, and launching it without explicit supported options
still cannot display orc-smash's interactive menus. A future supervisor plan should
consume the typed runner map and event stream rather than proxying a raw terminal.

## Implementation Order

1. Add and test the typed runtime-event contract, serialized writer/flush lifecycle,
   and pure plain formatter.
2. Route current lifecycle/decision/check milestones through the canonical event
   sink without changing panel behavior.
3. Remove panel snapshots from live plain mode and complete terminal-path coverage.
4. Add and test the generic repeated per-skill override parser.
5. Integrate per-skill precedence into runner resolution and loop setup.
6. Add mixed-runner end-to-end coverage and compiled-bin checks.
7. Update documentation and run all repository gates.
8. Audit the completed implementation before any supervisor integration work.

## Acceptance Criteria

- `orc smash --plain` emits only chronological event lines and never prints a panel
  block or terminal-control sequence.
- All meaningful milestones, warnings, and errors appear once and in causal order.
- `smashAction()` does not resolve or set the process result until the canonical
  terminal event has flushed; a writer failure returns the documented nonzero
  result without emitting a duplicate terminal event.
- Plain output clearly names loop, skill, version, runner, artifact, verdict/outcome,
  duration where available, failure reason, and final next action.
- Interactive panel behavior remains unchanged.
- A single headless command can choose different validated runner/model pairs for
  every skill in the selected manifest loop.
- Invalid runner entries fail before provider spawn with actionable diagnostics.
- Existing global overrides, defaults, artifact conventions, provenance, continuity,
  ownership, and provider boundaries remain compatible.
- Audit continuity is default-off and, when explicitly enabled, resumes only a
  matching supported provider/model from persisted primary-chain metadata; all
  ineligible or conflicting cases fail before provider spawn.
- Typecheck, production build, deterministic suite, and compiled-bin verification
  pass with no new orphaned provider processes.
- Documentation clearly states that supervisor support for these new options is
  deferred.

## Risks and Mitigations

- **Duplicate or reordered output:** emit each semantic event at one owning boundary
  and assert ordered, exactly-once streams end to end with sequence-serialized
  writes, awaited terminal flushes, and a real merged-descriptor transcript.
- **Plain output becomes noisy:** keep raw chunks/polling/render state out of the
  canonical catalogue; sample no more than eight bounded provider progress events
  and report suppression totals at terminal provider events.
- **Secret leakage:** use typed allow-listed event fields and adversarial formatter
  tests; never stringify arbitrary objects or environments.
- **Panel regression:** retain panel-specific state projection and comprehensive
  interactive regression tests while sharing only canonical milestones.
- **Runner precedence ambiguity:** centralize parsing/resolution and test the full
  coupled-pair/source-attribution matrix and continuity-conflict policy.
- **Continuity regression:** restore and test both documented flags, preserve
  artifact-derived session metadata, make flag-off explicitly fresh, and reject an
  explicit pair that conflicts with the recorded resumable runner before spawning.
- **Manifest drift:** validate skill IDs from the selected loop at runtime rather than
  hardcoding plan/review names.
- **Premature supervisor coupling:** explicitly keep supervisor protocol changes out
  of scope and document the current limitation.

## Definition of Done

- The plan has an approved independent audit.
- Both phases and their tests are implemented without supervisor changes.
- All acceptance criteria and repository gates pass.
- README, AGENTS, architecture, and CLI help agree with actual behavior.
- An independent implementation review finds no unresolved Critical or Major issue.
