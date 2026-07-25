---
status: ready
confidence: 0.97
owners: harness-runtime
---

# Batch 4 — Provider Progress Telemetry

## Goal and release boundary

Show honest live activity and tool-call information beneath the timeline for
providers that expose a verified structured stream. OpenCode remains the
reference implementation; Codex gains a provider-owned streaming parser;
Claude is a static `structured` target gated by accepted real-stream evidence;
and AGY is explicitly reported as unsupported until its CLI exposes a stable
structured stream.

This release changes observability only. Telemetry must not affect artifact
content, output-contract classification, pipeline state, provider success,
timeouts, interruption, ownership, session continuity, or final response
parsing.

The existing owner-controlled changes in `config/runners.yaml` are not part of
this release. Do not overwrite them, stage them with Batch 4, or use their
session-strategy behavior as telemetry evidence. If they are intended to ship,
verify and commit them independently.

## 1. Make progress support an explicit adapter capability

### Design

Extend `AgentAdapter.capabilities` with a closed progress capability such as
`structured | unavailable`. OpenCode, Codex, and the deterministic fake adapter
declare `structured`; Claude declares `structured` only after the blocking
evidence gate in Section 4 has passed; AGY declares `unavailable`. The committed
capability values are static—runtime probes or environment variables never
change them.

Resolve this capability before attaching the live panel. Carry it through the
in-flight display model and the provider-started run event so both the rich
panel and plain event log describe support consistently. The `provider.started`
payload (`src/run-event.ts:21`) gains a capability field as an **additive**
change that does not bump `SCHEMA_VERSION = 1` (`src/run-event.ts:1`);
`renderRunEvent` (`src/plain-event-renderer.ts:72-73`) prints it only when
present, so older consumers keep working. The in-flight display model carries
the same capability explicitly so an *unsupported* provider renders the
unavailable state from its declaration, not from the absence of messages. During
an unsupported AGY invocation, keep elapsed time and the spawn label visible and
show a concise `Live progress unavailable for this provider` state. Absence of
messages from a supported provider is simply “no activity received yet”; it is
never a completion or stall signal.

Keep `LifecycleEvent.message` as the provider-neutral delivery surface. New
provider integrations emit only structured, safe activity labels and
incremental tool-call counts; OpenCode retains its existing verified lifecycle
translation. Shared execution remains responsible for sanitization,
deduplication, length limits, event-rate limits, suppression accounting, and
the displayed cumulative count. Use one shared display formatter so both the
live panel and terminal provider events render counts above 999 as `999+`.

### File impact

- `src/adapters/types.ts` — define the progress capability on the adapter
  contract.
- `src/loops/execution.ts`, `src/status.ts`, `src/run-event.ts` — propagate the
  capability into live and plain output without branching on provider names.
  `PanelContext['inFlight']` (`src/status.ts:55-73`) gains an explicit
  `progressCapability: 'structured' | 'unavailable'` field, and `provider.started`
  (`src/run-event.ts:21`) gains the capability as an additive payload (no
  `SCHEMA_VERSION` bump).
- `src/status-panel.ts`, `src/plain-event-renderer.ts` — render the supported or
  unavailable state. `renderInFlightSection` (`src/status-panel.ts:186-209`)
  renders the `Live progress unavailable for this provider` line when
  `progressCapability === 'unavailable'`, driven by the declaration rather than
  by message absence; `renderRunEvent` prints the capability only when present.
  A shared status formatter applies the same `999+` tool-count cap to live and
  terminal presentation.
- Adapter factories and test adapter fixtures — declare the capability
  explicitly.

### Verification

- Rich and plain output agree on whether live progress is supported.
- AGY displays the unsupported state throughout an active invocation without
  changing its eventual success or failure.
- A supported provider that emits no message remains running with zero tool
  calls.
- Capability handling is generic: a renamed or test adapter receives the same
  behavior from its declaration alone.
- A dedicated capability-declaration test (`tests/adapter-capabilities.test.ts`)
  asserts `adapter.capabilities.progress` for opencode/codex/claude/fake
  (`structured`) and agy (`unavailable`); a renamed or test adapter with the same
  declaration receives identical behavior.
