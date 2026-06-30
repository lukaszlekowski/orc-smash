# Roadmap

## Short checklist

Current pending work, grouped into recommended implementation batches.

**Batch 1 — Runner and Provider Hardening**

- [ ] **22 — inspect opencode model naming boundary**
- [ ] **25 — provider execution contract hardening**

**Batch 2 — Rendering and Output Polish**

- [ ] **5 — Live status panel**
- [ ] **23 — TUI border simplification**
- [ ] **24 — plain mode multiline readability**

**Batch 3 — Interaction Flow and Docs**

- [ ] **8 — Prompt to extend iterations at max**
- [ ] **14 — docs canonicalization + broken plan reference fix**

## Detailed checklist

Only unresolved work is listed below. Each item is phrased as an open problem with the most relevant analysis kept in place.

## Architecture assumptions and implementation goal

Every checklist item below should be implemented against the same architectural standard:

- Prefer **clear module boundaries** over generic helper extraction. A new file is justified only when it owns a stable responsibility, shared domain rule, or testable contract.
- Prefer **small pure modules** for domain rules (`patterns`, next-step resolution, shared contracts) and keep orchestration in a small number of runtime entrypoints.
- Avoid vague catch-all files such as `helpers.ts`, `misc.ts`, or `common.ts`. If a module cannot be named by responsibility, it probably should not exist.
- Keep the runtime **incrementally evolvable**. Refactors should create seams for later features without forcing a top-down rewrite or a folder reorganization for its own sake.
- Keep abstractions **data-oriented and explicit**: structured events, typed contracts, single-source-of-truth rules, and adapter boundaries that separate provider-specific behavior from shared harness behavior.
- Preserve **behavioral stability** while refactoring. The goal is cleaner structure, not silent product changes, except where the checklist item explicitly adds user-facing behavior.

The implementation goal for this roadmap is a **clean, scalable, high-quality harness architecture**: fewer duplicated rules, fewer hidden couplings, smaller orchestration files, explicit runtime contracts, and only purposeful modules added where they improve clarity and long-term maintenance.

**Batch 1 — Runner and Provider Hardening**

- [ ] **22 — Inspect opencode model naming boundary.** Decide whether identifiers such as `opencode-go/deepseek-v4-flash` should remain a single model string or be split into provider/endpoint plus model name, for example `opencode-go` as endpoint/provider metadata and `deepseek-v4-flash` as the actual model identifier. The current repo behavior requires the `opencode-go/` prefix, but the architecture should make clear whether that prefix is truly part of the model namespace or a transport/endpoint concern that should live elsewhere in config and validation. The outcome should define the correct ownership boundary for config, validation, interactive selection, and docs.
- [ ] **25 — Provider execution contract hardening.** Close the remaining real-provider contract gaps discovered during implementation-stage runs. In particular, codify the correct non-interactive autonomy mode for `codex`, make implementation-stage artifact expectations explicit and verifiable, and decide whether `opencode`'s default timeout policy should stay fixed, become configurable-first, or become stage/provider-specific. The goal is to stop clean-exit/missing-artifact and timeout-path surprises from slipping through the harness as generic `unknown` failures.

Current interaction behavior that still needs to be preserved while finishing this area:

- When a loop is in an approved state, start-point selection should expose both:
  - `new-round`
  - `implement`
- After an audit reaches `APPROVED`, the post-approval action list should expose:
  - `stop`
  - `run-second-opinion`
  - `implement`
- Choosing `implement` should take the operator through agent/model selection and then run `30-simple-implement`.

**Batch 2 — Rendering and Output Polish**

