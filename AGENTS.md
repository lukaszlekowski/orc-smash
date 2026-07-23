# AGENTS.md — orc-smash repo rules

> **Active architecture migration:** `docs/dev/plan.md` is the controlling target
> contract for the config-driven engine. Source and tests describe the current
> pre-migration runtime until each release lands. During this implementation, the
> plan overrides legacy-specific rules about `skills.yaml`, hardcoded
> plan/implement/review stages, fixed verdict words, audit-only continuity flags,
> filename heuristics, and automatic downstream transitions. It does **not**
> override the provider, ownership, signal-gate, interruption, timeout, event,
> logging, or supervisor-compatibility safety invariants in this file.

orc-smash is a **stateless subprocess harness**: it decides what coding-agent CLI to run, when,
reads the verdict, and loops. The agents do the LLM work; orc-smash never calls a model API
itself.

## 1. The v1 manifest and active plan are the target source of truth

- Replace `skills.yaml` with the single v1 manifest described by
  `docs/dev/plan.md`: packaged `config/orc-smash.yaml`, optional project
  `<project>/.orc-smash.yaml`, and explicit `--config` precedence. Do not retain a
  compatibility loader or a second execution engine.
- The manifest owns generic skills, roles, reusable approval-loop/task bindings,
  linear pipeline stage instances, per-skill runner profiles, prompt inputs,
  output patterns, output contracts, and configurable decision tokens. TypeScript
  must not branch on the literal workflow names `research`, `plan`, `implement`,
  or `review`.
- Role and skill definition paths resolve from `manifestRoot`. Targets, named
  project inputs, and output patterns resolve from `projectRoot`; missing project
  inputs affect action availability/preflight and do not invalidate the manifest.
- `prompt-composer.ts` renders declared inputs generically. Built-ins are `target`,
  `version`, `priorArtifact`, and `outputPath`; additional project-file inputs are
  keys in a binding's `files:` map.
- Workflow artifacts and their provenance—not hardcoded filename categories—are
  the durable source of run, chain, stage, runner, effort, session, and lineage
  state. Old artifacts without the v1 identity contract are unclassified rather
  than specially migrated.
- Keep this file, `README.md`, and `docs/architecture/overview.md` synchronized
  with `docs/dev/plan.md` as releases land.

## 1a. Architecture direction matters as much as feature scope

- Refactors must introduce **purposeful module boundaries**, not generic helper buckets.
- A new file is justified only when it owns a stable responsibility, shared domain rule, or
  testable contract.
- Prefer small pure modules for single-source-of-truth rules such as artifact-path rendering,
  next-step resolution, and shared runtime contracts.
- Avoid files such as `helpers.ts`, `common.ts`, or `misc.ts` unless the responsibility name is
  genuinely precise and durable.
- Keep orchestration thin and keep provider-specific behavior behind adapters.

## 2. Runners are per-skill; four real adapters behind one seam

- Each skill declares a `runnerProfile` that selects its default provider; the
  provider catalogue supplies its default model. The operator selects the
  provider, model, effort, and session strategy independently for each skill in
  the selected loop/task. A two-skill approval loop selects the complete upcoming
  pair before execution and does not re-prompt between its steps.
- **All four providers — `opencode`, `codex`, `claude`, `agy` (Antigravity) — are real runnable
  adapters** (no stubs); `fake` is a deterministic no-spawn adapter for tests.
- Agent and model are a **coupled pair** (each CLI has its own model-id namespace). Runner
  precedence per skill: interactive per-skill pick > `--runner`/`--runner-model` per-skill CLI
  override > `--agent`/`--model` (run-wide) > skill runner profile > provider default model.
  **Changing an agent re-defaults its model** to that agent's catalogue default
  (`registry.providers.<agent>.defaultModel`; catalogues and profiles are never mutated).
  During the migration, CLI override scope must follow the selected generic
  loop/task/pipeline contract rather than assuming only `--loop`. `runner.ts` resolves this with the
  `ResolvedRunner` type carrying `agentSource`/`modelSource` attribution; `loop.ts` selects
  the adapter **per step**
  from the registry passed via `LoopOptions.registry`. The production registry (`registry.ts`)
  excludes `fake`, which is only available in the test registry (`testing.ts`).
- **Artifact filenames follow each binding's validated `output.pattern`.** The
  pattern supplies `{version}` and `{provider}`; model and effort belong in
  provenance, not filenames. Do not hardcode audit/review filename families in
  state detection.
- All agents implement `AgentAdapter` (`buildRun` + `run`). Agents are black boxes — opaque
  native binaries invoked over `stdio + args`. orc-smash never imports them or shares a runtime.