- `tests/run-event.test.ts` covers the additive `provider.started` capability
  field — the event still parses with `SCHEMA_VERSION = 1`, and a plain-rendered
  line omits the capability when it is absent.
- Live and terminal tool counts agree at 999 and 1,000 calls, including at a
  narrow terminal width.

## 2. Add bounded stream framing and terminal lifecycle ownership

### Design

The ordinary process runner and `OwnedSpawnRuntime` already deliver stdout
chunks. Thread that existing callback through `spawnAgentProcess`; do not
redesign process-group ownership. Ensure both raw subprocess paths use a
stateful UTF-8 decoder so a native buffer boundary cannot corrupt a multibyte
JSON string before it reaches the JSONL layer.

Add one small, purpose-specific JSONL decoder shared by Codex and Claude with an
explicit `push(chunk)` / `finish()` contract. `push` retains a bounded partial
line and emits complete JSON values in order. `finish` processes a valid final
record without a trailing newline, classifies an incomplete final record as
malformed, and deterministically discards buffered content. Malformed and
oversized records return bounded, content-free metadata only: diagnostic code,
byte count, record ordinal, and a non-content identifier. Raw stream records
must not enter lifecycle events, rendered output, or `RunError.raw`.

The decoder owns framing only. It must not interpret provider events, emit
lifecycle events, inspect stderr, or decide whether a run succeeded. Each
adapter owns its native event schema and converts only verified events to the
shared lifecycle contract.

Structured finalization also owns the successful terminal lifecycle event.
Add an explicit `adapter-finalized` terminal mode to `spawnAgentProcess`.
Transport failures—ownership, spawn, timeout, and nonzero exit—retain their
current precedence and emit one `failed` event in the shared spawn layer. After
a zero exit in adapter-finalized mode, the shared layer emits no terminal event:
the Codex or Claude adapter first calls parser `finish()`, validates the final
response and session identity, then emits exactly one `completed` or `failed`
event. A parser failure must never be preceded by `completed`.

### File impact

- `src/adapters/utils.ts` — thread the existing chunk callback through
  `spawnAgentProcess`, preserve UTF-8 boundaries, and add the explicit
  adapter-finalized terminal mode.
- `src/adapters/process-group.ts` — no ownership redesign; make only the narrow
  UTF-8/chunk parity correction if its existing path fails the shared boundary
  tests.
- `src/adapters/jsonl-decoder.ts` — own bounded incremental line framing and
  content-free decoding diagnostics.
- `tests/jsonl-decoder.test.ts`, `tests/adapters-lifecycle.test.ts`, and
  `tests/process-group.runtime.test.ts` — cover framing, terminal ordering, and
  ordinary/owned chunk parity.

### Verification

- One event split across arbitrary chunks is decoded once after completion.
- Multiple events in one chunk retain order.
- Blank lines, CRLF, a valid final record without a newline, and multibyte text
  split at native buffer boundaries are accepted.
- An incomplete final record and malformed or oversized records fail closed
  with bounded metadata; unique sensitive sentinels do not appear in
  lifecycle/run events, panel/plain output, or `RunError.raw`.
- Normal and owned subprocess paths deliver identical chunks without changing
  timeout, signal, or ownership behavior.
- A zero-exit malformed stream emits one `failed` lifecycle event and no
  `completed`; a valid stream emits exactly one `completed`.

## 3. Stream Codex telemetry without changing its final contract

### Design

Run every Codex invocation with `codex exec --json`, including
fresh-per-invocation tasks. Production Codex runs already pass `--json`:
`src/loops/binding-engine.ts` always resolves `continuity` and threads it into
`src/loops/execution.ts`, and `src/adapters/codex.ts:46` gates `--json` on
`!!input.continuity`, so every fresh and resumed production invocation already
emits `--json` and already returns parsed `assistantText` + `sessionId`. The
`--json`-always change therefore targets only the `continuity === undefined`
path (the bare spawn-contract probe and any direct `adapter.run()` without
continuity) and unifies finalization behind a single incremental parser; it
does not alter the production final-output contract. Refactor
`src/adapters/codex-json.ts` into one stateful parser used during execution and
at finalization so session ID and assistant output are never interpreted by
separate implementations.

