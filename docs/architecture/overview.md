# orc-smash — Architecture Overview

orc-smash is a **stateless subprocess harness** that drives coding-agent CLIs through skill-based
`audit ↔ follow-up` loops until a verdict is APPROVED, then stops for human review (or runs a
second-opinion pass). The agents do the LLM work; orc-smash decides what to run, when, reads the
result, and loops. Detailed implementation planning for current runtime cleanup lives in
`docs/dev/plan.md`. Rules: `../AGENTS.md`.

This document is the canonical architecture overview for the repo. `README.md` should stay
shorter and point here rather than restating the same internals in full.

## Current module map

```
cli.ts ──▶ commands/{smash,status}.ts
                │
                ├─ config.ts        loads model registry (orc.config.yaml) + skills.yaml → typed Config
                ├─ manifest.ts      zod schema + validation (source of truth: skills.yaml, validates model registry)
                ├─ runner.ts        per-skill {agent,model} resolution (agent model namespaces validation)
                ├─ state.ts         scan target docs/dev → normalized artifact and implement facts
                ├─ follow-up-outcome.ts shared outcome enum, parser, and heading contract
                ├─ interactive.ts   registry-driven prompts, filtered to configured ∩ runnable agents
                ├─ loop.ts          three-stage pipeline orchestrator (plan → implement → review)
                ├─ implement-ledger.ts implementation ledger tables and confidence validator
                ├─ plan-closeout.ts plan front-matter status closeout and change log appender
                ├─ prompt-composer  role + skill + resolved inputs → one prompt string
                ├─ status.ts        pure next-step-message & PanelContext builders
                ├─ status-panel.ts  pure ASCII boxen/table dashboard string renderer
                ├─ cli-output.ts    event-driven terminal output seam (panel/plain modes)
                └─ adapters/        registry: explicit production registry (registry.ts) vs testing registry (testing.ts)
```

Pure, I/O-free logic (`verdict`, `state`, `follow-up-outcome`, `prompt-composer`, `runner`, status context, adapter arg builders) is
isolated so it unit-tests without spawning agents.

## Testing architecture and shared setup

Deterministic harness behavior is covered under `tests/` using the `fake` adapter. Repeated test mechanics are centralized in `tests/helpers/*` (such as `fs.ts` for temp directories, `fake-adapter.ts` for adapter control, `provenance.ts` for metadata, and `results.ts` for run fixtures).

To guarantee test isolation:
- `vitest.config.ts` registers `tests/setup.ts` as a global setup file.
- `tests/setup.ts` enforces the invariant that the global fake-adapter state is reset `beforeEach` test, preventing leakages between tests while letting file-local overrides win.

## Target direction

The codebase is being steered toward these architectural properties:

- **Clear responsibility modules:** artifact path rules, next-step rules, and shared runtime
  contracts each live in one clearly named module.
- **Thin orchestration:** `loop.ts` should orchestrate step flow, not own every detail of
  rendering, prompting, process execution, artifact writing, and verdict parsing inline.
- **Shared runtime contracts, provider-local parsing:** common runtime code consumes normalized
  results; provider-specific stream parsing and remediation stay in adapter code.
- **No generic helper sprawl:** new files are justified only by stable responsibility, shared
  domain rule, or testable contract.
- **Incremental evolution:** runtime seams should support later work like plain rendering and live
  status without forcing a top-down rewrite.

## Data flow — one `orc smash` run

1. `config` loads the model registry (`orc.config.yaml`) and `skills.yaml`. Model registry validations verify that every skill's model is valid.
2. `state.scan` globs target's versioned artifacts, parses metadata, and scans implementation ledgers to map current progress across plan, implement, and review stages.
3. `interactive` proposes loop / per-skill runners / start-point / max-iters (with loop default resolved using implementation facts); `commands/smash` normalizes overrides and validates agent model selections against the registry.
4. `loop` drives the loop execution:
   - For `implement` kind, it requires an approved plan audit. Once the agent writes its ledger, `implement-ledger` parses and validates the tables (evidence and coverage) and the overall confidence declaration. On success, `plan-closeout` updates `docs/dev/plan.md`'s front matter status (to `done` or `blocked` based on a 0.95 confidence threshold) and appends a structured versioned log entry under `## Change Log`. The loop stamps the harness metadata provenance onto the ledger only if the closeout was successful and the confidence met the threshold.
   - For `doc-audit`/`code-review` loops, it iterates versioned audits and follow-ups.
