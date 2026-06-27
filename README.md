# orc-smash

A thin **TypeScript CLI harness** that drives coding-agent CLIs (**opencode, codex, claude** —
all real) through skill-based `audit ↔ follow-up` loops until a verdict is **APPROVED**, then
stops for human review (or runs a second-opinion pass). Stateless — all per-run state is derived
from the target project's filenames. No DB, no S3, no web UI.

The binary is **`orc`**; the main command is **`orc smash`**.

## Setup

```bash
pnpm install
cp .env.example .env        # DEFAULT_AGENT/DEFAULT_MODEL + per-agent default models (+ keys)
```

Default runner: `opencode-go/deepseek-v4-flash`. Each agent has its own default model
(`CODEX_DEFAULT_MODEL`, `CLAUDE_DEFAULT_MODEL`); switching a skill's agent re-defaults its model.

## Commands

```bash
orc smash --project <path>          # run the audit↔follow-up loop (interactive if flags omitted)
orc smash --project <path> \        # run-wide runner override, non-interactive
  --loop plan --agent opencode --model opencode-go/deepseek-v4-flash --max-iterations 5
orc status --project <path>         # read-only: detect where we are, render the status panel
```

`orc smash` is restart-aware: it scans the target's `docs/dev/*-audit-v*-*.md` (ignoring
`docs/dev/archived/`), detects the latest verdict, and proposes the next step.

## How it works

- **Three real adapters:** opencode, codex, and claude all run for real; each skill picks its
  own agent/model, so audit and follow-up can run on different CLIs (e.g. follow-up on opencode,
  audit on codex). `--agent`/`--model` are run-wide overrides.
- **Manifest-as-data:** loops, skills, roles, and per-loop input schemas live in `skills.yaml`.
  Adding a loop that uses the existing input sources = one YAML entry + two skill files (no TS).
- **One composed prompt:** each agent run receives a single prompt assembled from three
  user-owned pieces — a **role** (`roles/*.md`), a **skill** (`skills/*/SKILL.md`), and the
  resolved **inputs**. No task content is invented by the harness.
- **Safety:** `unknown` verdicts (missing/malformed output, transport failure) are terminal —
  the loop stops for human review and never mutates the target. Follow-up runs only on a
  concrete `REJECTED` audit.
- **Second opinion:** on APPROVED, choose `stop` or `run-second-opinion` (re-prompts the audit
  runner, ideally a different agent, and runs the next version).

## Verification

```bash
pnpm typecheck
pnpm test                                       # deterministic e2e (fake adapter) gates harness logic
OPENCODE_CONTRACT=1 CODEX_CONTRACT=1 \
  CLAUDE_CONTRACT=1 pnpm test                   # mandatory sign-off: REAL spawn/write per provider
```

The repo-local e2e (`tests/e2e/smash.test.ts` via the `fake` adapter) covers every exit branch,
mixed-runner loops, and dual-target isolation without external credentials or network. **Each
real provider path** is proven by its env-gated contract test plus a live mixed-CLI
end-to-end smoke (sign-off requires all of them) — none is optional.

## Project layout

See `docs/dev/plan.md` for the full design and `docs/architecture/overview.md` for the module
map. Authority rules: `AGENTS.md`.
