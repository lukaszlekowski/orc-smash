# orc-smash

---

ORC SMASH - ORCHESTRATOR RUN

---

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-22.14.0-brightgreen.svg)](./.nvmrc)
[![pnpm](https://img.shields.io/badge/pnpm-11.17.0-F69220.svg)](./package.json)

orc-smash is a stateless TypeScript subprocess harness for coding-agent CLIs.
It drives real providers — **opencode**, **codex**, **claude**, and **agy** — over
stdio, validates the artifact each run declares, and reconstructs pipeline state
from project files on disk. It never calls a model API directly and keeps no
runtime database, so every run is resumable and there is nothing to corrupt.

## Features

- **Drives real agent CLIs** over stdio — opencode, codex, claude, agy (`fake` is test-only). No model API calls.
- **Config-driven workflows** — reusable skills and roles, approval loops, one-off tasks, and linear pipelines, all declared in one manifest.
- **Artifact validation** — decision tokens normalize to `accepted` / `retry` / `unknown`; completion contracts enforce a single `## Outcome` section; pluggable validators (e.g. the implementation ledger).
- **Stateless and restartable** — state is reconstructed from project files and artifact fingerprints. No database, no server.
- **Operator-confirmed transitions** — a classified `accepted` evaluate is what unlocks the next stage; nothing downstream ever starts automatically.
- **Per-skill runners** — choose provider, model, and effort per skill, with global and repeatable per-skill overrides.
- **One shared theming system** — semantic color tokens consumed by every operator surface; output stays 100% complete when color is unsupported or disabled.
- **Safe process groups** — identity-gated signal delivery, ownership tracking, and quarantine of partial artifacts after interruption.
- **Interactive *and* scriptable** — a live TUI status panel for operators, plus a `--plain` append-only event stream for CI and logs.

## How it works

You declare **skills**, **roles**, **loops**, **tasks**, and **pipelines** in a
manifest. For a given skill the harness selects a provider, invokes it over
stdio, reads the artifact it declares, and classifies it (accepted / retry /
unknown, or completed / blocked) to decide what is eligible to run next. Because
all of this is derived from files on disk, any run can be interrupted and resumed
without shared mutable state.

## Requirements

- **Node.js 22.14.0** (see [`.nvmrc`](./.nvmrc))
- **pnpm 11.17.0** (enable via `corepack enable`)
- At least one provider CLI installed and on your `PATH` — `opencode`, `codex`, `claude`, or `agy`

## Quick start

```bash
pnpm install
pnpm build
orc smash --project /path/to/your/project
```

`orc smash` opens an interactive menu (Pipelines, Loops, Tasks, and project
state) after rendering a compact **startup snapshot**: project root, config path,
configured pipelines, the suggested loop and why, and a per-binding state
summary. Pick a stage to run it; transitions are always operator-confirmed.

## Usage

```bash
orc smash -p <path>                       # interactive menu with startup snapshot
orc smash -p <path> -l <loop-id>          # ad-hoc loop start
orc smash -p <path> -t <task-id>          # ad-hoc task start
orc smash -p <path> --pipeline <id>       # start a pipeline at its first stage
orc smash -p <path> --plain               # append-only event stream for CI/logs
orc status  -p <path> [-a] [--config <path>] [--theme <path>]
orc ownership status  -p <path>           # read-only ownership diagnostics
orc ownership release -p <path> [--yes]   # release retained admission
```

`-p/--project` defaults to the current directory for `smash` and `status`; it is **required** for `orc ownership`. `--loop`, `--task`, and `--pipeline` are mutually exclusive. Run `orc --help` or `orc <command> --help` for the authoritative list.

### Command reference

#### `orc smash` — run a loop, task, or pipeline stage

| Flag | Short | Description |
|------|-------|-------------|
| `--project <path>` | `-p` | Target project (defaults to current directory) |
| `--loop <name>` | `-l` | Run a loop ad hoc |
| `--task <id>` | `-t` | Run a task ad hoc (excl. `--loop` / `--pipeline`) |
| `--pipeline <id>` | — | Start a pipeline at its first stage |
| `--agent <name>` | `-a` | Global provider override |
| `--model <name>` | `-m` | Global model override |
| `--effort <level>` | — | Global effort override |
| `--max-iterations <n>` | `-i` | Max evaluator rounds (default `4`) |
| `--runner <skill=agent>` | — | Per-skill provider override (repeatable) |
| `--runner-model <skill=model>` | — | Per-skill model override (repeatable) |
| `--runner-effort <skill=level>` | — | Per-skill effort override (repeatable) |
| `--config <path>` | — | Config file (`orc-smash.yaml`) |
| `--theme <path>` | — | Theme file (`theme.yaml`) |
| `--plain` | — | Append-only event stream (no spinners/screen clears) |
| `--show-fingerprints` | — | Lineage + input/result fingerprints |
| `--debug-spawn` | — | Write spawn/process debug logs |
| `--debug-spawn-file <path>` | — | Override the spawn debug log path |

#### `orc status` — read-only project state

| Flag | Short | Description |
|------|-------|-------------|
| `--project <path>` | `-p` | Target project (defaults to current directory) |
| `--all` | `-a` | Show artifacts across all loops |
| `--show-fingerprints` | — | Lineage + input/result fingerprints |
| `--config <path>` | — | Config file (`orc-smash.yaml`) |
| `--theme <path>` | — | Theme file (`theme.yaml`) |

> Note: `-a` means `--agent` on `smash` but `--all` on `status`.

#### `orc ownership` — inspect or release retained run admission

| Subcommand | Flags | Description |
|------------|-------|-------------|
| `status` | `-p, --project <path>` *(required)* | Read-only diagnostics; never signals or mutates state |
| `release` | `-p, --project <path>` *(required)*, `--yes` | Release retained admission after verification; never kills processes |

#### `orc supervisor-contract`

Prints the runtime contract consumed by the `orc-smash-supervisor` LaunchAgent. No options.

**Runner selection.** Models are validated in their provider's own namespace; changing provider re-defaults its model. Per-skill overrides (`--runner`, `--runner-model`, `--runner-effort`) take precedence over global ones (`-a`, `-m`, `--effort`).

**Live panel.** The default panel shows nine columns — `version`, `role`, `agent`, `model`, `effort`, `result`, `time`, `session`, `status` — and uses an alternate screen. `--show-fingerprints` adds the `Artifact`, `Parent`, `Input FP`, and `Result FP` diagnostics (wide table on wide terminals, a compact line beneath each row on narrow ones). The choice is per invocation and is not persisted.

```
 version │ role        │ agent    │ model      │ effort │ result    │ time   │ session │ status
─────────┼─────────────┼──────────┼────────────┼────────┼───────────┼────────┼─────────┼─────────
 v1      │ auditor     │ opencode │ gpt-5      │ high   │ accepted  │ 12.4s  │ fresh   │ done
 v1      │ implementer │ claude   │ claude-…   │ medium │ completed │ 03:01  │ resume  │ done
 v2      │ reviewer    │ codex    │ o3         │ high   │ retry     │ 45.2s  │ fresh   │ done
```
*Illustrative — actual content depends on your manifest and providers.*

**Interactive operating notes.** Tasks opens a generic chooser over all configured tasks in declaration order, performing one fresh state scan before rendering; a task never auto-advances the pipeline. Both *Display pipeline and project state* and `orc status` include a manifest-derived **Prompt Contracts** section describing how each prompt is assembled (role, skill, typed inputs, output pattern/contract, decision tokens, validator) without printing source contents. Unavailable choices, missing-input blockers, and recommendations all carry explicit, typed availability categories.

## Configuration

The single v1 manifest is `config/orc-smash.yaml`. Resolution order, lowest to highest precedence:

1. `config/orc-smash.yaml` (packaged default)
2. `<project>/.orc-smash.yaml` (project override)
3. `--config <path>` (explicit, highest precedence)

A manifest declares roles, skills, loops, tasks, and pipelines. Each binding owns
its target, named project-file inputs, prompt inputs, output pattern, output
contract, and runner profile. Output patterns use `{version}` and `{provider}`
and resolve under the selected project root; roles and skill files resolve under
the manifest root. Missing project inputs are recorded in the global snapshot and
fail preflight — without spawning a provider.

```yaml
# config/orc-smash.yaml — trimmed for shape
schemaVersion: 1

roles:
  auditor: roles/auditor.md
  planner: roles/planner.md
  implementer: roles/implementer.md

skills:
  plan-audit:
    file: skills/21-simple-plans-audit/SKILL.md
    role: auditor
    runnerProfile: audit

loops:                       # an approval loop = evaluate (+ optional repair)
  plan:
    type: approval-loop
    target: { path: docs/dev/plan.md, kind: file }
    files: { specPath: docs/dev/spec.md }
    evaluate:
      skill: plan-audit
      output:
        pattern: "docs/dev/plan-audit-v{version}-{provider}.md"
        contract: decision-artifact
        decision: { heading: Verdict, accepted: APPROVED, retry: REJECTED }
    repair:
      skill: plan-follow-up
      output: { pattern: "docs/dev/plan-followup-v{version}-{provider}.md", contract: completion-artifact }

tasks:                       # a one-off, operator-controlled binding
  implement:
    skill: 30-simple-implement
    target: { path: ".", kind: worktree }
    files: { specPath: docs/dev/spec.md, planPath: docs/dev/plan.md }
    output:
      pattern: "docs/dev/impl-v{version}-{provider}.md"
      contract: required-artifact
      validator: implement-ledger

pipelines:                   # ordered stages referencing loops/tasks
  default:
    stages:
      - { stageId: plan,      loop: plan }
      - { stageId: implement, task: implement }
      - { stageId: review,    loop: review }
  research-first:
    stages:
      - { stageId: research,     loop: research }
      - { stageId: create-plan,  task: create-plan }
      - { stageId: plan,         loop: plan }
      - { stageId: implement,    task: implement }
      - { stageId: review,       loop: review }
```

**Pipelines.** The packaged `default` pipeline is `plan → implement → review`. The optional `research-first` pipeline prepends `research → create-plan`. Research is never a prerequisite for the default pipeline, and every stage transition remains operator-confirmed.

**Contracts (summary).** Decision artifacts normalize configured tokens to `accepted`, `retry`, or `unknown`; `unknown` is terminal and repair runs only after a concrete `retry`. Completion artifacts require exactly one `## Outcome` section whose first non-blank line is `COMPLETED` or `BLOCKED`. The implementation-ledger validator distinguishes `valid`, structurally `blocked` (with bounded diagnostics), and malformed `unknown`; blocked ledgers are durable evidence but never unlock a successor.

> Artifact lineage, fingerprint semantics, target-drift / stale-evidence reasons, second-opinion chains, and the qualified-decision correction flow are specified in [AGENTS.md](./AGENTS.md) and [docs/architecture/overview.md](./docs/architecture/overview.md).

## Providers and safety

Providers are opaque native binaries behind `AgentAdapter`. Headless writes use each provider's autonomy flag.

| Provider | Status | Watchdog default | Progress | Notes |
|----------|--------|------------------|----------|-------|
| `opencode` | real | 10 min | structured | `OPENCODE_RUN_TIMEOUT_MS` > `timeouts.opencode` > default |
| `codex` | real | none | structured | configurable |
| `claude` | real | none | structured | configurable |
| `agy` | real | none | unavailable | Gemini; `--new-project` for fresh, session-token resume |
| `fake` | test-only | — | — | deterministic tests |

Progress telemetry is carried generically through the live and plain event views without affecting workflow state or watchdog deadlines.

**Signals and ownership.** `SIGINT`/`SIGTERM` writes a marker under the active project root, terminates children through the authorized, identity-gated process-group kill gate, and exits with the conventional signal code; a rerun quarantines partial and late artifacts before scanning. App-owned runs are tracked with `ORC_RUN_ID`, `ORC_RUN_TOKEN`, `ORC_RUN_STATE_DIR`, and lease records; every group signal is identity-gated and unverifiable or recycled groups are never signalled. Inspect with `orc ownership status` and release only with explicit operator verification via `orc ownership release`.

> The companion `orc-smash-supervisor` is a separate per-user macOS LaunchAgent. orc-smash does not import or depend on it, and ordinary `orc smash` invocations are not supervised. (See `orc supervisor-contract`.)

## Theming

Every operator-facing surface — the status panel, shared terminal accents, plain timeline, and logging — consumes one semantic color system. Tokens (`role.auditor`, `result.fail`, `emphasis.identity`, …) are defined in `config/theme.yaml` and resolved per location through `src/theme.ts`. Override the packaged theme with `--theme <path>` or a project `.theme.yaml`. Output emits zero ANSI escape codes when color is unsupported or disabled (`NO_COLOR=1`, non-TTY, or piped).

## Verification

```bash
pnpm typecheck
pnpm test
```

Deterministic tests use the test-only `fake` adapter. `opencode`, `codex`, and `claude` have env-gated real-provider contract suites. AGY has deterministic adapter/seam coverage plus an explicitly gated authenticated contract:

```bash
ORC_AGY_AUTHENTICATED_CONTRACT=1 \
ORC_AGY_CONTRACT_EVIDENCE=/tmp/orc-smash-agy-evidence.json \
pnpm vitest run tests/agy-authenticated.contract.test.ts
```

The AGY command must run from an already-authenticated operator shell; it writes only a redacted evidence record, never raw invocation logs or credentials.

## Project layout

```
bin/orc.js              # stable production entrypoint
src/                    # TypeScript sources (cli, theme, adapters, …)
config/                 # packaged manifest, providers, runners, theme
roles/                  # role prompt files (auditor, planner, reviewer, …)
skills/                 # packaged skills (research, plan, implement, review, commit, …)
docs/architecture/      # architecture overview
docs/dev/               # runtime artifacts + evidence written per project
tests/                  # vitest suites (fake-adapter + env-gated contracts)
AGENTS.md               # repository invariants for agents and contributors
CHANGELOG.md            # release history
```

`bin/orc.js` is the stable production entrypoint. Run `pnpm build` before production execution (it packages the manifest, provider catalogues, roles, skills, and process-group bootstrap). `dist/src/cli.js` is an internal build artifact, not the public install path.

## Further reading

- [docs/architecture/overview.md](./docs/architecture/overview.md) — architecture and data flow
- [AGENTS.md](./AGENTS.md) — repository invariants, contracts, and lineage semantics
- [CHANGELOG.md](./CHANGELOG.md) — release history

## Contributing

Build and test before opening a change:

```bash
pnpm install
pnpm build
pnpm typecheck && pnpm test
```

Repository invariants — artifact contracts, lineage and fingerprint semantics, and the operator-safety rules — are normative in [AGENTS.md](./AGENTS.md); read it before changing workflow, state, or process-handling code.

## License

[MIT](./LICENSE)