- Headless agents that must write files require the provider's autonomy flag
  (`--dangerously-skip-permissions` for opencode, `--permission-mode bypassPermissions` for
  claude, `--dangerously-bypass-approvals-and-sandbox` for codex, and
  `--dangerously-skip-permissions` for agy); without it the run silently stalls.
- **Model ID namespaces are strictly validated**: `runner.ts` resolves model names, and opencode
  specifically enforces namespace patterns (e.g. `opencode-go/` or `opencode/`) via the
  `isOpencodeModelId` regex-based predicate to prevent cross-agent model leakage. `agy` accepts
  **only** the exact human-readable names configured in `providers.agy` (a strict allow-list with
  input trimming — no namespace fallback; `gpt-5.5`, `opencode/...`, `claude-...` are rejected).
- **`agy` auth caveat**: when unauthenticated, `agy` can ignore `--model`, fall back to a default
  provider, and exit 0 — which would otherwise look like success. `src/adapters/agy.ts` detects
  this with a bounded phrase list (`AGY_AUTH_FAILURE_PATTERNS` over combined stdout+stderr; benign
  substrings like `author`/`authority`/`authentication succeeded` do not match) and returns a
  structured `error.kind === 'auth'`. The adapter owns detection only; `src/loop.ts` owns the
  artifact cleanup (it is the only module that knows the resolved output path) and quarantines the
  partial artifact so no resumable `docs/dev/*-vN-agy.md` file remains.
- **Watchdog timeout policy**: Runs are protected by config-driven execution timeouts. For `opencode`,
  the watchdog timeout is determined by the following precedence: `OPENCODE_RUN_TIMEOUT_MS` environment
  variable > registry configuration `timeouts.opencode` > built-in default of `600000` ms (10 minutes).
  A timeout value of `0` disables the watchdog. `claude`, `codex`, and `agy` are **config-only**:
  `timeouts.<agent>` > built-in `0` (disabled by default); there are **no env vars** for these agents.
  A timeout is an absolute wall-clock deadline, not an inactivity detector; it can expire while a provider
  is still actively using tools. It surfaces `error.kind === 'timeout'` and a failed lifecycle event.
- **Interrupted runs are visible and resumable**: `SIGINT`/`SIGTERM` writes a durable marker under
  the active project root (`src/interrupted-artifact.ts`), terminates in-flight provider children
  (`terminateActiveChildren` in `src/adapters/utils.ts`), and exits with the conventional signal
  code. A rerun quarantines the partial/late artifact before any state scan, so an interrupted run
  never resolves to terminal `unknown` and never advances state incorrectly. Marker-first
  authority remains invariant: the current runtime's `marker.loop`/audit-history implementation
  is migrated to generic binding/chain identity rather than retained as a hardcoded loop rule.
  Normal decision-path scanning never treats a synthetic interrupted step as completed evidence.
- **Adding a provider is not "one file."** It requires one adapter file **plus** registry
  wiring, a per-agent default model in config, agent/model-namespace validation, an env-gated
  contract test, an interactive option, and doc updates across
  `AGENTS.md` / `README.md` / `docs/architecture/overview.md`.

## 3. `unknown` is terminal; repair is gated on configured retry

- A `decision-artifact` normalizes the binding's configured accepted/retry tokens
  to `accepted | retry | unknown`; the parser never throws. `APPROVED` and
  `REJECTED` are defaults in packaged workflows, not runtime literals.
- `unknown` (missing/malformed output, parse miss, invalid contract, or transport
  failure) stops the active step safely. The target is never treated as accepted
  and the workflow never advances on unknown evidence.
- Execution-completeness signals are part of this rule when an adapter can provide them. In the
  current repo direction, `opencode` is the only provider with a verified completion signal
  (`stopReason`); `codex` and `claude` still rely on exit code + structured error handling until
  proven otherwise.
- Repair runs only on a concrete configured `retry` decision—never on `unknown`
  or `accepted`. `completion-artifact` separately normalizes `COMPLETED`,
  `BLOCKED`, or `unknown` as defined by the plan.

## 4. Post-acceptance offers a second opinion

- After an approval loop reaches its configured accepted decision, the action
  surface keeps a second opinion visible. A second opinion is an independent
  chain root with no inherited provider session. It does not automatically start
  a downstream stage.

## 5. Statelessness; one runner per target

- The tool holds only config. Per-run state is reconstructed from validated
  workflow artifacts and provenance on each run; no hidden runtime database or
  shell-history inference is introduced.
