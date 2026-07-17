# orc-smash

> Temporary notice: This document may contain outdated guidance and will be updated in the near future. Verify behavior against the current source and tests.

A thin **TypeScript CLI harness** that drives coding-agent CLIs (**opencode, codex, claude, agy** —
all real) through skill-based `audit ↔ follow-up` loops until a verdict is **APPROVED**, then
stops for human review (or runs a second-opinion pass). Stateless — all per-run state is derived
from the target project's filenames. No DB, no S3, no web UI.

The binary is **`orc`**; the main command is **`orc smash`**.

## Setup

```bash
pnpm install
pnpm build
```

`bin/orc.js` is the stable production entrypoint. Production execution requires
`pnpm build`, which compiles `src/` to `dist/src/` and packages the provider
configuration, manifest, roles, skills, package metadata, and process-group
bootstrap alongside it. Development runs can use `pnpm dev`.

Each provider's complete catalogue lives in `config/providers/<provider>.yaml`, including its `defaultModel`; update that one file to add or remove models. `config/runners.yaml` maps opaque runner-profile names to providers, and `config/registry.yaml` contains only execution timeouts. `orc.config.yaml` and home-directory overrides are not supported.

Interactive selection lets you choose from configured models or provide a validated custom model.

## Commands

```bash
orc smash --project <path>          # run the audit↔follow-up loop (interactive if flags omitted)
orc smash --project <path> --plain  # run the loop in append-only scrollback-safe plain mode
orc smash --project <path> \        # run-wide runner override, non-interactive
  --loop plan --agent opencode --model opencode-go/deepseek-v4-flash --max-iterations 5
orc smash --project <path> --audit-continuity # run in audit continuity mode (plan/review loops)
orc status --project <path>         # read-only: detect where we are, render the status panel
orc supervisor-contract             # print the supervisor compatibility handshake
orc ownership status --project <path> # read-only diagnostics for retained owned-run state
orc ownership release --project <path> --yes # explicit, no-signal recovery release
```

### Execution Modes

- **Panel Mode (Default):** A graphical, boxen-rendered status dashboard with interactive spinners (`ora`) and auto-clearing screens.
- **Plain Mode (`--plain`):** A scrollback-safe, append-only textual output suitable for headless CI/CD and logs, emitting clean step events and final summaries.

`orc smash` is restart-aware: it scans the target's `docs/dev/*-audit-v*-*.md` (ignoring
`docs/dev/archived/`), detects the latest verdict, and proposes the next step.

### Optional macOS supervisor

The companion `orc-smash-supervisor` repository provides the supported independent
supervision path for app-owned runs on macOS. It installs a per-user LaunchAgent,
starts the reviewed `orc-smash` launcher through the owned-run protocol, renews its
lease while the host client is alive, and remains available if that client dies.

Installing the LaunchAgent does **not** intercept ordinary `orc smash` commands. A
normal command remains unsupervised. From an adjacent supervisor checkout, build and
install it by pinning this repository's launcher:

```bash
cd /Volumes/projects/orc-smash-supervisor
pnpm install --frozen-lockfile
pnpm build
cd /Volumes/projects/orc-smash
pnpm build
cd /Volumes/projects/orc-smash-supervisor
node bin/orc-smash-supervisor.js install /Volumes/projects/orc-smash/bin/orc.js
node bin/orc-smash-supervisor.js status
```

Start a supervised run through its current host client:

```bash
node bin/orc-smash-supervisor.js launch /absolute/path/to/project \
  --loop review --agent codex --max-iterations 3 --plain
```

The `launch` process must remain running to send heartbeats; `Ctrl-C` requests
cancellation. This is a real `orc smash` run and can invoke providers and modify the
target project's workflow artifacts. Provider authentication must be available from
`HOME`-based configuration, the user keychain, or another non-environment mechanism:
the supervisor intentionally does not forward inherited credential environment
variables.

The supervisor installer first runs `node /Volumes/projects/orc-smash/bin/orc.js
supervisor-contract` and validates the same-process PID and ownership schema before
changing its config or LaunchAgent. The public install path remains `bin/orc.js`;
`dist/src/cli.js` is an internal build artifact.

