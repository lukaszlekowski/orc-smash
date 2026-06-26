# orc-smash — Architecture Overview

orc-smash is a **stateless subprocess harness** that drives coding-agent CLIs through skill-based
`audit ↔ follow-up` loops until a verdict is APPROVED, then stops for human review (or runs a
second-opinion pass). The agents do the LLM work; orc-smash decides what to run, when, reads the
result, and loops. Detailed design: `docs/dev/plan.md`. Rules: `../AGENTS.md`.

## Module map

```
cli.ts ──▶ commands/{smash,status}.ts
                │
                ├─ config.ts        .env (per-agent default models) + skills.yaml → typed Config
                ├─ manifest.ts      zod schema + validation (source of truth: skills.yaml)
                ├─ runner.ts        per-skill {agent,model} resolution (agent change re-defaults model)
                ├─ state.ts         scan target docs/dev → latest verdict + restart point
                ├─ interactive.ts   typed prompts (loop / per-skill runners / start-point / max-iters)
                ├─ loop.ts          audit→follow-up driver; per-step runner; max-iter; unknown→terminal; second-opinion
                ├─ prompt-composer  role + skill + resolved inputs → one prompt string
                ├─ status.ts        ASCII panel (boxen + cli-table3 + ora)
                └─ adapters/        AgentAdapter registry: opencode · codex · claude (all real) · fake (tests)
```

Pure, I/O-free logic (`verdict`, `state`, `prompt-composer`, `runner`, adapter arg builders) is
isolated so it unit-tests without spawning agents.

## Data flow — one `orc smash` run

1. `config` loads `.env` + `skills.yaml`.
2. `state.scan` globs the target's `docs/dev/*-audit-v*-*.md` (ignoring `archived/`), reads each
   `## Verdict`, returns the latest verdict + proposed next step.
3. `interactive` proposes loop / per-skill runners / start-point / max-iters (pre-filled from
   state and manifest defaults); `commands/smash` normalizes and **rejects impossible
   transitions**, unknown agents, and agent/model mismatches with specific errors.
4. `loop` runs until APPROVED/max-iterations. Each step resolves its runner via `runner.ts` →
   `prompt-composer` assembles role + skill + inputs → the adapter for that runner spawns the
   agent in the target cwd → the agent writes the versioned audit file → `verdict.parse` reads
   it (stdout fallback) → branch on APPROVED / REJECTED / unknown. Audit and follow-up may use
   different runners/CLIs.
5. On APPROVED the loop offers `stop | run-second-opinion` (re-prompts the audit runner, runs
   the next version). `status` redraws the panel each iteration; on stop it prints "awaiting
   your review" + the final audit path.

## Key invariants

- **Three real adapters; per-skill runners:** opencode, codex, and claude all run for real; each
  skill declares its own agent/model (overridable per run). Agent and model are a coupled pair —
  switching agent re-defaults model. The adapter is selected per step, so stages can mix CLIs.
- **Manifest-as-data:** loops, skills, roles, and per-loop input schemas live in `skills.yaml`.
  A loop using the existing input sources (`target`, `version`, `priorAudit`, `outputPath`,
  `planPath`, `checklistPath`) is added via YAML only (no TS).
- **One composed prompt:** each agent run gets role + skill + inputs — no task content is invented.
- **`unknown` is terminal:** a missing/malformed verdict stops the loop for human review; the
  target is never mutated on a parse miss. Follow-up runs only on a concrete REJECTED audit.
- **Black-box agents:** providers are opaque native binaries invoked over stdio + args; the
  harness never imports them. Headless writes require the provider's autonomy flag.
- **Stateless; isolated per target:** the tool holds only config; all per-run target state is
  derived from filenames. One runner per target; different targets never interfere (dual-target
  e2e proves it).
- **Verify every real path:** the deterministic `fake`-adapter e2e gates harness logic; each
  real provider (opencode, codex, claude) is gated by its own env-gated contract test plus a live
  mixed-CLI smoke.