- One runner per target. Concurrent runs on *different* targets are fine and must not
  interfere (proven by the dual-target isolation e2e).
- **Per-skill continuity:** continuity is selected per skill after provider/model/
  effort selection and is enabled only when the selected adapter declares
  `resumeSession`. Unsupported choices remain visible with a reason. Session IDs
  are captured from provider streams and persisted in artifact provenance;
  resumption never uses `--last`, shell history, or a provider-name allowlist.
  The legacy `--audit-continuity` and `--codex-audit-continuity` flags and their
  plan/review-only policy are migration inputs to remove, not constraints on the
  target engine. Second opinions remain fresh.

## 5a. Commit message hygiene

- Commit messages must not include agent-signature or attribution lines such as `designed by claude`, `generated by codex`, or similar AI-authorship boilerplate.

## 5b. Companion macOS supervisor compatibility

- `orc-smash-supervisor` is a separate per-user macOS LaunchAgent and the current
  operator-facing issuer of this repository's app-owned run contract. It launches a
  pinned absolute `bin/orc.js`; `orc-smash` must not import or depend on the supervisor.
- Installing the supervisor does not intercept ordinary `orc smash` invocations.
  Supervision applies only to runs launched through its authenticated protocol.
- Treat `ORC_RUN_ID`, `ORC_RUN_TOKEN`, `ORC_RUN_STATE_DIR`, `control.json`,
  `active.json`, canonical-project admission, lease timing, process identity, and
  `kill-gate` behavior as a cross-repository compatibility surface.
- Any incompatible change to that surface requires coordinated supervisor updates,
  a new pinned `orc-smash` commit, cross-repository contract verification, and a rerun
  of the real macOS supervisor release gate. Durable macOS records must never gain
  unattended signal authority during such a change.
- The stable production and supervisor entrypoint is `bin/orc.js`. Run `pnpm build`
  before production execution; it loads `dist/src/cli.js` in the same process and
  exposes `orc supervisor-contract` for strict cross-repository compatibility checks.
  `dist/src/cli.js` is an internal artifact and must not replace the public install path.

## 5c. Authorized kill gate — every group signal is gated

- The only `process.kill(-pgid, …)` in the CLI lives in `src/kill-gate.ts` (`killProcessGroupGated`).
  Never add a bare negative-PID kill elsewhere. App-owned mode (`ORC_RUN_ID` + `ORC_RUN_TOKEN`) uses
  **portable POSIX process groups, not cgroup-v2** (cgroup-v2 is unavailable on macOS).
- The gate structurally rejects `pgid <= 1`, the CLI's own pid, and the CLI's own + ancestor
  process groups, and identity-authorizes every real signal by re-resolving the recorded leader.
  An unverifiable, forbidden, or recycled PGID is **never** signalled — the run fail-closes
  (retains admission, records a terminal ownership-failure). Resolve the CLI's own group via `ps`,
  never via `process.kill(0, …)` (that targets the caller's own group).
- Residual risk is accepted and documented: a descendant that outlives the leader is not
  auto-stopped. Do not "fix" this by killing an unverifiable group. See the Architecture Decision
  Note in `docs/dev/plan.md`.
- Retained admission is diagnosed with `orc ownership status --project <path>` and released only
  with `orc ownership release --project <path> [--yes]` after operator verification. Recovery
  never signals a process; it marks `failed: operator-released` before removing the matching lock.

## 6. Plan before implementation; verify every real provider path

- `docs/dev/plan.md` is the design source of truth for active planned work and
  is audited and repaired through the configured `plan` approval loop before
  implementation. A separate `docs/dev/research.md` is not a universal
  prerequisite and is not a stage in the current pipeline. Implement the
  approved plan's release boundaries and acceptance gates even where legacy
  descriptions differ. Do not use an old audit artifact as an architectural
  constraint; audit-response bookkeeping remains in versioned artifacts.
- All behavior ships with tests. The deterministic e2e (`fake` adapter + fixtures) gates the
  **harness logic** (incl. provenance, dual-target isolation, and mixed-runner loops). The
  contract-gated real provider paths are `opencode`, `codex`, and `claude`; `agy` remains a real
  adapter but is verified through deterministic seam coverage plus manual operator verification from
  an already-authenticated shell because its browser login flow is not suitable for an automated
  contract gate. `codex`/`claude`/`agy` watchdog timeouts and `agy` auth-failure cleanup are also
  proven by deterministic seam tests plus a loop-level contract.
- A GitHub Actions CI workflow runs typecheck and deterministic tests on push and pull requests,
  while real-provider verification remains an env-gated/manual release sign-off requirement.