Use only documented structured event types. Capture the exact
`thread.started.thread_id`; reconstruct final assistant output from completed
agent-message items as today; count each tool-bearing item once by stable item
identity; and emit concise activity categories such as command execution, file
change, or tool use. Do not display commands, tool input/output, reasoning,
assistant text, or unknown event payloads as progress.

Unknown event types are ignored for telemetry. Malformed framing, duplicate or
mismatched thread identity, or missing final assistant output retains the
existing fail-closed adapter error. Session strategy continues to decide
whether a captured session may be reused; enabling JSON output must not imply
resumption.

### File impact

- `src/adapters/codex.ts` — request JSONL for every binding kind and feed chunks
  to the parser; use adapter-finalized terminal lifecycle ownership and emit
  exactly one terminal event after successful process exit.
- `src/adapters/codex-json.ts` — own incremental Codex state, progress deltas,
  unique tool counting, session identity, and final response extraction.
- `tests/fixtures/` and `tests/codex-json.test.ts` — add captured, redacted Codex
  streams and chunk-boundary cases.
- `tests/adapters-args.test.ts` and adapter lifecycle tests — lock the invocation
  and lifecycle contracts. The codex non-continuity assertions (≈ lines 77-85)
  flip from `--json` absent (`expect(build.args.includes('--json')).toBe(false)`)
  to `--json` present (`toBe(true)`), mirroring the §4 Claude
  `--output-format stream-json` note.
- `tests/adapters-contract.test.ts` — the env-gated `CODEX_CONTRACT=1` codex
  "spawn contract" probe (≈ line 168) currently asserts
  `expect(lifecycleEvents.some(e => e.type === 'message')).toBe(false)`, which
  breaks once Codex streams progress via `message` events. Flip it to expect ≥1
  safe progress `message`; the spawn and continuity probes additionally assert
  session capture and ≥1 safe progress event per §6.

### Verification

- The `assistantText` reconstructed by the incremental finalization parser is
  byte-identical to the `assistantText` reconstructed for a resumed session — the
  refactor preserves `parseCodexJsonOutput`'s output
  (`src/adapters/codex-json.ts`). Separately, the on-disk artifact and
  `result.stdout` independently classify to the same verdict: they are distinct
  renderings (the artifact is the provider-written file; `result.stdout` is the
  assistant message) and are not byte-identical. Output-contract classification
  reads the on-disk file (`src/loops/binding-engine.ts:316`), and the existing
  `CODEX_CONTRACT=1` continuity probe asserts `parseVerdict` on the file and on
  `result.stdout` separately — both reaching the same verdict precisely because
  the two strings differ.
- The exact thread ID is captured, and a resumed-ID mismatch remains an error.
- A tool item repeated across started/updated/completed events increments the
  displayed count once.
- Text, reasoning, command contents, and tool payloads never appear in progress.
- Transport, timeout, nonzero-exit, interruption, and ownership outcomes remain
  unchanged.
- A zero-exit stream with malformed framing, duplicate thread identity, resumed
  identity mismatch, or missing final output emits `failed` and never emits
  `completed`; the failed in-flight state is observable before live-region
  detachment.

## 4. Prove and add Claude stream telemetry

### Design

Claude `structured` telemetry is a blocking release target, not a runtime
choice. Before changing adapter arguments or capability declarations, capture
and redact representative output from the installed Claude CLI for fresh and
resumed task, evaluate, and repair invocations. Record the tested CLI version,
commands, terminal/session/tool event shapes, redaction method, and accepted
result in `docs/dev/evidence/claude-stream-contract-v1.md`, and commit the
redacted native streams under `tests/fixtures/`. The installed CLI advertises
`--output-format stream-json`; use it only with the required non-interactive
flags proven by that evidence. Do not enable partial-message,
forwarded-subagent, hook, or debug events unless a fixture proves they are
needed for the minimal contract.

