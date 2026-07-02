# orc-smash

A thin **TypeScript CLI harness** that drives coding-agent CLIs (**opencode, codex, claude, agy** —
all real) through skill-based `audit ↔ follow-up` loops until a verdict is **APPROVED**, then
stops for human review (or runs a second-opinion pass). Stateless — all per-run state is derived
from the target project's filenames. No DB, no S3, no web UI.

The binary is **`orc`**; the main command is **`orc smash`**.

## Setup

```bash
pnpm install
```

Model configuration, allowed providers, and defaults are defined in the model registry (`orc.config.yaml`). Precedence resolves from:
1. Target project root: `projectRoot/orc.config.yaml`
2. User home config: `~/.config/orc/config.yaml`
3. Built-in defaults (`DEFAULT_REGISTRY`)

Interactive selection lets you choose from configured models or provide a validated custom model.

## Commands

```bash
orc smash --project <path>          # run the audit↔follow-up loop (interactive if flags omitted)
orc smash --project <path> --plain  # run the loop in append-only scrollback-safe plain mode
orc smash --project <path> \        # run-wide runner override, non-interactive
  --loop plan --agent opencode --model opencode-go/deepseek-v4-flash --max-iterations 5
orc smash --project <path> --codex-audit-continuity # run in Codex audit continuity mode (plan/review loops)
orc status --project <path>         # read-only: detect where we are, render the status panel
```

### Execution Modes

- **Panel Mode (Default):** A graphical, boxen-rendered status dashboard with interactive spinners (`ora`) and auto-clearing screens.
- **Plain Mode (`--plain`):** A scrollback-safe, append-only textual output suitable for headless CI/CD and logs, emitting clean step events and final summaries.

`orc smash` is restart-aware: it scans the target's `docs/dev/*-audit-v*-*.md` (ignoring
`docs/dev/archived/`), detects the latest verdict, and proposes the next step.

## How it works

- **Three-stage pipeline:** Turns the product into a pipeline of `plan` (doc-audit loop) → `implement` (one-shot transform) → `review` (code-review loop). Interactive transitions downstream advance stages automatically.
- **Four real adapters:** opencode, codex, claude, and agy (Antigravity) all run for real; each skill picks its own agent/model, validated against the model registry. `agy` runs headless via `agy -p <prompt> --model <model> --dangerously-skip-permissions`; its model ids are the exact human-readable names from `agy models` (a strict configured allow-list — no namespace fallbacks). When unauthenticated, `agy` can fall back to a default provider while exiting 0, so the adapter detects this with a bounded phrase list and surfaces a structured `auth` error; the loop then quarantines any partial artifact so no resumable file is left behind.
- **Manifest-as-data:** loops, skills, roles, and per-loop input schemas live in `skills.yaml`. Adding a loop that uses the existing input sources = one YAML entry + two skill files (no TS).
- **One composed prompt:** each agent run receives a single prompt assembled from three user-owned pieces — a **role** (`roles/*.md`), a **skill** (`skills/*/SKILL.md`), and the resolved **inputs**. No task content is invented by the harness.
- **Safety:** `unknown` verdicts (missing/malformed output, transport failure) are terminal — the loop stops for human review and never mutates the target. Follow-up runs only on a concrete `REJECTED` audit.
- **Ledger Verification & Closeout:** For implementation runs, the harness parses the written ledger to verify required tables (evidence and coverage) and confidence declaration. On success, it updates the plan's front-matter status (to `done` or `blocked` based on a 0.95 confidence threshold) and appends a versioned change log.
- **Execution Watchdog:** Spawns are protected by a watchdog timeout policy. For `opencode`, the timeout precedence is: `OPENCODE_RUN_TIMEOUT_MS` env variable > registry config `timeouts.opencode` > built-in `600000` ms default. `claude`, `codex`, and `agy` are config-only: `timeouts.<agent>` > built-in `0` (disabled by default); there are no env vars for these agents. A timeout fires `error.kind === 'timeout'` and a failed lifecycle event.
- **Interrupted-run handling:** `SIGINT`/`SIGTERM` writes a durable interrupted marker under the active project root, terminates in-flight provider children (SIGTERM → SIGKILL after a grace period), and exits with the conventional signal code. A rerun quarantines the partial/late artifact before any state scan, so an interrupted run never resolves to a terminal `unknown` and `orc status` shows the interrupted stage (`plan`/`review`/`implement`) via marker-first loop selection.
- **Second opinion:** on APPROVED, choose `stop`, `run-second-opinion` (re-prompts the audit runner, offered only when a different configured+runnable agent exists), or `implement` (transitions directly to implementation).
- **Codex Audit Continuity (Opt-in):** By passing `--codex-audit-continuity`, subsequent Codex audit steps in the `plan` or `review` loop primary rejected chain will resume the session ID of the first run. Resumption is artifact-driven (using the `sessionMode` and `sessionId` metadata stamped in front matter), never `--last`-driven, and second-opinion audits are kept fresh and independent.

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
  proven and implemented.

See [docs/architecture/overview.md](./docs/architecture/overview.md) for the canonical overview,
[docs/roadmap.md](./docs/roadmap.md) for staged direction, and
[docs/dev/plan.md](./docs/dev/plan.md) for the current Batch 3 implementation plan.

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
