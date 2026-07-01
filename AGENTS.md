# AGENTS.md — orc-smash repo rules

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

- Each skill declares its own default `agent`/`model`; the operator can override any skill's
  runner per run. Different skills in one loop may run on different CLIs/models.
- **All four providers — `opencode`, `codex`, `claude`, `agy` (Antigravity) — are real runnable
  adapters** (no stubs); `fake` is a deterministic no-spawn adapter for tests.
- Agent and model are a **coupled pair** (each CLI has its own model-id namespace). Runner
  precedence per skill: interactive per-skill pick > `--agent`/`--model` (run-wide) > skill
  manifest default > `.env` default. **Changing an agent re-defaults its model** to that
  agent's default model (`registry.providers.<agent>[0]`; the global `defaults.agent/model`
  pair is never mutated). `runner.ts` resolves this; `loop.ts` selects the adapter **per step**
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

## 5a. Commit message hygiene

- Commit messages must not include agent-signature or attribution lines such as `designed by claude`, `generated by codex`, or similar AI-authorship boilerplate.

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