- [ ] **5 — Live status panel.** Replace the current static redraw model incrementally: first establish a stable render region, then layer in adapter lifecycle events, then add richer per-provider progress where the signal is trustworthy. Avoid a one-shot TUI rewrite.
- [ ] **23 — TUI border simplification.** Review the current status panel rendering and remove unnecessary table borders / grid lines so the TUI uses less horizontal space and reads more cleanly. The timeline table should prefer a borderless or minimally-lined layout, and the outer panel border should also be reviewed for whether it needs a single consistent treatment instead of layered decorative framing. If the border remains, use stage / skill-specific color signaling so the operator can distinguish states such as `plan-audit` vs `plan-follow-up` directly from the panel chrome rather than relying only on text labels. Prefer a consistent mapping that is stable and easy to learn across loops.
- [ ] **24 — Plain mode multiline readability.** Rework `--plain` output so panel/state information is emitted as readable multiline blocks instead of collapsing too much content into single-line log records. Optimize for mobile terminal apps and narrow screens: emit loop / iteration / active runner / next-step fields on separate lines, render the timeline as stacked entries with timestamps, allow long fields such as model names to wrap onto follow-on lines, and prefer visually separated timeline records (for example `---` between entries) over dense comma-heavy one-line summaries. Treat the multiline separated form as the preferred direction over a compact single-line dump.

**Batch 3 — Interaction Flow and Docs**

- [ ] **8 — Prompt to extend iterations at max (consideration).** When the loop hits `max-iterations`, offer interactive users a controlled continuation choice without changing non-interactive behavior. Prefer bounded preset actions first (`stop`, `+1`, `+3`, `+5`) with optional custom input only if it proves necessary.
- [ ] **14 — Docs canonicalization + broken plan reference fix.** Make `docs/architecture/overview.md` the canonical architecture source, reduce duplicated architecture prose elsewhere, and fix or remove the broken `docs/dev/plan.md` references after the remaining runner/model, loop, and rendering changes have landed so the docs only need one final alignment pass.

---

## Batch 1 notes

This batch is about runtime correctness and provider semantics. It should land before UI polish because it affects what the harness considers a trustworthy implementation run and how model/provider identifiers are owned.

---

## 8 — Prompt to extend iterations at max (consideration)

Goal: when the loop reaches `max-iterations`, instead of a hard stop, offer the interactive user a choice —
extend by N more iterations, or stop — so a run that's converging isn't cut off just because the up-front
guess was too low.

> Current observation: after the iteration budget is exhausted the app fully stops with
> `hit max-iterations, awaiting human`. There is no chance to continue without re-running.

**Findings so far:**

- **It is a hard stop today.** `src/loop.ts` falls out of the `while (iteration < options.maxIterations)` loop and returns `hit max-iterations, awaiting human` in both interactive and non-interactive modes.
- **A similar prompt already exists** at the other decision point: on `APPROVED`, interactive mode already asks stop vs second-opinion. `promptMaxIterations` also already asks for the count up-front, so this change mirrors existing interaction patterns.
- **Extending is mechanically cheap.** `maxIterations` lives on `LoopOptions`, so extending is a local control-flow change rather than a state-model rewrite.
- **Must be interactive-only.** CI and `--loop` runs should keep the current exit behavior.

**Fix (to consider):**

- Add a dedicated continuation prompt to `src/interactive.ts`, but prefer bounded preset actions first (`stop`, `+1`, `+3`, `+5`) over free-form numeric input.
- Restructure the loop-exit branch so interactive continuation happens before the function returns, rather than by relying on awkward post-loop state mutation.
- Guard against accidental infinite prompting with bounded continuation rules or a clear “ask once per limit hit” policy.
- Keep non-interactive behavior and exit codes byte-for-byte identical.

**Effort:** S. This is a localized control-flow change in the loop termination path.

---

## 25 — Provider execution contract hardening

Goal: make real-provider implementation runs trustworthy by tightening the harness/runtime contract where recent failures exposed gaps.

> Current observation: `codex` can report a clean implementation run yet fail to produce the required `docs/dev/impl-v{n}-codex.md` ledger, while `opencode` can be terminated by the harness timeout before output is generated.

**Findings so far:**

