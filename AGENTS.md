# AGENTS.md — orc-smash repo rules

> Temporary notice: This document may contain outdated guidance and will be updated in the near future. Verify behavior against the current source and tests.

orc-smash is a **stateless subprocess harness**: it decides what coding-agent CLI to run, when,
reads the verdict, and loops. The agents do the LLM work; orc-smash never calls a model API
itself.

## 1. Manifest-as-data is the source of truth

- Loops, skills (with **per-skill runner defaults**), roles, and per-loop input schemas live in
  `skills.yaml`. No loop logic is hardcoded in TS.
- `prompt-composer.ts` renders the prompt generically from a loop's declared `inputs:` list.
- The input source set is `target`, `version`, `priorAudit`, `outputPath`, `planPath`,
  `checklistPath`. Adding a loop that uses these sources = one YAML entry + two skill files,
  **no TS changes**. A novel input source needs one resolver line in `prompt-composer.ts`.
- These docs must stay synchronized with `docs/dev/plan.md` on manifest semantics, the runner
  model, and verification gates.

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

- Each skill declares a `runnerProfile` that selects its default provider; the provider catalogue supplies its default model. The operator can override any skill's
  runner per run. Different skills in one loop may run on different CLIs/models. On a `CONTINUE`
  runner per run. Different skills in one loop may run on different CLIs/models. On interactive actions,
  the operator selects the full upcoming pair of runners up front, with subsequent steps reusing the
  up-front selections without mid-chain re-prompts.
- **All four providers — `opencode`, `codex`, `claude`, `agy` (Antigravity) — are real runnable
  adapters** (no stubs); `fake` is a deterministic no-spawn adapter for tests.
- Agent and model are a **coupled pair** (each CLI has its own model-id namespace). Runner
  precedence per skill: interactive per-skill pick > `--agent`/`--model` (run-wide) > skill
  runner profile > provider default model. **Changing an agent re-defaults its model** to that
  agent's catalogue default (`registry.providers.<agent>.defaultModel`; catalogues and profiles
  are never mutated). `runner.ts` resolves this; `loop.ts` selects the adapter **per step**
  from the registry passed via `LoopOptions.registry`. The production registry (`registry.ts`)
  excludes `fake`, which is only available in the test registry (`testing.ts`).
- **Audit filenames follow the skill's convention** `docs/dev/<type>-v{n}-{agent}.md`
  (the `21-simple-plans-audit` / review skills hardcode this shape). A model slug is
  intentionally **not** added — diverging from the skill's template risks the agent writing to
  the templated path and breaking state detection. orc-smash records the model itself via a
  provenance stamp (`provenance.ts`).
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
  A timeout surfaces `error.kind === 'timeout'` and a failed lifecycle event.
- **Interrupted runs are visible and resumable**: `SIGINT`/`SIGTERM` writes a durable marker under
  the active project root (`src/interrupted-artifact.ts`), terminates in-flight provider children
  (`terminateActiveChildren` in `src/adapters/utils.ts`), and exits with the conventional signal
  code. A rerun quarantines the partial/late artifact before any state scan, so an interrupted run
  never resolves to terminal `unknown` and never advances state incorrectly. `orc status` selects
  the loop **marker-first** (`marker.loop` beats the audit-history heuristic) and renders the
  interrupted stage via the display-only `scanForStatus` helper in `src/state.ts`. Normal
  decision-path `scan()` never includes synthetic interrupted steps.
- **Adding a provider is not "one file."** It requires one adapter file **plus** registry
  wiring, a per-agent default model in config, agent/model-namespace validation, an env-gated
  contract test, an interactive option, and doc updates across
  `AGENTS.md` / `README.md` / `docs/architecture/overview.md`.

## 3. `unknown` is terminal; follow-up is gated on REJECTED

- `verdict.ts` returns `APPROVED | REJECTED | unknown` and never throws.
- `unknown` (missing file, malformed `## Verdict`, stdout parse miss, transport failure) stops
  the loop for human review. The target is **never** mutated on a parse miss or infrastructure
  failure.
- Execution-completeness signals are part of this rule when an adapter can provide them. In the
  current repo direction, `opencode` is the only provider with a verified completion signal
  (`stopReason`); `codex` and `claude` still rely on exit code + structured error handling until
  proven otherwise.
- Follow-up runs **only** on a concrete `REJECTED` audit — never on `unknown` or `APPROVED`.

## 4. Post-approval offers a second opinion

- On APPROVED the loop offers `stop | run-second-opinion`. Second-opinion re-prompts the audit
  skill's runner (defaulting to a different agent than the one that just approved) and runs the
  next audit version — the v2+ independent pass the audit skills are built around.

## 5. Statelessness; one runner per target

- The tool holds only config. All per-run target state is read from the
  target's `docs/dev/` filenames on each run; nothing is persisted or resumed by the tool.
- One runner per target. Concurrent runs on *different* targets are fine and must not
  interfere (proven by the dual-target isolation e2e).
- **Audit continuity exception**: When `--audit-continuity` is enabled on the `plan` or `review` loop, the harness offers an opt-in mode where subsequent audit steps in the primary rejected chain resume the same session ID. Supported for `codex`, `opencode`, and `claude` providers. The session ID is captured from the live provider streams on the first step and recorded explicitly in artifact metadata (`sessionMode`, `sessionId`). Resuming does not use `--last` or local shell/process history; the artifact metadata remains the source of truth, and second opinions do not inherit the session. The legacy `--codex-audit-continuity` is kept as a temporary Codex-only alias. Both flags are mutually exclusive.

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

- `docs/dev/plan.md` is the design source of truth and is audited (`21-simple-plans-audit`) and
  repaired (`22-simple-plans-follow-up`) before implementation. Do not implement features that
  contradict an un-approved plan. Keep audit-response bookkeeping in versioned audit artifacts,
  not in the plan body.
- All behavior ships with tests. The deterministic e2e (`fake` adapter + fixtures) gates the
  **harness logic** (incl. provenance, dual-target isolation, and mixed-runner loops). The
  contract-gated real provider paths are `opencode`, `codex`, and `claude`; `agy` remains a real
  adapter but is verified through deterministic seam coverage plus manual operator verification from
  an already-authenticated shell because its browser login flow is not suitable for an automated
  contract gate. `codex`/`claude`/`agy` watchdog timeouts and `agy` auth-failure cleanup are also
  proven by deterministic seam tests plus a loop-level contract.
- A GitHub Actions CI workflow runs typecheck and deterministic tests on push and pull requests,
  while real-provider verification remains an env-gated/manual release sign-off requirement.
