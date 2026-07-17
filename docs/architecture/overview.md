# orc-smash — Architecture Overview

> Temporary notice: This document may contain outdated guidance and will be updated in the near future. Verify behavior against the current source and tests.

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
                ├─ config.ts        assembles config/providers/*.yaml, config/registry.yaml, and overrides → typed Config
                ├─ manifest.ts      zod schema + validation (source of truth: skills.yaml, validates model registry)
                ├─ runner.ts        per-skill {agent,model} resolution (agent model namespaces validation)
                ├─ state.ts         scan target docs/dev → normalized artifact and implement facts
                ├─ follow-up-outcome.ts shared outcome enum, parser, and heading contract
                ├─ interactive.ts   registry-driven prompts, filtered to configured ∩ runnable agents
                ├─ loop.ts          public three-stage pipeline facade (plan → implement → review)
                ├─ loops/           execution, runner-selection, and shared loop contracts
                ├─ implement-ledger.ts implementation ledger tables and confidence validator
                ├─ plan-closeout.ts plan front-matter status closeout and change log appender
                ├─ prompt-composer  role + skill + resolved inputs → one prompt string
                ├─ status.ts        pure next-step-message & PanelContext builders
                ├─ status-panel.ts  pure ASCII boxen/table dashboard string renderer
                ├─ cli-output.ts    event-driven terminal output seam (panel/plain modes)
                ├─ run-ownership.ts  schema-versioned admission, lease clock, lifecycle
                ├─ process-identity.ts + kill-gate.ts  typed identity and signal authority
                ├─ owned-runtime-registry.ts  fresh live group capabilities
                └─ adapters/        registry plus process-group bootstrap/runtime
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

1. `config` assembles packaged provider catalogues (`config/providers/*.yaml`), runner profiles (`config/runners.yaml`), and timeout settings (`config/registry.yaml`) before loading `skills.yaml`. Each catalogue owns its `models` list and `defaultModel`; manifest skills name only a runner profile.
2. `state.scan` globs target's versioned artifacts, parses metadata, and scans implementation ledgers to map current progress across plan, implement, and review stages.
3. `interactive` proposes loop / per-skill runners / start-point / max-iters (with loop default resolved using implementation facts); `commands/smash` normalizes overrides and validates agent model selections against the registry.
4. `loop` drives the loop execution:
   - For `implement` kind, it requires an approved plan audit and runs `plan-metadata` preflight before provider work. That module migrates a leading legacy Markdown status into parseable YAML front matter with `status: ready`; malformed YAML and unreadable plans fail closed. Once the agent writes its ledger, `implement-ledger` validates the evidence/coverage tables and confidence declaration. `plan-closeout` updates canonical YAML status (`done` or `blocked` at the 0.95 threshold) and appends a structured versioned `## Change Log` entry. Provenance is stamped only after a successful done closeout. A complete unstamped raw ledger is recoverable only through an explicit interactive action, which reuses its version and never spawns a provider.
   - For `doc-audit`/`code-review` loops, it iterates versioned audits and follow-ups.
5. In interactive runs, stage transitions advance downstream:
   - `plan` loops APPROVED verdict offers `stop | run-second-opinion | implement` (`run-second-opinion` is offered only when a different configured+runnable agent exists).
   - `implement` stage complete offers `stop | review` to start code review.
   - `review` loops APPROVED verdict offers `stop | run-second-opinion` (`run-second-opinion` is offered only when a different configured+runnable agent exists).
6. Each execution step consumes its resolved runner (resolved up-front in interactive mode) → `prompt-composer` assembles role + skill + inputs → the adapter spawns the agent → versioned output is verified and metadata provenance is written.
7. `cli.ts` serves as the single process-exit boundary mapping structured `CommandResult` to process exit code.

## Execution completeness

The harness distinguishes between:

- **process / transport failure**: spawn failure, nonzero exit, timeout, structured adapter error
- **successful completion**: the provider completed cleanly enough that artifact inspection is trustworthy
- **terminal unknown**: the provider appeared to run but did not complete in a trustworthy way

In the current repo direction, `opencode` is the only adapter with a verified completion signal
(`stopReason`) that can support this distinction. A clean OpenCode process without a recognized
terminal event is terminal `unknown` with a distinct missing-completion diagnostic; parser support
is added only from captured `--debug-spawn` stream fixtures. `codex` and `claude` currently remain
exit-code / structured-error based until equivalent support is explicitly proven and implemented.

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

### App-owned run supervision (portable PGID termination)

When launched with out-of-band `ORC_RUN_ID` + `ORC_RUN_TOKEN` (and optional
`ORC_RUN_STATE_DIR`), the CLI enters **app-owned mode**: an external owner holds
a lease and the CLI self-terminates the provider when ownership is lost, so a run
cannot continue unattended after the owning app exits. `src/commands/ownership-launch.ts`
parses the input; `src/run-ownership.ts` is the single ownership boundary (control
records, project admission lock, lease clock, lifecycle). Partial/missing/mismatched
launch inputs fail closed — there is no silent fallback to terminal mode, and the
plaintext token is never stored or exposed to providers (the owned child environment
scrubs `ORC_RUN_TOKEN`/`ORC_RUN_ID`/`ORC_RUN_STATE_DIR`).

Ownership state lives **outside the target project**, under
`${ORC_RUN_STATE_DIR ?? ${XDG_RUNTIME_DIR ?? os.tmpdir()}}/orc-smash/`:
`projects/<sha256(realpath(root))>/` (one project-keyed admission lock — at most one
app-owned run per canonical project, regardless of `runId`) and `runs/<runId>/`
(`control.json` issuer-written, `active.json` CLI-written). All files are `0600` on
`0700` dirs, atomically written (temp→fsync→rename), and a loosened/tampered file
fails closed.

Providers run beneath the source-shipped
`src/adapters/process-group-bootstrap.mjs` in a detached session. The bootstrap
passes fd 0/1/2 to the provider unchanged and uses a private, versioned Node IPC
channel for readiness, ACK, provider-started, provider-exited, and failure frames.
The parent independently verifies `{pid, pgid, sessionId}` and writes the
provisional group record before ACK; `src/owned-runtime-registry.ts` retains the
fresh capability used for lease-loss and interrupt cleanup. **Every**
`process.kill(-pgid, …)` routes through the authorized kill gate in
`src/kill-gate.ts`, which:

- structurally rejects `pgid <= 1`, the CLI's own pid, and the CLI's own + ancestor
  process groups (resolved via `ps`, never via `kill(0, …)`);
- identity-authorizes fresh signals by re-resolving the recorded leader and requiring
  matching `pgid` + `sessionId` + start evidence and executable identity;
- allows durable cleanup only on Linux with collision-resistant, exact identity evidence;
  durable macOS records never authorize unattended signalling;
- **fail-closes** when the leader is gone, ambiguous, or its identity has drifted — a
  recycled or foreign PGID is never signalled.

A lease watcher (`watchLease`) terminates a still-running provider on expiry; a
completion-side fence (`ownershipFence`) prevents any provenance/state advancement
after expiry and quarantines the raw output to `docs/dev/archived/`.

**Residual risk (portable design):** a descendant that deliberately creates another
session or process group is **not** automatically discovered or stopped. If a live
capability becomes unverifiable, the CLI retains admission and records a terminal
ownership failure rather than risking a recycled PGID. This design does not claim
kernel containment or independent cleanup after the CLI dies.

**Operator recovery** is explicit and never signals processes. Run
`orc ownership status --project <path>` to print recorded and observed evidence plus
safe `ps` inspection commands. After separately confirming that no owned processes
remain, run `orc ownership release --project <path> --yes`; the command marks the
retained run `failed: operator-released` before removing only its matching admission
lock and project pointer. Without `--yes`, an interactive release requires an explicit
confirmation; non-interactive release refuses to mutate state.

#### Companion macOS supervisor

`orc-smash-supervisor` is a separate repository and process boundary that consumes
this owned-run contract. It is a per-user macOS LaunchAgent, not a module imported by
`orc-smash`. At installation it pins an absolute reviewed `bin/orc.js` path. For each
launch it creates the run ID and owner token, writes `control.json`, starts
`node <pinned-orc> smash ...` with the ownership environment, and renews the lease
only while its authenticated host client remains healthy.

The responsibilities remain deliberately asymmetric:

- The supervisor is the sole writer of `control.json` and retains only its freshly
  captured CLI capability as macOS signal authority.
- `orc-smash` remains the sole writer of `active.json`, project admission, interrupted
  markers, quarantine, provenance, and loop artifacts.
- Provider groups recorded in `active.json` are diagnostic evidence to the supervisor,
  never macOS signal authority.
- After supervisor restart, the lost in-memory capability is not reconstructed from
  durable PID data; ambiguous cleanup remains `cleanup-blocked`.
- Ordinary `orc smash` invocations do not use the supervisor. Supervision begins only
  through the supervisor's authenticated launch protocol.

The current supervisor host CLI maintains heartbeats until interrupted and therefore
must remain running for the run lifetime. A future desktop host can implement the same
versioned socket protocol, but the presence of the LaunchAgent alone does not attach
supervision to unrelated processes.

Compatibility is pinned and cross-repository: the supervisor records the exact
`orc-smash` commit used by its real macOS release gate, while a contract test compares
its signal gate with this repository's `kill-gate`. Changes to the ownership schema,
state layout, lease semantics, launcher arguments, process identity, or kill-gate
rules require coordinated supervisor review, a new pinned commit, and a rerun of the
supervisor release gate.

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
- **Every group kill is authorized:** the only negative-PID signal in the CLI is reached through
  `src/kill-gate.ts`, behind structural + identity guards. App-owned mode uses portable POSIX
  process groups; an unverifiable, forbidden, or recycled PGID is never signalled — the run
  fail-closes instead.
- **Audit continuity (opt-in):** As an explicit architectural exception to pure statelessness, the `--audit-continuity` option allows audit runs in the `plan` or `review` loops to resume the same session ID for the `codex`, `opencode`, and `claude` providers. The session ID is captured from the live provider streams and persisted explicitly in artifact metadata (`sessionMode`, `sessionId`). Resuming is strictly artifact-driven (re-read from front matter) rather than hidden-session-driven or history-driven, and second opinions remain fresh. The legacy `--codex-audit-continuity` flag is kept as a temporary Codex-only alias. both flags are mutually exclusive.
- **Verify every real path & CI:** a GitHub Actions CI workflow gates the codebase using deterministic checks (typecheck + test runs on `fake` adapter). Real-provider paths for opencode, codex, and claude remain covered by env-gated contract tests; agy stays a real adapter but is verified manually from an already-authenticated shell because its browser login flow is not suitable for an automated contract gate.
