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

## 2. Runners are per-skill; three real adapters behind one seam

- Each skill declares its own default `agent`/`model`; the operator can override any skill's
  runner per run. Different skills in one loop may run on different CLIs/models.
- **All three providers — `opencode`, `codex`, `claude` — are real runnable adapters** (no
  stubs); `fake` is a deterministic no-spawn adapter for tests.
- Agent and model are a **coupled pair** (each CLI has its own model-id namespace). Runner
  precedence per skill: interactive per-skill pick > `--agent`/`--model` (run-wide) > skill
  manifest default > `.env` default. **Changing an agent re-defaults its model** to that
  agent's default model. `runner.ts` resolves this; `loop.ts` selects the adapter **per step**
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
  claude, full-auto for codex); without it the run silently stalls.
- **Adding a provider is not "one file."** It requires one adapter file **plus** registry
  wiring, a per-agent default model in config, agent/model-namespace validation, an env-gated
  contract test, live-smoke participation, an interactive option, and doc updates across
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

## 6. Plan before implementation; verify every real provider path

- `docs/dev/plan.md` is the design source of truth and is audited (`21-simple-plans-audit`) and
  repaired (`22-simple-plans-follow-up`) before implementation. Do not implement features that
  contradict an un-approved plan. Keep audit-response bookkeeping in versioned audit artifacts,
  not in the plan body.
- All behavior ships with tests. The deterministic e2e (`fake` adapter + fixtures) gates the
  **harness logic** (incl. provenance, dual-target isolation, and mixed-runner loops). **Each
  real provider path** (opencode, codex, claude) is gated by its own env-gated contract test
  plus a live mixed-CLI end-to-end smoke — approval requires all of them.
- A GitHub Actions CI workflow runs typecheck and deterministic tests on push and pull requests,
  while real-provider verification remains an env-gated/manual release sign-off requirement.
