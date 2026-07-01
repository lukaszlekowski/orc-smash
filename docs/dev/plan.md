---
status: in-progress
confidence: 0.96
owners: harness-runtime
target: Batch 3 - Provider & Runtime Hardening (roadmap #30, #31, #29)
---

# Implementation Plan - Batch 3: Provider & Runtime Hardening

This plan replaces the archived over-specified Batch 3 draft. The feature scope is unchanged:

- **#31:** add operator-configurable watchdog timeouts for `claude` and `codex`.
- **#30:** add Antigravity `agy` as a fourth real provider.
- **#29:** make interrupted provider runs visible, terminate child processes, and prevent partial/late artifacts from blocking resume.

The plan is intentionally contract-focused. Implementation details should follow existing local patterns unless a contract below says otherwise.

## Confidence

| Item | Confidence | Basis |
|------|------------|-------|
| #31 watchdog timeouts | 0.96 | `runProcess` already supports timeout killing; opencode already has the resolver/config pattern. |
| #30 `agy` provider | 0.95 | CLI invocation and model behavior are probe-confirmed; auth fallback needs explicit detection and real-provider sign-off. |
| #29 interrupted-run handling | 0.95 | The design uses durable marker state plus next-run cleanup; risk is bounded to signal/timing behavior and must be proven with deterministic tests plus manual repro. |

## 1. Watchdog Timeouts For `claude` And `codex`

### Design

Extend the existing timeout model without changing opencode's current fallback behavior.

- Keep opencode's built-in fallback timeout at `600000` ms.
- Add `claude` and `codex` timeout support with built-in default `0` (disabled unless configured).
- Add `timeouts.claude`, `timeouts.codex`, and `timeouts.agy` to config. Codex and claude are config-only (resolved as config > built-in); no `CLAUDE_RUN_TIMEOUT_MS` or `CODEX_RUN_TIMEOUT_MS` env vars. `agy` is also config-only.
- Preserve the existing `spawnAgentProcess(command, args, cwd, lifecycle?, processRunner?)` call shape. Thread timeout through the lifecycle/options object rather than adding a positional parameter.
- Classify `raw.timedOut` as `RunErrorKind: 'timeout'` and emit a failed lifecycle event with `errorKind: 'timeout'`.
- Keep agent/model namespaces coupled and validated by `runner.ts`.

### File Impact

- `src/config.ts`: widen `ModelRegistry.timeouts`, schema validation, and `registryTimeoutFor`.
- `src/adapters/utils.ts`: add `resolveClaudeTimeoutMs`, `resolveCodexTimeoutMs`, built-in constants, and timeout classification in `spawnAgentProcess`.
- `src/adapters/codex.ts` and `src/adapters/claude.ts`: convert to factory adapters with optional `defaultTimeoutMs` and `processRunner` test seams, while preserving plain `codexAdapter` / `claudeAdapter` exports. The public `codexAdapter` / `claudeAdapter` exports remain the registry-facing defaults; the factories exist only to inject timeout and process seams.
- `src/adapters/registry.ts`: resolve `registryTimeoutFor(registry, 'codex')` and `registryTimeoutFor(registry, 'claude')` and pass them into the codex and claude factories at construction. Extend `CreateProductionRegistryOptions` with explicit deterministic test seams for codex and claude (e.g. `codexProcessRunner` / `claudeProcessRunner`, mirroring the existing `opencodeSpawn` seam on the opencode path) so `tests/adapters/registry-timeout-integration.test.ts` can observe `defaultTimeoutMs` crossing `createProductionAdapterRegistry` into each adapter without spawning a real binary. Production code never passes these seams.
- `orc.config.yaml`, `README.md`, `AGENTS.md`, `docs/architecture/overview.md`: document the new timeout keys and preserve the opencode timeout rule.

### Verification

- `tests/config.test.ts`: `timeouts.opencode`, `timeouts.claude`, `timeouts.codex`, and `timeouts.agy` parse; unknown timeout keys are still rejected.
- `tests/adapters/utils-timeout.test.ts`: resolver precedence is config > built-in for codex/claude; `"0"` disables; opencode retains env > config > built-in precedence (env vars `OPENCODE_RUN_TIMEOUT_MS` and opencode-specific override contract).
- `tests/adapters-lifecycle.test.ts`: canned `timedOut: true` runner proves codex and claude return `error.kind === 'timeout'` and emit failed lifecycle events.
- `tests/adapters/registry-timeout-integration.test.ts`: configured codex/claude timeout reaches the adapter through the production registry via a deterministic seam — the test injects a fake `codexProcessRunner` / `claudeProcessRunner` into `createProductionAdapterRegistry` and asserts the resolved `defaultTimeoutMs` is forwarded into each adapter factory. This proves the production wiring itself (not just adapter-local factory tests or real-binary runs).
- Env-gated real-provider timeout proof in `tests/adapters-contract.test.ts` or a sibling contract: codex and claude are spawned with a deliberately long-running prompt and a tiny configured timeout (e.g. 1000 ms); the real run must fail as `error.kind === 'timeout'` and emit the failed lifecycle event, not merely pass deterministic seam tests. Expected evidence: `src/adapters/codex.ts` and `src/adapters/claude.ts` both surface the timeout through `RunErrorKind: 'timeout'`, and `src/adapters/registry.ts` passes configured timeout defaults to the real adapters.
- Gate: `pnpm typecheck && pnpm test`.

## 2. Antigravity `agy` Provider

### Design

Add `agy` as a real production adapter with the same black-box subprocess boundary as the existing providers.

- Invocation contract: `agy -p <prompt> --model <model> --dangerously-skip-permissions`.
- Model ids are the human-readable names printed by `agy models`, passed verbatim. In this batch, `agy` does not accept open-ended custom model ids: the only valid `agy` models are the exact strings listed in `config.registry.providers.agy`. `src/runner.ts:isValidModelForAgent` must treat `agent === 'agy'` as an allow-list lookup against that configured provider list, with optional trimming for input normalization but no namespace-only fallback. Values such as `gpt-5.5`, `opencode/...`, `claude-...`, or any other string not present in `providers.agy` are rejected through both runner resolution and the interactive custom-model prompt path.
- Default-model contract: adding `agy` extends `registry.providers.agy`, but does not change `registry.defaults.agent` or `registry.defaults.model`. The intended default when an operator switches an existing run to `agy` is the current runner/interactive behavior already used for every non-default agent: re-default to `registry.providers.agy[0]`. No new per-agent-default config field is introduced in this batch.
- Auth-failure detection is not optional. The **observed** unauthenticated `agy` output is the single banner line `Error: authentication failed or timed out` (verified by running `agy -p <prompt>` with no credentials), so the adapter must classify this exact case as `error.kind = 'auth'` — not as a generic nonzero-exit failure, and not as a success. Detection stays adapter-local in `src/adapters/agy.ts` and must use an agy-specific bounded phrase list over combined stdout+stderr, not a bare `/auth/` substring. The implementation contract is a dedicated constant such as `AGY_AUTH_FAILURE_PATTERNS` containing case-insensitive whole-token / whole-phrase matches derived from the observed unauthenticated CLI output, anchored on the observed banner — the whole phrase `authentication failed` (matching the real `Error: authentication failed or timed out`); additional defensive tokens (e.g. `401`, `unauthorized`) are permitted but must not be the test target. Benign substrings such as `author`, `authority`, `authentication succeeded`, or other unrelated `auth` text must not classify the run as auth failure.
- Auth detection and no-artifact safety are split across two owners, because the adapter cannot know the resolved artifact path. `src/adapters/types.ts:RunInput` carries only `prompt`, `model`, `cwd`, `skillId`, `version`, and `onLifecycle`; the resolved output path is computed by `src/loop.ts:runLoop` via `src/patterns.ts:renderPattern(loopSpec.<pattern>, { n, agent })` plus `resolve(projectRoot, …)`, and that resolution happens after `adapter.run` returns. Therefore the agy adapter owns only **detection**: when the bounded agy auth detector fires after `spawnAgentProcess` returns, `src/adapters/agy.ts:run` sets `result.error.kind = 'auth'` (with a one-line remediation message) and returns — it never resolves, reads, deletes, or quarantines artifact paths, because it has no access to them and must not duplicate manifest/path rules inside the adapter. **Cleanup is loop-owned**: `src/loop.ts` is the only module that knows the resolved output path for audit, follow-up, and implement steps alike, so after `adapter.run` returns, whenever `result.error?.kind === 'auth'`, `runLoop` quarantines the step's resolved `absOutputPath` (the same path it would read on success) through the shared quarantine helper introduced for interrupted artifacts (§3), before returning the failure summary. Because `'auth'` is a shared `RunErrorKind`, this branch is generic and future-proof, but today only `agy` produces it. The postcondition is strict and owned by the loop: an unauthenticated agy run must leave behind no resumable audit, follow-up, or implement artifact under an active `docs/dev/*-vN-agy.md` path that matches manifest/state patterns; the quarantined file moves to the repo's existing archived-artifact location and is therefore ignored by `src/state.ts` scanning.
- Prefer reusing `spawnAgentProcess` for process/lifecycle behavior and post-process captured output for agy-specific auth/fallback patterns. If implementation uses direct `processRunner`, it must still satisfy the existing `LifecycleEvent` and `RunResult` contracts exactly.
- `agy` receives timeout only from `timeouts.agy` config; no `AGY_RUN_TIMEOUT_MS` env var.
- Timeout enforcement is harness-owned and follows the existing adapter seam exactly. `src/adapters/registry.ts:createProductionAdapterRegistry` resolves `registryTimeoutFor(registry, 'agy')` and passes that value into `src/adapters/agy.ts:createAgyAdapter({ defaultTimeoutMs, processRunner? })` at registry construction time. `CreateProductionRegistryOptions` also gains an explicit deterministic test seam for agy (e.g. `agyProcessRunner`, mirroring `opencodeSpawn` and the codex/claude seams in §1), so `tests/adapters/registry-timeout-integration.test.ts` can observe `defaultTimeoutMs` reaching the agy adapter through the production registry without spawning a real binary; production code never passes it. `src/adapters/agy.ts:buildRun` remains a pure command/args builder and does not own timeout injection. `src/adapters/agy.ts:run` forwards `defaultTimeoutMs` into `src/adapters/utils.ts:spawnAgentProcess` through the widened lifecycle/options object, where the existing timeout mechanism enforces the deadline and classifies `raw.timedOut` as `RunErrorKind: 'timeout'`. No CLI timeout flag is used; the config key is live only through that registry-to-adapter-to-run path.

### File Impact

- `src/adapters/agy.ts`: new adapter and factory export; must accept `defaultTimeoutMs` and pass it to `spawnAgentProcess` via lifecycle options.
- `src/adapters/registry.ts`: register `agy` in the production registry, resolving `registryTimeoutFor(registry, 'agy')` and passing it through `createAgyAdapter`. Add an `agyProcessRunner` option to `CreateProductionRegistryOptions` (mirroring `opencodeSpawn` and the codex/claude seams) and forward it into the agy factory, so the production timeout wiring is deterministically observable.
- `src/config.ts` and `orc.config.yaml`: add `agy` provider models. Keep the global `defaults.agent/model` pair unchanged; the `agy` fallback model is `registry.providers.agy[0]` when the selected agent changes to `agy`.
- `src/runner.ts`: add the `agy` model validation rule as a strict membership check against `registry.providers.agy`, keeping the repo's agent/model boundary enforcement in one place.
- `src/interactive.ts`: keep interactive agent switching aligned with the same `registry.providers.agy[0]` fallback contract used by `resolveRunner`, without mutating the global `defaults.agent/model` pair, and ensure the custom-model prompt surfaces the same `providers.agy` allow-list rule instead of accepting arbitrary strings.
- `src/adapters/agy.ts`: own only the bounded auth **detection** (`AGY_AUTH_FAILURE_PATTERNS` over combined stdout+stderr) and set `result.error.kind = 'auth'`. It must NOT resolve or mutate artifact paths (it cannot: `RunInput` carries no output path).
- `src/loop.ts`: own auth-failure artifact cleanup. After `adapter.run` returns, when `result.error?.kind === 'auth'`, quarantine the step's resolved `absOutputPath` (computed via the same `renderPattern` + `resolve` used on the success path) through the shared quarantine helper, so no resumable `*-agy.md` artifact remains under active `docs/dev/` patterns. This cleanup applies to audit, follow-up, and implement step paths.
- `tests/adapters-contract.test.ts`: add env-gated real-provider tests.
- `tests/interactive.test.ts` and `tests/runner.test.ts`: extend existing runner-selection tests to cover `agy` agent switching and strict allow-list validation. These tests must prove that selecting `agy` re-defaults to `registry.providers.agy[0]` without changing the global `defaults.agent/model` pair, and that custom entries like `gpt-5.5`, `opencode/...`, `claude-...`, or any unconfigured agy label are rejected when `agent === 'agy'`.
- `tests/adapters/agy.test.ts` or the existing adapter seam test file for `src/adapters/agy.ts`: prove the adapter returns `result.error.kind === 'auth'` on bounded auth detection for both audit/follow-up-style and implement-style command shapes, performs NO filesystem mutation (no output path is available to it), and leaves any written artifact intact on authenticated success. The no-artifact postcondition (quarantine of the resolved path) is proven at the `src/loop.ts` seam by a loop-level test, not in this adapter file.
- `src/adapters/testing.ts`: note that `createTestAdapterRegistry()` continues to wrap the production registry and only adds `fake`; `agy` coverage relies on the same production-registry wiring plus targeted adapter seams.
- `README.md`, `AGENTS.md`, `docs/architecture/overview.md`: document `agy` as a fourth real provider, including autonomy flag, model-id rule, auth caveat, and timeout behavior.

### Verification

- Unit tests prove `agy` is registered, selectable through configured providers, and validates model strings as a strict configured allow-list: configured agy labels are accepted; `gpt-5.5`, `opencode/...`, `claude-...`, and any unconfigured agy label are rejected.
- Deterministic timeout-enforcement test in `tests/adapters-args.test.ts` proves `agy` command construction does not include any CLI timeout flag; timeout is enforced via `spawnAgentProcess` lifecycle options.
- Registry-timeout integration test in `tests/adapters/registry-timeout-integration.test.ts` proves the configured `timeouts.agy` default reaches the `agy` adapter through the production registry via the injected `agyProcessRunner` seam — not only schema/docs, and not only an adapter-local factory test.
- Runner-selection tests in `tests/interactive.test.ts` and `tests/runner.test.ts` prove that switching to `agy` re-defaults to `registry.providers.agy[0]` and that the same strict `providers.agy` allow-list is enforced through both runner resolution and the interactive custom-model flow. Those tests must include negative cases for `gpt-5.5`, `opencode/...`, `claude-...`, and an otherwise human-readable but unconfigured agy label. They also prove the global `defaults.agent/model` pair is unchanged.
- Adapter-seam tests for `src/adapters/agy.ts` prove the auth detector is bounded and provider-specific and that the adapter owns detection only: a positive case with observed unauthenticated phrases returns `result.error.kind === 'auth'` and performs NO filesystem mutation (the adapter has no path input and never touches artifact paths); negative cases with successful output containing unrelated `author`, `authority`, or `authentication succeeded` text remain successful. These tests assert the adapter returns the structured `auth` error and performs no cleanup, leaving the no-artifact postcondition to the loop-owner test below.
- Unified contract test in `tests/adapters-contract.test.ts` (or a sibling contract file) defines one authenticated success path and one unauthenticated failure path for `src/adapters/agy.ts`, driven through the loop's run path so the no-artifact postcondition is proven against its real owner. The authenticated path proves the loop treats a successful agy-style run as success and does not misclassify benign stdout/stderr containing unrelated `auth` substrings. The unauthenticated path proves that after the adapter returns `result.error.kind === 'auth'`, the **loop** quarantines the matching resolved artifact (asserted at the `src/loop.ts` seam, not inside the adapter), leaving no resumable `docs/dev/*-vN-agy.md` file behind for either plan-style or implement-style outputs. Both paths use the same detector rule; neither path is tested in isolation from the other; the contract file owns both and asserts cleanup against `src/loop.ts` as the named owner.
- Manual agy verification: from an already-authenticated operator shell, run `agy -p "return hi" --model "Gemini 3.5 Flash (Medium)" --dangerously-skip-permissions` and confirm the CLI either returns a short response or exits with an explicit auth/config error without silent fallback.
- Manual smoke: `orc smash -p <project> -l plan -a agy -m "Gemini 3.5 Flash (Medium)"` writes the expected audit artifact under the target project's `docs/dev/`.
- Gate: `pnpm typecheck && pnpm test`, plus manual agy verification before release sign-off.

## 3. Interrupted-Run Handling

### Design

Interrupted runs must not leave orphaned provider processes, must be visible to the operator, and must not let partial or late artifacts become terminal `unknown` state on the next run.

Use four small ownership boundaries with one explicit status path:

- `src/adapters/utils.ts` owns active child tracking and process termination.
- `src/interrupted-artifact.ts` owns the interrupt context API end to end: active project-root registration/clear, active step-context registration/clear, marker read/write/clear, and artifact quarantine.
- `src/state.ts` remains a fact scanner and owns one explicit display-only status helper that merges marker facts into a status timeline while leaving decision-path scans unchanged.
- `src/status.ts` remains the only read-only message composer and interrupted status text owner; `src/commands/status.ts` remains the only loop selector and wiring layer.

Required behavior:

- `SIGINT` / `SIGTERM` calls the interrupt-context API, which writes an interrupted marker for the active step when one exists, terminates active provider children with SIGTERM then SIGKILL after a bounded grace period, and exits with the conventional signal code.
- The marker is written under the active `projectRoot`, not `process.cwd()`.
- The marker includes enough information to resolve the interrupted artifact through the manifest loop patterns: loop name, step kind, version, agent, model, skill id, and interruption timestamp. The marker's `loop` field is authoritative for status loop selection (see the `statusAction` precedence rule below).
- The interrupt-context API is no-op safe before config/setup completes, after loop completion, and when no step is in flight. `cli.ts` does not own mutable run context itself; it only delegates signal handling to the runtime module that does.
- `src/commands/smash.ts` registers the active `projectRoot` immediately after config load succeeds and clears it on normal completion. `src/loop.ts` registers active step context only while a provider subprocess is live and clears it in `runAdapter`'s `finally` path. The shared interrupt-context API is the only place that combines those registrations into signal-time behavior.
- At the start of `resolveSmashRunSetup` after config load succeeds, quarantine the in-flight artifact identified by the marker before any decision-path scan can hit `unknown`.
- At the start of `runLoop`, run the same in-flight quarantine plus late-artifact quarantine for files newer than the marker timestamp.
- `src/state.ts` adds one explicit display-only scan/helper, such as `scanForStatus(...)` or `scan(..., { includeInterruptedDisplay: true })`, that reads the interrupted marker, synthesizes the interrupted step for the active loop, and suppresses any matching partial artifact row from the returned display timeline. This helper is the only place that merges marker facts with artifact facts for status display.
- `statusAction` in `src/commands/status.ts` remains the only loop selector, with an explicit precedence rule: if an interrupted marker is present, `statusAction` must select `marker.loop` first — before falling back to the audit-history heuristic. This rule is required because the current heuristic skips `implement` loops (`spec.kind === 'implement'` → `continue`) and otherwise picks the non-implement loop with the most audits, so without the marker precedence an interrupted `implement` run would render as `plan`/`review` state or vanish from the read-only view even though the marker says `loop: implement`. After selecting the loop (marker-first, then heuristic), `statusAction` calls the display-only state helper for that loop and passes the returned timeline plus interrupted fact shape into `src/status.ts`.
- `src/status.ts` remains the only read-only message composer. It must expose the interrupted-aware next-step/message API consumed by `statusAction`, and no other module may synthesize user-facing interrupted copy.
- Normal decision-path scans must not include synthetic interrupted steps; only `statusAction` uses the interrupted-aware path.
- When status display includes an interrupted marker and a matching partial artifact, suppress the matching partial row from the displayed timeline so the operator sees one interrupted step rather than a duplicate unknown/done row.
- Read-only message contract:
  `plan` interrupted -> message states that planning was interrupted and rerun resumes from the interrupted version after quarantine.
  `review` interrupted -> message states that review was interrupted and rerun resumes review after quarantine.
  `implement` interrupted -> message states that implementation was interrupted, partial ledgers are quarantined before state resolution, and rerun resumes implementation rather than advancing to review.
  No interrupted state may render the audit-only fallback messages from `assembleNextStepMessage()` such as `Ready to smash ...` or `Completed: approved ...`.
- `setStepCtx` is non-null only while a provider subprocess is actively running, and is cleared in `runAdapter`'s existing `finally` path to avoid archiving completed artifacts from stale context.

### File Impact

- `src/adapters/utils.ts`: active child registry and `terminateActiveChildren`.
- `src/interrupted-artifact.ts`: new durable marker, active project-root setters/clearers, active step-context setters/clearers, signal-safe marker-write entrypoint, in-flight quarantine, and late-artifact quarantine.
- `src/cli.ts`: signal handler that delegates to the interrupt-context API and child termination path.
- `src/commands/smash.ts`: set project root and run setup-time quarantine after config load succeeds.
- `src/commands/status.ts`: set project root; `statusAction` resolves the active loop using marker-first precedence (prefer `marker.loop` when an interrupted marker is present, before the audit-history heuristic — this is the only way an interrupted `implement` loop can be selected), then calls the display-only interrupted scan/helper from `src/state.ts` for that loop, and feeds that result into the interrupted-aware read-only message API in `src/status.ts`.
- `src/loop.ts`: set/clear step context around adapter runs; run defensive quarantine at loop start.
- `src/state.ts`: extend `StepStatus` with `interrupted`; add explicit display-only scan/helper support (via `ScanOptions` or a named helper) that remains opt-in so decision-path defaults stay unchanged.
- `src/status.ts`: own interrupted-aware read-only next-step/message rules for `plan`, `review`, and `implement`, replacing the current audit-only fallback path when interrupted display facts are present.
- `src/status-accent.ts`, `src/status-panel.ts`, `src/plain-render.ts`: render interrupted steps as `interrupted`, not `unknown`.

### Verification

- `tests/terminate-children.test.ts` or equivalent: a real long-lived child spawned through the process runner is terminated by `terminateActiveChildren`.
- `tests/interrupted-artifact.test.ts`: marker write/read/clear, launch directory differs from project root, late artifact quarantine, in-flight quarantine for plan/review/implement patterns, corrupted marker handling, no-marker no-op, and reset of interrupt state between tests.
- `tests/state.test.ts` or interrupted-artifact scan tests: default decision-path `scan` excludes interrupted synthetic steps; the explicit display-only helper in `src/state.ts` includes them without changing decision-path facts; matching partial artifacts are suppressed in status display mode.
- Deterministic e2e with fake adapter: partial plan audit and partial review audit plus marker do not block `smashAction`; files are moved under `docs/dev/archived/`. Additionally, a partial implement artifact (`docs/dev/impl-v{n}-{agent}.md` plus marker) is quarantined before `resolveImplementFacts()` / `resolveSmashRunSetup()` can advance state; the next run does not default to `review` or return terminal `unknown`.
- Renderer tests: panel and plain output show the literal `interrupted` for audit, follow-up, and implement steps.
- Status-entrypoint test covering `src/commands/status.ts` loop selection and interrupted display for `plan`, `review`, and `implement` runs; verifies `statusAction` remains the loop selector, consumes the display-only helper from `src/state.ts`, and does not duplicate synthesis logic locally. It must include a regression case where an interrupted `marker.loop === 'implement'` coexists with richer `plan` audit history and prove the rendered panel still selects `implement` (marker precedence beats the max-history heuristic that would otherwise skip implement).
- Read-only status-message tests in `tests/status-action.test.ts` and the relevant renderer tests assert the final interrupted message text for `plan`, `review`, and `implement`, including the rule that interrupted states never render the audit-only fallback messages from `assembleNextStepMessage()`.
- Interrupt-context tests cover pre-setup, in-flight, and post-completion signal handling: marker writes are no-op before project-root registration and after context clear; in-flight signals write to the active project root, kill the correct child, and leave no stale interrupt context for the next run.
- Manual repro: interrupt a slow plan/review/implement run; confirm child process is gone, `orc status` shows interrupted (not generic unknown), rerun resumes without `latest audit is unparseable`, and partial/late artifacts are archived.
- Gate: `pnpm typecheck && pnpm test`.

## 4. Sequencing

1. Implement #31 first because it is localized and establishes shared timeout behavior used by codex/claude and optionally `agy`.
2. Implement #30 second because it adds a provider and must pass both deterministic and env-gated real-provider checks. No pre-implementation probe is required because timeout is harness-owned via `spawnAgentProcess`; the env-gated timeout proof will verify the config key is live.
3. Implement #29 last because it touches process lifecycle, CLI signal handling, state scanning, status rendering, and loop startup.

## 5. Non-Goals

- Do not change opencode's built-in fallback timeout behavior.
- Do not split opencode model ids into endpoint/model components; provider prefixes remain provider-owned opaque ids.
- Do not add `fake` to the production registry.
- Do not add `agy` as a per-skill default in `skills.yaml`, and do not change the global `defaults.agent/model` pair for this batch; operators can select it through runner overrides and existing registry-driven per-agent fallback behavior (`providers.agy[0]` when `agy` is selected).
- Do not make interrupted synthetic steps visible to normal decision-path scans.
- Do not implement per-stamp-site quarantine guards; next-run marker-based quarantine is the source of truth.
- Do not call model APIs directly from orc-smash.

## 6. Verification Matrix

| Area | Required proof |
|------|----------------|
| Config and timeouts | `pnpm typecheck && pnpm test`; config tests for all timeout keys and strict rejection of unknown keys; resolver precedence tests (opencode: env > config > built-in; codex/claude: config > built-in); `tests/adapters/registry-timeout-integration.test.ts` observes `defaultTimeoutMs` for codex/claude/agy crossing `createProductionAdapterRegistry` via injected process-runner seams (not real binaries). |
| Codex/claude timeout behavior | Env-gated real-provider timeout proof in `tests/adapters-contract.test.ts` or sibling contract proves real codex/claude runs fail as `error.kind === 'timeout'` with tiny configured timeout; deterministic seam tests prove classification and config flow; resolver tests prove config > built-in precedence for codex/claude. |
| Agy adapter | Unit tests for registration, strict allow-list validation against `providers.agy` (including rejection of `gpt-5.5`, `opencode/...`, `claude-...`, and unconfigured human-readable labels), and clean-output behavior; deterministic timeout-enforcement and registry-timeout integration tests; runner-selection tests in `tests/interactive.test.ts` and `tests/runner.test.ts` proving agent/model coupling and `providers.agy[0]` fallback without changing global defaults while enforcing the same allow-list through the custom-model path; adapter-seam tests proving bounded auth detection (the adapter returns `error.kind === 'auth'` and performs no filesystem mutation) and explicit no-false-positive cases for benign `author` / `authority` / `authentication succeeded` output; loop-owned auth-failure cleanup proven at the `src/loop.ts` seam (the adapter cannot know the resolved output path); unified contract test in `tests/agy-contract.test.ts` proving authenticated success and unauthenticated failure with the same bounded agy-specific detector, including the no-resumable-artifact postcondition (asserted against `src/loop.ts` as the cleanup owner) for plan-style and implement-style outputs; manual operator verification confirms the installed CLI can execute a probe from an already-authenticated shell without relying on the browser login flow. |
| Interrupted child cleanup | Real child termination test proves no orphaned process remains after `terminateActiveChildren`. |
| Interrupted marker and quarantine | Unit tests prove marker path correctness, in-flight quarantine for plan/review/implement patterns, late quarantine, loop-pattern resolution, and stale-context safety; deterministic e2e proves implement quarantine prevents state advancement to `review`. |
| Status and resume | `statusAction`-level test proves interrupted `plan`, `review`, and `implement` steps are visible via the status entrypoint and use interrupted-aware read-only messages through the concrete `src/state.ts` display-helper → `src/commands/status.ts` loop selection (with `marker.loop` precedence over the audit-history heuristic, including an interrupted `implement` marker alongside richer plan history) → `src/status.ts` message path; scan/render tests prove interrupted status is visible only in display mode; interrupt-context tests prove signal handling is safe before setup, during active runs, and after completion; fake-adapter e2e proves partial plan/review artifacts do not block resume and partial implement artifacts are quarantined before `resolveImplementFacts()` / `resolveSmashRunSetup()` advances state. |
| Documentation sync | `AGENTS.md`, `README.md`, and `docs/architecture/overview.md` describe the same provider set, timeout policy (opencode env > config > built-in; codex/claude/agy config-only), runner model, verification gates, and agy auth/timeout behavior. |

## 7. Release Gate

This plan is ready for audit when:

- `docs/dev/plan.md` is the only active Batch 3 plan document under `docs/dev/`.
- Active versioned plan audit/follow-up artifacts (`docs/dev/plan-audit-vN-*.md`, `docs/dev/plan-followup-vN-*.md`) remain under `docs/dev/` and are NOT archived before a new audit run. These active `*-vN-*` filenames are the inputs `src/state.ts:scan`, `src/commands/smash.ts:resolveSmashRunSetup`, and `src/loop.ts:runLoop` use to derive the next version (`latestVersion + 1`) and restart state, and the `21-simple-plans-audit` skill requires `priorAudit` continuity for v2+ runs. Archiving them out of the scanner's view would reset the visible history and break the stateless `vN` progression.
- `docs/dev/archived/` is reserved only for superseded plan drafts (e.g. the archived over-specified Batch 3 draft this plan replaces) and for intentionally quarantined artifacts produced by interrupt/auth-failure handling (§2, §3). It must not hold active audit/follow-up history.
- A new `21-simple-plans-audit` run can audit this plan using the active `docs/dev/plan-audit-vN-*` / `plan-followup-vN-*` chain for `priorAudit` continuity.

Implementation is ready for review only after:

- deterministic checks pass with `pnpm typecheck && pnpm test`;
- env-gated real-provider checks pass for the contract-gated providers touched by the current repo state (opencode, codex, and claude), and agy is manually verified from an already-authenticated shell;
- codex/claude timeout behavior is proven with tiny configured timeout and real provider runs;
- manual interrupt repro is recorded for at least one slow real provider path.

## Change Log

### Implementation v1-claude & follow-up (2026-07-01)

- All three sections implemented and verified: `pnpm typecheck && pnpm test` passes (386 passed, 0 failures, 11 skipped).
- **Deviations and Corrections**:
  - **Late-quarantine fix**: Corrected a v1 bug in `quarantineLateArtifactsForLoop` where the follow-up spec referenced the skill ID `'follow-up'` instead of `followUpPattern`. A regression test was added to verify late follow-up and implement quarantine.
  - **agy auth hardening**: The detector is grounded in the operator-confirmed unauthenticated output `Error: authentication failed or timed out`, keeps generic `401`/`unauthorized` detection stderr-only, and strips fenced code before scanning. Browser-based agy login remains a manual operator verification step rather than an automated contract gate.
  - **Interpretation**: The plan's File Impact line "src/commands/status.ts: set project root" is satisfied by `statusAction` resolving the project root and registering/clearing it via `setActiveProjectRoot`.
- **Release-gate items still pending** (cannot run in this environment — require credentials / a
  real provider install), per §7:
  - env-gated real-provider contract runs (`OPENCODE_CONTRACT=1 CODEX_CONTRACT=1 CLAUDE_CONTRACT=1
    pnpm test`), including the codex/claude tiny-timeout proofs;
  - manual agy verification from an already-authenticated shell using `agy -p "return hi" --model "Gemini 3.5 Flash (Medium)" --dangerously-skip-permissions`;
  - manual interrupt repro against at least one slow real provider path.
  The deterministic seams, registry-timeout integration, and loop-level agy auth contract are all
  green; only the credentialed real-binary runs remain as a release sign-off.