The supervisor's release gate is macOS-specific and independently verifies host loss,
bounded fresh-capability cleanup, process isolation, canary survival, and fail-closed
restart behavior. See the companion repository's `README.md` and
`docs/release-gate-result.md` for installation details and current evidence.

## How it works

- **Three-stage pipeline:** Turns the product into a pipeline of `plan` (doc-audit loop) → `implement` (one-shot transform) → `review` (code-review loop). Interactive transitions downstream advance stages automatically.
- **Up-front interactive runner selection:** In interactive mode, selecting a start-new or continue action prompts the operator to choose the full upcoming pair of runners up front (for both steps in the segment, such as audit and follow-up). The selections are reused without mid-chain re-prompts, and any step kind with a prior resumable session skips prompting and inherits its runner automatically.
- **Four real adapters:** opencode, codex, claude, and agy (Antigravity) all run for real; each skill picks its own agent/model, validated against the assembled model registry. `agy` runs headless via `agy -p <prompt> --model <model> --dangerously-skip-permissions`; its model ids are the exact human-readable names from `agy models` (a strict configured allow-list — no namespace fallbacks). When unauthenticated, `agy` can fall back to a default provider while exiting 0, so the adapter detects this with a bounded phrase list and surfaces a structured `auth` error; the loop then quarantines any partial artifact so no resumable file is left behind.
- **Manifest-as-data:** loops, skills, roles, and per-loop input schemas live in `skills.yaml`. Adding a loop that uses the existing input sources = one YAML entry + two skill files (no TS).
- **One composed prompt:** each agent run receives a single prompt assembled from three user-owned pieces — a **role** (`roles/*.md`), a **skill** (`skills/*/SKILL.md`), and the resolved **inputs**. No task content is invented by the harness.
- **Safety:** `unknown` verdicts (missing/malformed output, transport failure) are terminal — the loop stops for human review and never mutates the target. Follow-up runs only on a concrete `REJECTED` audit.
- **Ledger Verification & Closeout:** Before implementation, the harness makes `docs/dev/plan.md` YAML front matter canonical (`status: ready`), migrating a leading legacy `**Status:**` line while preserving the plan body. It then verifies the ledger tables and confidence declaration, updates plan status to `done` or `blocked` (0.95 threshold), and appends a versioned change log.
- **Raw-ledger recovery:** If a complete implementation ledger exists without harness provenance after a closeout failure, an interactive implementation run offers an explicit recovery action. It re-links that same ledger to the approved audit and closes it out without spawning a provider or allocating a new version; non-interactive runs stop with recovery guidance.
- **Artifact diagnostics:** A clean provider exit is still not success unless the exact `Write your output to` artifact exists. Missing artifacts remain terminal `unknown`; rerun with `--debug-spawn` to inspect the resolved prompt input and provider stream.
- **Execution Watchdog:** Spawns are protected by a watchdog timeout policy. For `opencode`, the timeout precedence is: `OPENCODE_RUN_TIMEOUT_MS` env variable > registry config `timeouts.opencode` > built-in `600000` ms default. `claude`, `codex`, and `agy` are config-only: `timeouts.<agent>` > built-in `0` (disabled by default); there are no env vars for these agents. A timeout fires `error.kind === 'timeout'` and a failed lifecycle event.
- **Interrupted-run handling:** `SIGINT`/`SIGTERM` writes a durable interrupted marker under the active project root, terminates in-flight provider children (SIGTERM → SIGKILL after a grace period), and exits with the conventional signal code. A rerun quarantines the partial/late artifact before any state scan, so an interrupted run never resolves to a terminal `unknown` and `orc status` shows the interrupted stage (`plan`/`review`/`implement`) via marker-first loop selection.
- **Second opinion:** on APPROVED, choose `stop`, `run-second-opinion` (re-prompts the audit runner, offered only when a different configured+runnable agent exists), or `implement` (transitions directly to implementation).
- **Audit Continuity (Opt-in):** By passing `--audit-continuity`, subsequent audit steps in the `plan` or `review` loop primary rejected chain will resume the session ID of the first run. Supported for `codex`, `opencode`, and `claude` providers. Resumption is artifact-driven (using the `sessionMode` and `sessionId` metadata stamped in front matter), never `--last`-driven or history-driven, and second-opinion audits are kept fresh and independent. The legacy `--codex-audit-continuity` remains supported as a temporary alias for Codex runs, but is mutually exclusive with `--audit-continuity`.