- **`codex` non-interactive autonomy is under-specified in the adapter.** Local `codex exec --help` verification showed the relevant autonomy flag is `--dangerously-bypass-approvals-and-sandbox`, but the current adapter invocation does not pass it.
- **Implementation-stage success is too weakly defined for providers that exit `0`.** Today a provider can look successful at process level and still fail the run only at the post-hoc ledger existence check.
- **The implementation-stage ledger contract is not strongly enough enforced at prompt/contract-test level.** The real-provider codex contract test proves a trivial audit file write, not the implementation ledger flow.
- **`opencode` timeout handling is harness-owned and currently policy-light.** The default watchdog exists at the adapter layer, but the roadmap still needs an explicit decision about whether timeout policy should be global, provider-specific, stage-specific, or primarily operator-configured.

**Fix:**

- Update the `codex` adapter invocation so headless file-writing runs use the correct autonomy mode for this harness.
- Strengthen implementation-stage contract tests so real-provider verification includes the required `docs/dev/impl-v{n}-{agent}.md` artifact path and not just trivial audit-file writes.
- Tighten implementation prompting and/or runtime checks so “process exited successfully” does not masquerade as “implementation execution completed” when the required artifact contract was not actually met.
- Define and document the intended timeout policy ownership for `opencode`: fixed default, config-driven default, per-stage override, or some combination.

**Effort:** M. This is core runtime hardening work for real-provider implementation reliability.

---

## 5 — Live status panel

"Re-render on an interval" is the cheap framing. Accurate live status needs an event-driven adapter lifecycle and a stable render path.

> Current observation: when audit v2 is running, the panel only shows step 1 — as if not updating, not refreshing, or later updates aren't visible.

**Root cause:** the panel is rendered once before each spawn, then a static spinner runs for the whole spawn. v2 is appended to history only after it completes, so during the run the table shows only v1. `console.clear` reprints also flicker and discard scrollback.

**Fix:**

- Ship this incrementally. First establish a stable render region and clean renderer boundary on top of the output abstraction; only then add richer lifecycle/progress updates.
- Expose a small, provider-agnostic lifecycle model (`started`, `message`, `completed`, `failed`) and map provider-specific output into it only where the signal is trustworthy. Avoid inventing fake precision just to make the panel feel busy.
- Add richer per-adapter progress parsing gradually, starting with providers that already expose structured events well. Reuse existing stream parsing where appropriate rather than forcing every adapter into the same richness level on day one.
- Disambiguate iteration, version, and step index in the UI model before adding more live behavior.

**Effort:** L.

---

## Batch 2 notes

This batch is about operator-facing output. The items belong together because they all depend on the same rendering surface: live status updates, cleaner TUI chrome, and readable plain-mode output.

---

## 23 — TUI border simplification

Goal: reduce unnecessary visual density in the panel so the terminal UI uses less width and is easier to scan.

> Current observation: the current panel uses layered borders and a table-heavy presentation that consumes space without adding much information value.

**Focus:**

- Remove unnecessary table borders and grid lines.
- Re-evaluate whether the outer panel border needs a separate visual treatment from the timeline.
- If borders remain, use stable color/state signaling that helps distinguish stages directly from the chrome.

**Effort:** S.

---

## 24 — Plain mode multiline readability

Goal: make `--plain` output readable in narrow terminals and mobile terminal apps instead of collapsing state into dense one-line records.

> Current observation: the current plain renderer is scrollback-safe, but it compresses too much panel and timeline state into single lines.

**Focus:**

- Emit loop, iteration, active runner, and next-step fields on separate lines.
- Render timeline entries as stacked records rather than comma-dense summaries.
- Let long values such as model names wrap naturally.
- Prefer clear visual separators between records.

**Effort:** S–M.

---

## Batch 3 notes

This batch is for lower-risk interaction and documentation cleanup after runtime/provider semantics and rendering behavior are settled.
