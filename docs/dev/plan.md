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
Claude gains one only if its real-CLI gate proves the full contract; and AGY is
explicitly reported as unsupported until its CLI exposes a stable structured
stream.

This release changes observability only. Telemetry must not affect artifact
content, output-contract classification, pipeline state, provider success,
timeouts, interruption, ownership, session continuity, or final response
parsing.

## 1. Make progress support an explicit adapter capability

### Design

Extend `AgentAdapter.capabilities` with a closed progress capability such as
`structured | unavailable`. OpenCode, Codex, and the deterministic fake adapter
declare `structured`; Claude declares it only after its real-CLI gate passes;
AGY declares `unavailable`.

Resolve this capability before attaching the live panel. Carry it through the
in-flight display model and the provider-started run event so both the rich
panel and plain event log describe support consistently. During an unsupported
AGY invocation, keep elapsed time and the spawn label visible and show a concise
`Live progress unavailable for this provider` state. Absence of messages from a
supported provider is simply “no activity received yet”; it is never a
completion or stall signal.

Keep `LifecycleEvent.message` as the provider-neutral delivery surface. New
provider integrations emit only structured, safe activity labels and
incremental tool-call counts; OpenCode retains its existing verified lifecycle
translation. Shared execution remains responsible for sanitization,
deduplication, length limits, event-rate limits, suppression accounting, and
the displayed cumulative count.

### File impact

- `src/adapters/types.ts` — define the progress capability on the adapter
  contract.
- `src/loops/execution.ts`, `src/status.ts`, `src/run-event.ts` — propagate the
  capability into live and plain output without branching on provider names.
- `src/status-panel.ts`, `src/plain-event-renderer.ts` — render the supported or
  unavailable state.
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

## 2. Add a bounded incremental JSONL transport seam

### Design

Thread the existing `onStdoutChunk` callback through `spawnAgentProcess` for
both the ordinary process runner and `OwnedSpawnRuntime`. Add one small,
purpose-specific JSONL decoder shared by Codex and Claude. It must retain a
partial trailing line between chunks, emit complete JSON values in order,
bound its pending buffer, and record malformed or oversized complete records
for final provider-specific validation.

The decoder owns framing only. It must not interpret provider events, emit
lifecycle events, inspect stderr, or decide whether a run succeeded. Each
adapter owns its native event schema and converts only verified events to the
shared lifecycle contract.

### File impact

- `src/adapters/utils.ts` and `src/adapters/process-group.ts` — preserve raw
  chunk delivery across both subprocess paths.
- `src/adapters/jsonl-decoder.ts` — own bounded incremental line framing and
  JSON decoding.
- Focused decoder tests — cover transport boundaries independently from any
  provider schema.

### Verification

- One event split across arbitrary chunks is decoded once after completion.
- Multiple events in one chunk retain order.
- Blank lines and CRLF are accepted.
- Malformed and oversized records remain bounded and become provider parser
  diagnostics rather than crashes or raw terminal output.
- Normal and owned subprocess paths deliver identical chunks without changing
  timeout, signal, or ownership behavior.

## 3. Stream Codex telemetry without changing its final contract

### Design

Run every Codex invocation with `codex exec --json`, including
fresh-per-invocation tasks. Refactor `src/adapters/codex-json.ts` into one
stateful parser used during execution and at finalization so session ID and
assistant output are never interpreted by separate implementations.

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
  to the parser.
- `src/adapters/codex-json.ts` — own incremental Codex state, progress deltas,
  unique tool counting, session identity, and final response extraction.
- `tests/fixtures/` and `tests/codex-json.test.ts` — add captured, redacted Codex
  streams and chunk-boundary cases.
- `tests/adapters-args.test.ts` and adapter lifecycle tests — lock the invocation
  and lifecycle contracts.

### Verification

- Fresh and resumed runs return the same exact final artifact body expected by
  output-contract validation.
- The exact thread ID is captured, and a resumed-ID mismatch remains an error.
- A tool item repeated across started/updated/completed events increments the
  displayed count once.
- Text, reasoning, command contents, and tool payloads never appear in progress.
- Transport, timeout, nonzero-exit, interruption, and ownership outcomes remain
  unchanged.

## 4. Prove and add Claude stream telemetry

### Design

First capture and redact representative output from the installed Claude CLI
for fresh and resumed task and approval-loop invocations. The installed CLI
advertises `--output-format stream-json`; use it only with the required
non-interactive flags proven by that probe. Do not enable partial-message,
forwarded-subagent, hook, or debug events unless a fixture proves they are
needed for the minimal contract.

Replace the single-result parser with one Claude stream parser that captures
the exact session ID and final `result` response while translating verified
tool-use events into unique tool-call increments and safe activity categories.
Ignore thinking deltas, assistant prose, hook bodies, tool input/output,
subagent text, and unknown events. A resumed session must still match the
requested session ID.

If the real CLI probe cannot prove stable final response, session identity, and
tool identity for every binding kind, keep Claude's capability
`unavailable` in this release rather than shipping partial or binding-specific
support.

### File impact

- `src/adapters/claude.ts` — select the proven stream invocation uniformly
  across task, evaluate, and repair steps.
- Replace `src/adapters/claude-result.ts` with
  `src/adapters/claude-stream.ts` once the new parser covers both incremental
  telemetry and finalization; remove the superseded parser.
- `tests/fixtures/`, parser tests, argument tests, and adapter lifecycle tests —
  cover redacted native event shapes, fresh/resumed identity, and every binding
  kind.

### Verification

- Task and approval-loop runs preserve the exact final response and artifact
  behavior.
- Fresh and resumed runs capture the exact session ID; mismatch is fail-closed.
- Tool-use events count once even when repeated in multiple stream records.
- No partial assistant text, thinking, hook payload, subagent text, tool
  input/output, or debug content reaches the panel or event log.
- Unsupported fallback is used if any required real-CLI contract remains
  unproven.

## 5. Preserve OpenCode and keep AGY capture logs private

### Design

Keep OpenCode's current JSON stream, completion signal, error classification,
session capture, final-text reconstruction, and tool-call behavior unchanged.
Its existing lifecycle messages continue through the shared sanitization and
rate-limiting policy.

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
Add env-gated real-provider probes for Codex and for Claude only if Claude is
declared structured. Each probe must run through the actual adapter and assert
final output and session capture as well as at least one safe progress event
when the provider produces a known structured activity.

Update operator documentation to describe progress as optional provider
telemetry, not workflow state or a watchdog. Document the capability matrix and
AGY's intentional unsupported state.

### File impact

- `tests/adapters-lifecycle.test.ts`, `tests/loop-live.test.ts`,
  `tests/execution-panel.test.ts`, `tests/plain-render.test.ts`, and relevant
  adapter contract tests.
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

- OpenCode, Codex, and any proven Claude implementation show bounded safe
  activity and correct incremental tool counts;
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