## Architecture direction

Current development is steering the harness toward a cleaner runtime architecture:

- **Single-source-of-truth rules:** artifact-path rendering/parsing, next-step resolution, and
  shared runtime contracts should each live in one clearly named place.
- **Purposeful module boundaries:** new files are added only when they own a stable
  responsibility. Avoid generic buckets such as `helpers.ts`, `common.ts`, or `misc.ts`.
- **Thin orchestration:** `loop.ts` should orchestrate, while stable runtime seams own process
  execution, artifact conventions, and decision logic.
- **Provider-specific behavior behind adapters:** shared runtime code should consume normalized
  signals; provider-specific parsing and remediation stay in the adapter layer.
- **Execution completeness as an explicit contract:** in the current repo direction, `opencode`
  is the only provider with a verified completion signal (`stopReason`). `codex` and `claude`
  still rely on exit code + structured error handling until equivalent support is explicitly
  proven and implemented. A clean OpenCode exit without a recognized terminal stream event is a distinct missing-completion failure, not an inferred interruption.
- **App-owned run supervision:** out-of-band `ORC_RUN_ID` + `ORC_RUN_TOKEN` enables a lease-backed
  run. Providers execute beneath the source-shipped detached
  `src/adapters/process-group-bootstrap.mjs`; the CLI registers a fresh runtime capability
  before provider spawn. Lease loss uses the same authorized `src/kill-gate.ts` boundary for
  fresh capabilities, while stale macOS records never authorize unattended signalling.
  Ambiguous cleanup retains admission for `orc ownership status` and the explicit,
  no-signal `orc ownership release` workflow. A deliberately detached descendant remains
  outside the portable process-group guarantee. See
  [docs/architecture/overview.md](./docs/architecture/overview.md#app-owned-run-supervision-portable-pgid-termination)
  and [docs/dev/plan.md](./docs/dev/plan.md). The separate macOS
  `orc-smash-supervisor` LaunchAgent is the current operator-facing issuer of this
  contract; ordinary `orc smash` invocations do not opt into it automatically.

See [docs/architecture/overview.md](./docs/architecture/overview.md) for the canonical overview,
[docs/roadmap.md](./docs/roadmap.md) for staged direction, and
[docs/dev/plan.md](./docs/dev/plan.md) for the current Batch A implementation plan.

## Verification and CI

Continuous Integration (CI) runs automatically on push and pull requests, executing typecheck and deterministic unit/e2e tests (using the `fake` adapter) to gate harness logic without requiring network or credentials:

```bash
pnpm typecheck
pnpm test                                       # run deterministic unit/e2e tests locally
```

In contrast, **real-provider verification** remains a separate sign-off requirement before releases. The contract-gated providers use env-gated suites, while `agy` is verified manually from an already-authenticated shell because its login flow is browser-interactive:

```bash
OPENCODE_CONTRACT=1 CODEX_CONTRACT=1 \
  CLAUDE_CONTRACT=1 pnpm test   # env-gated contract tests

agy -p "return hi" --model "Gemini 3.5 Flash (Medium)" --dangerously-skip-permissions
```

The repo-local e2e (`tests/e2e/smash.test.ts` via the `fake` adapter) covers every exit branch,
mixed-runner loops, and dual-target isolation without external credentials or network. `opencode`,
`codex`, and `claude` remain contract-gated; `agy` is covered by deterministic contracts plus
manual operator verification.

## Project layout

Use these docs with different expectations:

- [docs/architecture/overview.md](./docs/architecture/overview.md): canonical architecture overview
- [docs/roadmap.md](./docs/roadmap.md): staged roadmap and architectural direction
- [docs/dev/plan.md](./docs/dev/plan.md): current implementation plan
- [AGENTS.md](./AGENTS.md): repository rules and invariants
