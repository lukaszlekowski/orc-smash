# Roadmap

## Checklist

Grouped by what should ship together. **Batch A** (1/2/4) is one cohesive rework of the artifact +
metadata + timeline model — same files (`state.ts`, `loop.ts`, `prompt-composer.ts`, `provenance.ts`,
skill templates); splitting it means redoing the state model two or three times. **3** is independent
and parallelizable. **5** depends on both A and 3, so it ships last.

**Independent — runner (parallelizable, no deps on A)**

- [x] **3 — opencode runner.** Make opencode a real first-class adapter: correct its model config, validate it, parse the JSON event stream, surface errors. (Fix opencode — do not replace it.)

**After A + 3 — live panel**

- [ ] **5 — Live status panel.** Event-driven adapter lifecycle + per-adapter stream parsing + a stable render region, instead of a static reprint.

---

## 3 — opencode runner failures

Goal: make the **opencode** runner work as a first-class adapter. Fix it — do not substitute a
different provider for it.

> Current observation: `codex` and `claude` work, but `opencode` appears not to. Needs targeted investigation into adapter invocation, local CLI setup, authentication, model choice, or upstream behavior.

**Findings so far:** the adapter flags are all valid against the installed `opencode run --help` (`-m`, `--dir`, `--dangerously-skip-permissions`, `--format json`, positional) — this is **not** a CLI-version/flag problem. Two real defects remain: (a) the default model `opencode/deepseek-v4-flash` is not a valid opencode `provider/model` (the model `deepseek-v4-flash` does not exist under that provider name, resolving only as `opencode/deepseek-v4-flash-free` or `opencode-go/deepseek-v4-flash`), and the global opencode config registers no providers; (b) `--format json` emits a stream of raw JSON _events_, but `spawnAgentProcess` (`src/adapters/utils.ts`) dumps raw stdout and folds stderr into it, so neither the result nor the error is parsed.

**Fix:**

- Correct the default opencode model to a valid opencode `provider/model` in `OPENCODE_DEFAULT_MODEL` / `skills.yaml` (whatever provider/model opencode is meant to run — this is fixing opencode's config, not replacing opencode).
- Validate the model against opencode's known providers/models and **fail fast** with a clear message instead of passing a bad string through.
- Parse opencode's JSON event stream into a normalized `RunResult` (final message, tool calls, exit status) so verdict extraction and attribution work — in the opencode adapter, not in the generic spawner.
- Surface adapter stderr separately and detect auth/config failures (missing provider credentials, unknown model) as structured errors rather than folding them into an `unknown` verdict.
- Add/restore the opencode contract test (real spawn + write) so the path stays green.

**Effort:** M–L.

---

## 5 — Live status panel

"Re-render on an interval" is the cheap framing. Accurate live status needs an event-driven adapter
lifecycle and a stable render path.

> Current observation: when audit v2 is running, the panel only shows step 1 — as if not updating, not refreshing, or later updates aren't visible.

**Root cause:** the panel is rendered _once_ before each spawn (`console.clear` + `console.log` in `src/loop.ts`), then a static spinner runs for the whole spawn. v2 is appended to history only after it completes, so during the run the table shows only v1. `console.clear` reprints also flicker and discard scrollback.

**Fix:**

- Decouple rendering from the blocking spawn: the adapter returns a lifecycle handle emitting `started | progress | done | failed`; a render loop subscribes and redraws. Replace `console.clear` + boxen reprint with a stable render region / double-buffered TUI.
- Per-adapter stream parsers turn provider output into progress events ("editing path X", "tool call Y") — reusing the JSON-stream parsing from item 3 — so the panel shows what the active agent is doing, not just a spinner.
- Disambiguate the counters: iteration, version, and step index are currently conflated.

**Effort:** L (depends on 3's stream parsing and 4's step model).