Replace the single-result parser with one Claude stream parser that captures
the exact session ID and final `result` response while translating verified
tool-use events into unique tool-call increments and safe activity categories.
Ignore thinking deltas, assistant prose, hook bodies, tool input/output,
subagent text, and unknown events. A resumed session must still match the
requested session ID.

If the evidence gate cannot prove stable final response, session identity, and
tool identity for every binding kind, stop Batch 4 as blocked and revise the
plan before implementation continues. Do not silently ship Claude as
`unavailable` or enable a partial binding-specific implementation under this
approved plan.

### File impact

- `src/adapters/claude.ts` — select the proven stream invocation uniformly
  across task, evaluate, and repair steps, declare the static `structured`
  capability, and own the terminal lifecycle event after parser finalization.
- Replace `src/adapters/claude-result.ts` with
  `src/adapters/claude-stream.ts` once the new parser covers both incremental
  telemetry and finalization; remove the superseded parser. The removed symbol is
  `parseClaudeResult`; its replacement is `parseClaudeStream`
  (`src/adapters/claude-stream.ts`), which must still surface the terminal
  `result` event so `sessionId` and `assistantText` remain available at
  finalization.
- Rename `tests/claude-result.test.ts` → `tests/claude-stream.test.ts`. The
  existing file exercises `parseClaudeResult` exclusively and is fully
  obsoleted by the parser swap. The renamed suite covers redacted native event
  shapes, fresh/resumed session identity, and every binding kind (`task`,
  `evaluate`, `repair`), plus chunk-boundary cases routed through the shared
  decoder.
- `tests/adapters-args.test.ts` — the Claude argument assertions flip from
  `--output-format json` to `--output-format stream-json`.
- `tests/adapters-contract.test.ts` — the env-gated `CLAUDE_CONTRACT=1` claude
  "spawn contract" probe (≈ line 251) currently asserts
  `expect(lifecycleEvents.some(e => e.type === 'message')).toBe(false)` against
  a single-object `json` result parsed by `parseClaudeResult`. Under the stream,
  flip it to expect ≥1 safe progress `message`, and move its result-schema
  assertions from the `parseClaudeResult` object onto the terminal `result` event
  exposed by `parseClaudeStream`. The spawn and continuity probes additionally
  assert session capture and ≥1 safe progress event per §6.
- `tests/fixtures/` — redacted native stream shapes per binding kind.
- `docs/dev/evidence/claude-stream-contract-v1.md` — accepted, version-recorded
  real-CLI evidence required before the static capability change.

### Verification

- Task and approval-loop runs preserve the exact final response and artifact
  behavior.
- Fresh and resumed runs capture the exact session ID; mismatch is fail-closed.
- Tool-use events count once even when repeated in multiple stream records.
- No partial assistant text, thinking, hook payload, subagent text, tool
  input/output, or debug content reaches the panel or event log.
- A failed or incomplete evidence gate blocks implementation before capability
  or argument changes are made.
- A zero-exit malformed stream, missing terminal result, or session mismatch
  emits `failed` and never emits `completed`; valid finalization emits one
  `completed`.

## 5. Preserve OpenCode and keep AGY capture logs private

### Design

Keep OpenCode's current JSON stream, completion signal, error classification,
session capture, final-text reconstruction, and tool-call behavior unchanged.
Its existing lifecycle messages continue through the shared sanitization and
rate-limiting policy. This is an explicit product decision for Batch 4:
OpenCode's existing assistant-text progress is retained, while Codex and Claude
must not introduce assistant prose as a new progress source. Unifying OpenCode
onto activity-only labels would change currently working behavior and is
separate future privacy-hardening scope.

Do not tail, parse, persist, or display AGY's private `--log-file` as live
telemetry. It remains restricted to session discovery and diagnostics and is
cleaned up under the existing lifecycle. AGY may move from `unavailable` only
in a later change backed by a stable native structured-output contract.

### File impact

- `src/adapters/opencode-stream.ts`, `src/adapters/opencode.ts` — no behavioral
  redesign; update only capability declarations or shared-seam integration
  required by this batch.
- `src/adapters/agy.ts` — declare telemetry unavailable; preserve capture-log
  handling.
- Existing OpenCode and AGY adapter tests — add non-regression assertions.