5. In interactive runs, stage transitions advance downstream:
   - `plan` loops APPROVED verdict offers `stop | run-second-opinion | implement` (`run-second-opinion` is offered only when a different configured+runnable agent exists).
   - `implement` stage complete offers `stop | review` to start code review.
   - `review` loops APPROVED verdict offers `stop | run-second-opinion` (`run-second-opinion` is offered only when a different configured+runnable agent exists).
6. Each execution step resolves its runner → `prompt-composer` assembles role + skill + inputs → the adapter spawns the agent → versioned output is verified and metadata provenance is written.
7. `cli.ts` serves as the single process-exit boundary mapping structured `CommandResult` to process exit code.

## Execution completeness

The harness distinguishes between:

- **process / transport failure**: spawn failure, nonzero exit, timeout, structured adapter error
- **successful completion**: the provider completed cleanly enough that artifact inspection is trustworthy
- **terminal unknown**: the provider appeared to run but did not complete in a trustworthy way

In the current repo direction, `opencode` is the only adapter with a verified completion signal
(`stopReason`) that can support this distinction. `codex` and `claude` currently remain exit-code
/ structured-error based until equivalent support is explicitly proven and implemented.

### Model-id ownership boundary

orc-smash stores model ids verbatim (one opaque string per skill) and never splits them.
The `provider/` prefix in opencode model ids (e.g. `opencode-go/deepseek-v4-flash`) is
opencode's own transport/endpoint namespace, not an orc-smash concept — orc-smash validates
only per-provider shape via `runner.ts:isOpencodeModelId`. codex and claude ids have no
`provider/` segment and are validated by separate rules (`model.startsWith('claude-')` for
claude; no opencode/claude prefix for codex). `agy` (Antigravity) model ids are the exact
human-readable names printed by `agy models`; `runner.ts` accepts **only** the configured
`providers.agy` allow-list (with input trimming) — no namespace fallback — so `gpt-5.5`,
`opencode/...`, and `claude-...` are rejected for `agy`.

### Timeout policy

- **opencode** (env tier): `OPENCODE_RUN_TIMEOUT_MS` env > `registry.timeouts.opencode`
  (config tier) > built-in 600000 ms (10 minutes). A value of `0` (or env `"0"`) disables the
  watchdog. The single source of truth is the pure `resolveOpencodeTimeoutMs` in
  `src/adapters/utils.ts`; `spawnOpencode` and `createOpencodeAdapter` use it. There is no
  per-call programmatic override — the option is the config-driven default, not an override. The
  production registry accepts an optional `opencodeSpawn` test seam; production code never passes it.
- **claude / codex / agy** (config-only): `registry.timeouts.<agent>` > built-in `0` (disabled by
  default); there are **no env vars**. The single source of truth is the pure
  `resolveConfigOnlyTimeoutMs` (aliased as `resolveClaudeTimeoutMs` / `resolveCodexTimeoutMs` /
  `resolveAgyTimeoutMs`) in `src/adapters/utils.ts`. Each factory adapter
  (`createClaudeAdapter` / `createCodexAdapter` / `createAgyAdapter`) threads the resolved
  deadline into `spawnAgentProcess` via its lifecycle/options object (no positional param); no CLI
  timeout flag is used. A timeout surfaces `error.kind === 'timeout'` and a failed lifecycle event.
  The production registry resolves these via `registryTimeoutFor` and accepts optional
  `codexProcessRunner` / `claudeProcessRunner` / `agyProcessRunner` test seams; production code
  never passes them.

### `agy` auth-failure detection

