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
                ├─ config.ts        current runner defaults + skills.yaml → typed Config
                ├─ manifest.ts      zod schema + validation (source of truth: skills.yaml)
                ├─ runner.ts        per-skill {agent,model} resolution (agent change re-defaults model)
                ├─ state.ts         scan target docs/dev → normalized artifact facts
                ├─ interactive.ts   typed prompts (loop / per-skill runners / start-point / max-iters)
                ├─ loop.ts          audit→follow-up driver; per-step runner; max-iter; unknown→terminal; second-opinion
                ├─ prompt-composer  role + skill + resolved inputs → one prompt string
                ├─ status.ts        ASCII panel (boxen + cli-table3 + ora)
                └─ adapters/        AgentAdapter registry: opencode · codex · claude (all real) · fake (tests)
```

Pure, I/O-free logic (`verdict`, `state`, `prompt-composer`, `runner`, adapter arg builders) is
isolated so it unit-tests without spawning agents.

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

1. `config` loads current runner defaults plus `skills.yaml`.
2. `state.scan` globs the target's `docs/dev/*-audit-v*-*.md` (ignoring `archived/`), reads the
   matching artifacts, and returns normalized facts about the timeline and latest audit state.
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

## Execution completeness

The harness distinguishes between:

- **process / transport failure**: spawn failure, nonzero exit, timeout, structured adapter error
- **successful completion**: the provider completed cleanly enough that artifact inspection is trustworthy
- **terminal unknown**: the provider appeared to run but did not complete in a trustworthy way

In the current repo direction, `opencode` is the only adapter with a verified completion signal
(`stopReason`) that can support this distinction. `codex` and `claude` currently remain exit-code
/ structured-error based until equivalent support is explicitly proven and implemented.

## Key invariants

- **Three real adapters; per-skill runners:** opencode, codex, and claude all run for real; each
  skill declares its own agent/model (overridable per run). Agent and model are a coupled pair —
  switching agent re-defaults model. The adapter is selected per step, so stages can mix CLIs.
- **Manifest-as-data:** loops, skills, roles, and per-loop input schemas live in `skills.yaml`.
  A loop using the existing input sources (`target`, `version`, `priorAudit`, `outputPath`,
  `planPath`, `checklistPath`) is added via YAML only (no TS).
- **One composed prompt:** each agent run gets role + skill + inputs — no task content is invented.
- **Single-source-of-truth runtime rules:** path rendering/parsing, next-step resolution, and
  shared contracts should not be reimplemented ad hoc across multiple files.
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