### Verification

- Existing OpenCode parser, completion, error, continuity, and progress tests
  pass unchanged.
- AGY capture-log contents cannot appear in lifecycle messages, run events,
  panel output, or retained artifacts.
- AGY auth detection, session discovery, cleanup, timeout, and interruption
  tests remain green.

## 6. End-to-end verification and documentation

### Design

Use deterministic fixtures as the release gate for framing, provider parsing,
privacy, lifecycle normalization, panel rendering, and tool-count semantics.
Add env-gated real-provider probes for Codex and Claude. Each probe must run
through the actual adapter and assert final output and session capture as well
as at least one safe progress event when the provider produces a known
structured activity.

Add one focused execution-level matrix using declarative fake adapters rather
than duplicating every provider test. It covers:

- structured capability with progress and unique tool calls;
- structured capability with no messages and zero tool calls;
- unavailable capability;
- zero-exit malformed structured finalization;
- nonzero exit; and
- one representative timeout or ownership failure proving transport precedence
  remains unchanged.

For each row, assert the declared capability on `provider.started`, the
in-flight panel state, plain event rendering, terminal lifecycle ordering,
bounded tool count, final `provider.completed` or `provider.failed` event, and
unchanged `RunResult`/artifact outcome. Existing timeout, interruption, and
ownership suites remain the exhaustive safety gates; do not create a
provider-by-terminal-path cross product.

Update operator documentation to describe progress as optional provider
telemetry, not workflow state or a watchdog. Document the capability matrix and
AGY's intentional unsupported state.

### File impact

- `tests/adapters-contract.test.ts` — the home of the env-gated real-provider
  Codex (`CODEX_CONTRACT=1`) and Claude (`CLAUDE_CONTRACT=1`) probes this section
  adds. The codex (≈ line 168) and claude (≈ line 251) "spawn contract" blocks
  both currently assert
  `expect(lifecycleEvents.some(e => e.type === 'message')).toBe(false)`, which
  holds only because today each emits `started`/`completed` alone. Once a
  structured provider streams progress via `message` lifecycle events, flip each
  to expect ≥1 safe progress `message`; keep the current shape for any provider
  left at `unavailable`. Extend the codex/claude spawn and continuity probes to
  assert session capture and ≥1 safe progress event per §6. The Claude probe
  additionally follows the `json` object → `stream-json` terminal `result` event
  transition from §4.
- `tests/adapters-lifecycle.test.ts`, `tests/loop-live.test.ts`,
  `tests/execution-panel.test.ts`, `tests/plain-render.test.ts`, and relevant
  adapter contract tests. The loop/panel suites own the focused execution matrix
  and verify failed structured finalization remains visible before live-region
  detachment.
- `AGENTS.md`, `README.md`, and `docs/architecture/overview.md`.

### Verification

Run:

```text
pnpm typecheck
pnpm test
pnpm build
```

Then run the existing env-gated Codex and Claude contract probes from an
authenticated shell. Manually start one invocation per real provider and
confirm:

- OpenCode, Codex, and Claude show their declared progress behavior and correct
  incremental tool counts;
- AGY clearly reports live progress unavailable;
- final artifacts and provenance classify exactly as before;
- resumed session identity remains correct; and
- timeout, interruption, ownership, and provider failure still terminate
  through their existing fail-closed paths.

## Non-goals

- Inferring activity from human-formatted stdout/stderr, elapsed silence,
  terminal escape sequences, debug logs, or provider reasoning.
- Tailing AGY capture logs or claiming parity without a stable native stream.
- Exposing commands, prompts, chain-of-thought, tool inputs/outputs, hook
  bodies, or subagent messages as progress, or using Codex/Claude assistant
  prose as a new progress source.
- Persisting live progress as workflow evidence or using it to reconstruct
  state after restart.
- Treating missing progress as a stall, failure, completion, or timeout.
- Changing provider success criteria, artifact contracts, pipeline transitions,
  model/effort selection, session policy, or watchdog configuration.
- Reimplementing the already-landed binding-aware pipeline state and lineage
  release, or bundling the independent `config/runners.yaml` changes.