When unauthenticated, `agy` can ignore `--model`, fall back to a default provider, and exit 0 —
which would otherwise look like success. `src/adapters/agy.ts` owns **detection only**: a bounded
phrase list `AGY_AUTH_FAILURE_PATTERNS` (whole-token/whole-phrase matches over combined
stdout+stderr; benign substrings like `author`/`authority`/`authentication succeeded` do not match)
sets `error.kind === 'auth'`. The adapter never resolves/mutates artifact paths (`RunInput`
carries none); `src/loop.ts` owns the cleanup and quarantines the resolved artifact on `'auth'` so
no resumable `docs/dev/*-vN-agy.md` file remains.

### Interrupted runs

`SIGINT`/`SIGTERM` (wired in `src/cli.ts`) delegate to the interrupt-context API in
`src/interrupted-artifact.ts`, which writes a durable marker under the active project root,
terminates in-flight provider children via `terminateActiveChildren` (`src/adapters/utils.ts`:
SIGTERM → SIGKILL after a bounded grace), and exits with the conventional signal code. A rerun
quarantines the partial/late artifact before any decision-path scan (`commands/smash.ts` at setup
time and `loop.ts` at loop start), so an interrupted run never resolves to terminal `unknown` and
never advances state incorrectly. `orc status` selects the loop **marker-first**
(`marker.loop` beats the audit-history heuristic in `commands/status.ts`) and renders the
interrupted stage via the display-only `scanForStatus` helper in `src/state.ts`. Normal
decision-path `scan()` never includes synthetic interrupted steps.

## Key invariants

- **Four real adapters; per-skill runners:** opencode, codex, claude, and agy all run for real; each
  skill declares its own agent/model (overridable per run). Agent and model are a coupled pair —
  switching agent re-defaults model. The adapter is selected per step, so stages can mix CLIs.
- **Explicit Registries:** The production adapter registry registers only real adapters; test-only adapters (such as `fake`) are registered via a separate test registry constructor (`testing.ts`).
- **Manifest-as-data:** loops, skills, roles, and per-loop input schemas live in `skills.yaml`.
  A loop using the existing input sources (`target`, `version`, `priorAudit`, `outputPath`,
  `planPath`, `checklistPath`) is added via YAML only (no TS).
- **One composed prompt:** each agent run gets role + skill + inputs — no task content is invented.
- **Single-source-of-truth runtime rules:** path rendering/parsing, next-step resolution, and
  shared contracts should not be reimplemented ad hoc across multiple files.
- **Model ids are opaque-per-provider; the `provider/` prefix is the provider's own concern:**
  opencode's `run -m` requires `provider/model`; the first segment is opencode's transport
  namespace, not an orc-smash concept. orc-smash stores ids verbatim and validates only
  per-provider shape. codex/claude ids have no `provider/` segment. Do not split
  endpoint/model in the shared registry.
- **Opencode execution timeout is config-driven-first:** precedence is `OPENCODE_RUN_TIMEOUT_MS`
  env > `registry.timeouts.opencode` > built-in 600000 ms. `0` disables. The pure
  `resolveOpencodeTimeoutMs` function in `src/adapters/utils.ts` is the single source of truth.
- **`unknown` is terminal:** a missing/malformed verdict stops the loop for human review; the
  target is never mutated on a parse miss. Follow-up runs only on a concrete REJECTED audit.
- **Black-box agents:** providers are opaque native binaries invoked over stdio + args; the
  harness never imports them. Headless writes require the provider's autonomy flag.
- **Stateless; isolated per target:** the tool holds only config; all per-run target state is
  derived from filenames. One runner per target; different targets never interfere (dual-target
  e2e proves it).
- **Codex audit continuity (opt-in):** As an explicit architectural exception to pure statelessness, the `--codex-audit-continuity` option allows Codex audits in the `plan` or `review` loops to resume the same session ID. The session ID is captured from the live `thread.started` event stream and persisted explicitly in artifact metadata (`sessionMode`, `sessionId`). Resuming is strictly artifact-driven (re-read from front matter) rather than hidden-session-driven (does not use `codex exec resume --last`), and second opinions remain fresh.
- **Verify every real path & CI:** a GitHub Actions CI workflow gates the codebase using deterministic checks (typecheck + test runs on `fake` adapter). Real-provider paths for opencode, codex, and claude remain covered by env-gated contract tests; agy stays a real adapter but is verified manually from an already-authenticated shell because its browser login flow is not suitable for an automated contract gate.
