# Plan — AGY 1.1.6 safe follow-up execution and continuity

## Status

**DRAFT — requires approval through the configured `plan` approval loop before
implementation.**

This plan implements `docs/dev/research.md`. It is deliberately limited to the
AGY provider contract and the generic catalogue/continuity seams AGY already
uses.

## Objective

Make AGY safe and useful for write-capable follow-up skills by:

- explicitly binding every fresh AGY invocation to the requested project;
- representing AGY 1.1.6 models and effort without folded display names;
- capturing a durable project/conversation token;
- resuming only the exact compatible AGY session selected by generic
  per-skill continuity; and
- preserving all existing auth, timeout, ownership, interruption, artifact,
  and supervisor safety behavior.

## Scope

- `config/providers/agy.yaml` model and effort catalogue;
- AGY adapter capabilities and command construction;
- AGY project/conversation token encoding;
- invocation-specific log capture and bounded parsing;
- fresh and resumed workspace binding;
- deterministic adapter, runner, continuity, and loop-level tests;
- an authenticated manual target/decoy write gate; and
- synchronized canonical documentation.

## Non-goals

- Do not add AGY-specific runner-selection UI.
- Do not discover or rewrite configuration from `agy models` at runtime.
- Do not use `--continue`, `last_conversations.json`, or AGY SQLite databases.
- Do not enable cross-skill, cross-chain, or second-opinion session inheritance.
- Do not migrate old artifacts whose AGY session ID is absent.
- Do not change provider timeout precedence, process ownership, signal handling,
  artifact quarantine, pipeline semantics, or supervisor compatibility.
- Do not add pipeline repair/adoption or decision-token correction.
- Do not generalize this work into a second provider execution engine.

## Normative decisions

### D1. Every fresh AGY invocation creates an explicitly bound project

Subprocess `cwd` remains the canonical target root supplied to the shared
process runner. In addition, every fresh AGY invocation includes
`--new-project`.

`--add-dir` is not workspace authority and must not be used as a substitute.

The invocation succeeds only after its capture log yields a unique project ID
and conversation ID. The authenticated release gate must prove that the
created AGY project resource is the canonical target root and that a decoy
workspace remains untouched.

The gate's correctness rests on the **strong binding property**, verified
directly and mechanism-independently: the returned project UUID resolves to the
target `file://` URI and the mutation exists only in the target. This holds
regardless of AGY's exact workspace-selection model. To make the adversarial
setup as strong as possible, the decoy is constructed as AGY's **most-recently
active project at the moment of the fresh target write** — the most plausible
state from which a binding gap could misroute a write — rather than an inert
sentinel directory AGY never knew about (which would make the sentinel
assertion vacuous). `docs/dev/research.md` established that `--new-project`
binds the invocation `cwd` and that `last_conversations.json` is
workspace-keyed; it did not establish that AGY performs cross-workspace
fallback, and the gate does not rely on that. The setup sequence is normative
for the gate and is specified in §D and Release 3.

### D2. Resumption uses an explicit project and conversation pair

Represent AGY continuity in the existing opaque `sessionId`:

```text
agy:v1:<project-uuid>:<conversation-uuid>
```

On a resumed invocation the adapter decodes the token and supplies both:

```text
--project <project-uuid>
--conversation <conversation-uuid>
```

It never supplies `--new-project` or `--continue` on that invocation.

After completion, the returned IDs must equal the requested pair. A malformed
input token, missing returned identity, ambiguous log, or mismatch fails
closed without fabricating a replacement session.

### D3. Generic continuity policy remains authoritative

Set AGY's adapter capability to `resumeSession: true` only when D1/D2 and their
tests land together.

Do not change `resolveContinuity`. It already requires:

- `resume-per-skill`;
- the same chain and skill;
- the same provider, model, and effort;
- a persisted non-empty session ID; and
- an adapter that declares resumption support.

Changing the AGY provider/model/effort starts a fresh AGY session while
preserving the artifact chain. Second opinions remain fresh.

### D4. Invocation logs are private capture channels

Each run receives a unique temporary path through AGY's supported
`--log-file` flag.

Add a purpose-specific `src/adapters/agy-session.ts` module that owns:

- strict versioned token encode/decode;
- bounded UUID parsing from fresh and resumed log shapes; and
- exact resumed-identity comparison.

`src/adapters/agy.ts` owns temporary-path lifecycle and invokes that parser.
Generic runtime modules continue to treat the result as an opaque session ID.

Temporary logs:

- live outside the target project (a unique OS temp directory);
- are not workflow artifacts;
- are never scanned by `isAgyAuthFailure`;
- are not returned wholesale in structured errors;
- are cleaned after every ordinary terminal result the adapter observes
  (success, auth failure, nonzero exit, timeout, and parser failure) via a
  `finally` block in `src/adapters/agy.ts` `run`;
- on interruption (SIGINT/SIGTERM), where the durable interrupt path
  (`handleInterruptSignal` → `terminateActiveChildren` → `process.exit` in
  `src/interrupted-artifact.ts`/`src/adapters/utils.ts`) can abandon the
  adapter `run` mid-await before its `finally` runs, the temp log may leak;
  this leak is **bounded** — it lives only under the OS temp dir under a unique
  harness-owned prefix, is never inside the target, is never a workflow
  artifact, is never auth-scanned, and is never returned in errors — and is
  reclaimed by the race-safe orphan-prefix sweep specified below; and
- expose only bounded parsed diagnostics in debug output.

This reconciles `docs/dev/research.md` ("remove after success, provider
failure, timeout, **or interruption where process ownership permits cleanup**"):
the `finally` covers every ownership-permitted terminal result, and the
orphan-prefix sweep reclaims the interruption case where process ownership does
not permit in-process cleanup.

#### Orphan-prefix sweep — race-safe reclamation (AGENTS.md §5 non-interference)

The sweep reclaims interruption-orphaned capture logs without regressing the
`AGENTS.md` §5 invariant that concurrent runs on different targets must not
interfere. It is implemented in `src/adapters/agy.ts` and runs once at the
start of `run`, **before** the new `--log-file` is allocated, so a run never
sweeps its own not-yet-created log. It is race-safe by construction:

- **Watchdog-conditional.** The sweep runs only when a finite AGY watchdog is
  configured (`timeouts.agy` > 0, surfaced to the adapter as `defaultTimeoutMs`;
  the AGY watchdog defaults to `0`/disabled per `AGENTS.md` §2). When the
  watchdog is disabled the sweep is a **no-op** and reclamation defers to
  OS-managed `/tmp` cleanup — the bounded leak is benign either way.
- **Staleness horizon.** "Stale" means `mtime` strictly older than
  `2 × timeouts.agy`. No live run can reach this age: a run is hard-bounded by
  watchdog `W`, so a still-open live log is at most ~`W` old and never reaches
  `2W`; the 2× margin absorbs watchdog-enforcement lag.
- **Never touches a newer file.** Files at or newer than the horizon — including
  the current run's not-yet-allocated log and any concurrent run's live log —
  are never removed.
- **Strictly prefix-scoped.** Only files matching the AGY-owned capture-log
  prefix (`agy-capture-*.log`) under the OS temp dir are considered; non-AGY
  temp files are never touched.

A deterministic test in `tests/adapters/agy.test.ts` proves the sweep skips a
just-created (simulated in-flight) harness-prefixed log and removes only one
whose `mtime` exceeds the horizon, and is a no-op when the watchdog is disabled.

Test seams must allow deterministic capture-log fixtures without reading or
writing the real AGY home directory.

### D5. Authentication detection remains stdout/stderr-only

Preserve the bounded existing `isAgyAuthFailure(stdout, stderr)` contract and
the loop-owned quarantine of partial output artifacts.

Do not add invocation-log text to the auth matcher. AGY can log transient
pre-auth failures before silent keyring authentication succeeds.

Existing spawn, timeout, nonzero-exit, ownership, or interruption errors retain
precedence over session parsing and auth fallback classification.

### D6. The configured model is logical; effort is independent

Replace the old display-name catalogue with:

```yaml
defaultModel: gemini-3.6-flash
models:
  - gemini-3.6-flash
  - gemini-3.5-flash
  - gemini-3.1-pro
  - claude-sonnet-4-6
  - claude-opus-4-6-thinking
  - gpt-oss-120b-medium
modelEfforts:
  gemini-3.6-flash: [low, medium, high]
  gemini-3.5-flash: [low, medium, high]
  gemini-3.1-pro: [low, high]
```

Set AGY's effort capability to true.

- Provider default means omit `--effort`.
- An explicit configured effort emits exactly one `--effort <level>`.
- Invalid or unconfigured model/effort pairs fail before spawn.
- Models without a configured effort list expose provider default only.
- The strict AGY allow-list remains exact after trimming.

Do not pass an effort-qualified Gemini model slug together with a separate
effort selection. AGY performs that mapping internally.

### D7. Safe failure is more important than continuity availability

A successful AGY response without a unique project/conversation capture is not
a valid harness completion. Return a structured provider/configuration error
and allow the binding engine's normal fail-closed artifact handling to stop the
step.

Do not fall back to `--continue`, the latest cache entry, another project ID,
or a session token from a different run.

## Target architecture

### A. AGY session contract module

Add `src/adapters/agy-session.ts` with pure contracts equivalent to:

```ts
type AgySessionIdentity = {
  projectId: string;
  conversationId: string;
};

encodeAgySession(identity): string
decodeAgySession(token): AgySessionIdentity
parseAgyInvocationLog(log): AgySessionIdentity
assertAgyResumedIdentity(expected, actual): void
```

Use a strict UUID grammar and a versioned prefix. Reject duplicate conflicting
IDs, partial pairs, unsupported token versions, extra fields, and arbitrary
provider text.

The parser supports only the bounded 1.1.6 lines verified in research. A future
AGY log-format change must fail closed and be handled as an adapter contract
update. Research verified those lines with a no-tools probe only; that evidence
is **not sufficient** proof of the parser against the full write-capable
command shape and flag combination, which must be re-verified by the named gate
in §D (acceptance gate 7).

### B. AGY adapter

Update `src/adapters/agy.ts` to:

1. declare effort and continuity capability;
2. construct fresh versus resumed project arguments;
3. emit explicit effort only when selected;
4. allocate and pass a unique temporary log path;
5. retain shared process execution and watchdog behavior;
6. preserve stdout/stderr auth detection;
7. parse the capture log only after the process has a successful terminal
   result;
8. return the encoded identity as `RunResult.sessionId`;
9. require exact identity equality on resume; and
10. clean temporary capture state on success and failure.

Keep project/session discovery, log parsing, and cleanup inside the AGY adapter
boundary. Do not add AGY branches to the binding engine.

### C. Catalogue and runner surfaces

Update the packaged AGY provider catalogue and all fixtures expecting the old
names. Reuse the existing generic:

- strict model validation;
- model-specific effort validation;
- provider-default effort option;
- agent-change model reset;
- runner summaries; and
- continuity compatibility check.

No AGY-only interactive prompt is added.

### D. Contract verification

Extend deterministic coverage and add an explicitly enabled authenticated AGY
contract script/test. It is the **only** permitted proof of the two
safety-critical real workflows — explicit workspace binding and durable
capture/resume — because the deterministic suites run against the
`processRunner`/log-fixture seams and therefore exercise harness logic only,
never the real AGY 1.1.6 CLI log shape or the real workspace-fallback risk.
Deterministic tests do not satisfy acceptance gates 1, 2, 4, or 11.

#### Adversarial decoy-as-active-workspace setup (acceptance gate 11)

The gate must be constructed so it cannot pass while the workspace-fallback
risk remains unverified. Use this exact sequence, with no change to the
operator's AGY home between steps:

1. **Make the decoy AGY's most-recently active project.** Run a real
   `agy -p <no-op probe> --new-project` with the decoy directory as subprocess
   `cwd` first (or an equivalent real `agy --new-project` invocation in the
   decoy). This populates AGY's active-project state and the
   `last_conversations.json` entry for the **decoy** workspace, constructing the
   most plausible state from which a binding gap could misroute a write.
   (Research did not establish AGY's exact cross-workspace fallback model and
   the gate does not rely on one — step 3 verifies the binding directly.) Seed a
   sentinel file in the decoy and record its bytes.
2. **Run the fresh target write via the orc-smash AGY adapter against the
   target directory**, *without* changing the operator's AGY home. The adapter
   supplies subprocess `cwd` = canonical target root plus `--new-project`,
   `--model`, optional `--effort`, `--log-file`, and
   `--dangerously-skip-permissions`.
3. **Assert, for the fresh invocation:**
   - the decoy sentinel is **byte-for-byte unchanged**;
   - the intended artifact/source mutation exists **only in the target** and is
     **absent from the decoy**; and
   - the returned token's project UUID resolves (per research evidence — AGY's
     persisted project resource is a `file://` URI and the log reports the same
     directory in `workspaceDirs`) to the **target** `file://` URI, **not the
     decoy**.
4. **Repeat 2–3 for the resumed invocation:** resume the captured session and
   run the second target-only write; assert the decoy sentinel is again
   byte-for-byte unchanged, the resumed mutation again exists only in the
   target, and the resumed token resolves to the same target project UUID.

An inert sentinel directory AGY never knew about makes the sentinel assertion
vacuous and does not satisfy this gate; the decoy must be AGY's most-recently
active project so the adversarial setup actually exercises a binding gap. The
gate's pass is ultimately determined by the mechanism-independent token→target
URI and target-only-mutation assertions in step 3, which hold regardless of
AGY's fallback model.

#### Write-capable capture-log and flag-combination re-verification
(acceptance gate 7; supports 1, 2, 4)

The two capture-log lines verified in research (`Backend project ID updated
dynamically to: <project-uuid>` and
`Print mode: conversation=<conversation-uuid>, sending message`) were proven
only with a `--model … --effort …` **no-tools probe**. The no-tools probe is
**not sufficient proof** for the parser. The gate must re-verify, against the
**exact final argv produced by `src/adapters/agy.ts` `buildRun`** (not a
hand-rolled probe), for both the full fresh command and the full resumed
command — each including `--log-file` and `--dangerously-skip-permissions`:

- the temporary `--log-file` contains exactly one valid project UUID and one
  valid conversation UUID on the two verified line shapes;
- `parseAgyInvocationLog` (in `src/adapters/agy-session.ts`) returns the
  expected identity from that log;
- AGY 1.1.6 accepts the complete flag combination for each shape (`--new-project`
  + `--log-file` + `--dangerously-skip-permissions` for fresh;
  `--project` + `--conversation` + `--log-file` + `--dangerously-skip-permissions`
  for resumed) — a nonzero exit or a missing/reshaped capture line fails this
  sub-gate and, under D7 fail-closed, would make AGY unusable for the
  write-capable follow-up, so it must be a named gate rather than an assumed
  inheritance from the probe; and
- `src/adapters/agy.ts` reads the log **only after** the process has a
  successful terminal result.

The test records only non-sensitive evidence: AGY version, configured model and
effort, target/decoy paths, returned token shape, expected artifacts, and
pass/fail results. It must not archive account identifiers, auth tokens, or raw
invocation logs.

## Implementation releases

The releases form one atomic AGY patch. Do not publish a state where the new
catalogue is active while workspace binding or session capture is partial.

### Release 1 — Pure session and catalogue contracts

1. Add `agy-session.ts` with token and log parsers.
2. Replace the AGY model catalogue with logical 1.1.6 slugs.
3. Add the verified per-model effort lists.
4. Update runner/config/interactive fixtures for strict AGY validation.
5. Add parser matrices for fresh, resumed, malformed, missing, duplicate, and
   mismatched identities.

Release 1 is not deployable by itself.

### Release 2 — Adapter workspace binding, effort, and continuity

1. Add `--new-project` to fresh AGY commands.
2. Add explicit `--project` plus `--conversation` to resumed commands.
3. Add `--effort` only for explicit choices.
4. Add unique temporary `--log-file` capture and cleanup.
5. Return the versioned composite `sessionId`.
6. Enable AGY effort and resume capabilities.
7. Preserve error precedence, auth detection, quarantine ownership, timeout,
   interruption, and process-group behavior.
8. Add adapter and loop-continuity tests through injected process/log seams.

Release 2 is not deployable until Release 3 gates pass.

### Release 3 — Safety gates and documentation

1. **Decoy-as-active-workspace setup.** Make the decoy AGY's active/most-recent
   project (real `agy --new-project` in the decoy, populating
   `last_conversations.json`/active-project state for the decoy) and seed the
   decoy sentinel.
2. **Authenticated target/decoy fresh-write gate.** Without changing the AGY
   home, run the fresh target write via the orc-smash AGY adapter; assert
   decoy sentinel byte-for-byte unchanged, mutation only in the target, and the
   returned project UUID resolves to the target `file://` URI (acceptance gate
   11, per the §D setup).
3. **Write-capable capture-log + flag-combo re-verification.** For the exact
   final fresh and resumed argv from `src/adapters/agy.ts` `buildRun`
   (including `--log-file` and `--dangerously-skip-permissions`), assert the
   temp log contains one valid project UUID and one conversation UUID on the
   two verified line shapes, `parseAgyInvocationLog` returns the expected
   identity, and AGY 1.1.6 accepts the full flag combination (acceptance gate
   7).
4. **Resumed target/decoy gate.** Resume the captured session and run the
   second target-only write; assert decoy sentinel unchanged, resumed mutation
   only in the target, and the same target project UUID (acceptance gate 11).
5. **Identity stability.** Verify the fresh and resumed project/conversation
   identity pair is stable and equal (acceptance gates 2, 4).
6. **Effort mapping.** Verify provider-default (no `--effort`) and a
   representative explicit effort invocation resolve to the intended variant
   for both fresh and resumed runs (acceptance gate 6; resumed effort
   re-emission per the command-construction matrix).
7. Run deterministic and focused regression suites (acceptance gate 12). These
   prove harness logic only and do **not** satisfy gates 1, 2, 4, or 11.
8. **Synchronize canonical docs** — `AGENTS.md`, `README.md`, and
   `docs/architecture/overview.md` — per the enumerated facts below.
9. **Archive a redacted manual verification record per gate** — one redacted
   evidence record for each real-workflow gate (1, 2, 4, 7, 11), not a single
   overall sign-off.

#### Release 3.8 — documentation facts that must flip

The doc sync is not implicit. The following operator-facing AGY facts change
with this patch and would otherwise contradict the runtime:

- `src/adapters/agy.ts:92` changes from `resumeSession: false, effort: false`
  to `resumeSession: true, effort: true`. Document this capability flip.
- AGY now binds the workspace explicitly via `--new-project`, not `cwd`-only.
  `AGENTS.md` §2 currently frames AGY workspace selection as `cwd`-only; update
  the §2 AGY bullets accordingly.
- The AGY session is now a composite opaque token
  (`agy:v1:<project-uuid>:<conversation-uuid>`), captured via a temporary
  `--log-file` and persisted as `RunResult.sessionId`. State this in the §2 AGY
  bullets and the relevant continuity text.
- A new purpose-specific `src/adapters/agy-session.ts` module exists; reference
  it alongside the §1a purposeful-module-boundary guidance.
- `AGENTS.md` §6's AGY verification bullet ("verified through deterministic
  seam coverage plus manual operator verification") must be extended to name the
  authenticated target/decoy binding gate and the write-capable capture-log
  re-verification as the manual sign-off for AGY.

Release 3 is the first publishable boundary.

## Required test matrix

### Token and log parsing

- Fresh 1.1.6 log -> exact project/conversation pair.
- Resumed 1.1.6 log -> exact same pair.
- Token encode/decode round trip.
- Composite token survives a full provenance round trip:
  `encodeAgySession` → `writeArtifactWithMeta` (YAML `sessionId` carrying
  colons) → `scanGlobalSnapshot` read → `decodeAgySession` yields the original
  pair unchanged, proving the colon-bearing `agy:v1:<uuid>:<uuid>` token is not
  corrupted by serialization (guards `src/provenance.ts` string-field handling).
- Wrong prefix/version -> reject.
- Invalid UUID -> reject.
- Missing project or conversation -> reject.
- Conflicting duplicate IDs -> reject.
- Repeated identical diagnostic lines -> deterministic single identity.
- Expected/actual resume mismatch -> reject.
- Transient auth-looking log lines do not affect session parsing.

### Command construction

- Fresh -> `--new-project`, no `--project`, no `--conversation`.
- Resumed -> `--project` and `--conversation`, no `--new-project`, no
  `--continue`.
- Every invocation -> one unique `--log-file`.
- Provider-default effort -> no `--effort`.
- Explicit effort -> exactly one correct flag.
- Resumed run whose persisted effort was explicit re-emits exactly one
  `--effort <level>` matching the persisted value (enforced as equal by
  `resolveContinuity` in `src/loops/binding-engine.ts` before resume); a resumed
  run whose persisted effort was provider default omits `--effort`. Both via
  `src/adapters/agy.ts` `buildRun`.
- No AGY CLI timeout flag; the harness watchdog remains authoritative.
- Autonomy flag remains present for write-capable headless use.

### Adapter results and cleanup

- Successful fresh result returns encoded session identity.
- Successful resumed result returns the same encoded identity.
- Missing/ambiguous capture -> structured failure, no session ID.
- Malformed supplied token -> no spawn.
- Resume mismatch -> structured failure.
- Process error retains precedence.
- Auth error retains existing classification and loop-owned artifact
  quarantine.
- Success logs containing benign or transient auth prose are not classified
  from the capture log.
- Temporary capture paths are cleaned on success, auth failure, nonzero exit,
  timeout, and parser failure (adapter `run` `finally`).
- Simulated interruption (signal seam) that abandons the adapter `run` before
  its `finally` leaves at most one bounded orphan under the OS temp dir, never
  inside the target, never an artifact; the race-safe orphan-prefix sweep
  removes it only once its `mtime` exceeds `2 × timeouts.agy`, never touches a
  newer file (so a concurrent run's live log is untouched), and is a no-op when
  the watchdog is disabled.

### Catalogue and runner behavior

- Default AGY model is `gemini-3.6-flash`.
- Exact configured base slugs are accepted.
- Old display names and cross-provider IDs are rejected.
- Gemini effort choices match the configured matrix.
- Non-Gemini models expose provider default only.
- Changing model clears an incompatible effort.
- Changing provider/model/effort prevents session resume.
- Compatible same-skill/same-chain metadata resumes AGY.
- Second opinion and fresh-per-invocation policy remain fresh.

### Isolated authenticated contract

- The decoy is AGY's most-recently active project at the moment of the fresh
  target write (real `agy --new-project` run in the decoy first), exercising the
  most plausible misroute state. The binding is verified directly and
  mechanism-independently by the token→target URI assertion below, so the gate
  does not depend on AGY having a cross-workspace fallback.
- Fresh `--new-project` binds the canonical target directory.
- The requested artifact/source mutation exists only in the target and is
  absent from the decoy.
- The decoy sentinel and decoy worktree remain byte-for-byte unchanged after
  both the fresh and the resumed invocation.
- The returned token's project UUID resolves (AGY project resource / log
  `workspaceDirs`) to the target `file://` URI, not the decoy, for both fresh
  and resumed invocations.
- The exact final fresh and resumed argv from `buildRun` each produce a temp
  capture log with exactly one valid project UUID and one valid conversation
  UUID on the two verified line shapes, and `parseAgyInvocationLog` returns the
  expected identity.
- Resume uses the same project and conversation IDs.
- Resumed mutation again exists only in the target.
- Provider-default invocation omits effort and succeeds.
- Representative explicit effort invocations resolve to the intended variant.
- Invalid model/effort fails before spawn (runner resolution in
  `src/runner.ts` `validateAgentAndModel`/`resolveEffort`, plus
  `isValidModelForAgent`/`isValidEffortForModel`), with no process started and
  no artifact produced — it is never a nonzero `agy` exit, so tests must assert a
  thrown resolution error, not a spawned exit code.

## Existing tests requiring updates

- `tests/adapters/agy.test.ts`
- `tests/adapters-args.test.ts`
- `tests/adapters/registry.test.ts`
- `tests/adapters/registry-timeout-integration.test.ts`
- `tests/agy-contract.test.ts`
- `tests/config.test.ts`
- `tests/runner.test.ts`
- `tests/interactive.test.ts`
- `tests/loop-continuity.test.ts`
- fixtures/status expectations containing old AGY display names

Add focused tests for `agy-session.ts` and the authenticated manual contract
without folding provider-specific cases into generic helper files.

## Verification commands

At minimum:

```text
pnpm typecheck
pnpm build
pnpm test
pnpm test tests/adapters/agy.test.ts
pnpm test tests/adapters-args.test.ts
pnpm test tests/agy-contract.test.ts
pnpm test tests/loop-continuity.test.ts
pnpm test tests/runner.test.ts
pnpm test tests/config.test.ts
pnpm test tests/interactive.test.ts
```

Run the authenticated AGY gate only from an already-authenticated operator
shell using its explicit environment switch. The implementation must define
the exact command and archive a redacted result before release.

## Acceptance gates

1. Every fresh AGY invocation uses `--new-project` with canonical target `cwd`.
2. Every resumed invocation uses the exact captured project and conversation;
   `--continue` is absent everywhere.
3. AGY returns a versioned composite session token and generic provenance
   persists it without schema changes.
4. Same-chain, same-skill, same-provider/model/effort continuation resumes;
   incompatible choices remain fresh.
5. The 1.1.6 logical model and effort catalogue is exact and strictly
   validated before spawn.
6. Provider default omits `--effort`; explicit effort emits one verified flag.
7. Capture logs are unique, temporary, cleaned, excluded from auth scanning,
   and never surfaced wholesale.
8. Missing, malformed, ambiguous, or mismatched session evidence fails closed.
9. Existing AGY auth-failure detection and loop-owned partial-artifact
   quarantine remain intact.
10. Timeout, interruption, ownership, signal, and supervisor contracts are
    unchanged.
11. The authenticated target/decoy gate proves fresh and resumed writes cannot
    use an old workspace.
12. Typecheck, build, deterministic tests, focused regressions, and canonical
    documentation synchronization pass before release.

## Real Workflow Verification Matrix

The real-workflow acceptance gates that depend on the real AGY CLI — 1, 2, 4,
and 11 — cannot be satisfied by deterministic tests alone: those suites run
against the `processRunner`/log-fixture seams and prove harness logic only, so
they cannot detect a real CLI log-shape change or a real workspace-fallback
regression. Each is proven by the authenticated manual gate and requires its
own redacted archived record (Release 3.9), not a single overall sign-off.
Gates 3 and 7 are split: each has a deterministic clause (proven by seam tests)
and a real-CLI clause (proven by the manual gate), shown in the table.

| Gate | Real-workflow claim | Authenticated-gate step that proves it | Redacted evidence archived |
| --- | --- | --- | --- |
| 1 | Fresh uses `--new-project` + canonical target `cwd`; write lands only in the target | Release 3.2 (decoy-as-active-workspace fresh-write gate) | fresh target/decoy paths, sentinel hash, target-only mutation, token→target `file://` URI |
| 2 | Resumed uses the exact captured pair; `--continue` absent; same identity returned | Release 3.4 + 3.5 (resumed gate + identity stability) | resumed target-only mutation, returned vs supplied project/conversation UUID equality |
| 3 | AGY returns a versioned composite token **and** provenance persists it without schema change | token-production: Release 3.3; persistence-without-schema-change: deterministic round-trip test | capture-log → `parseAgyInvocationLog` → `encodeAgySession` → `RunResult.sessionId` (Release 3.3); YAML round-trip equality (deterministic) |
| 4 | Same-chain resume; incompatible provider/model/effort stays fresh | Release 3.4 + 3.5 (resumed gate + identity stability) | resumed token equality; incompatible-config-fresh evidence from deterministic suite is supporting only |
| 7 | Capture logs unique/temporary/cleaned/excluded-from-auth-scan **and** real CLI log shape + flag combination accepted | cleanup/exclusion: deterministic seam tests ("Adapter results and cleanup"); log-shape + flag combo: Release 3.3 | seam cleanup matrix; Release 3.3 redacted capture-log identity |
| 11 | Fresh + resumed writes cannot use an old (decoy) workspace | Release 3.1–3.4 (decoy active first; fresh + resumed target-only writes) | decoy-as-active-workspace setup record, decoy sentinel byte-for-byte hash pre/post, target-only mutation, token→target resolution |

For gate 7, only the capture-log-shape + flag-combination sub-part requires the
manual gate (Release 3.3); the uniqueness/temporary/cleaned/excluded-from-auth-scan
properties remain deterministic (seam tests in "Adapter results and cleanup").
Likewise for gate 3, only the token-production clause requires the manual gate;
the provenance-persists-without-schema-change clause is deterministic.

## Operator safety until release

Do not use the current AGY adapter for write-capable plan-follow-up,
review-follow-up, or implementation runs. Its `cwd`-only command does not
provide the explicit workspace binding proven necessary by research.

AGY may be exercised manually in isolated disposable projects for the contract
probes above. Do not treat successful stdout or a zero exit code as proof that
the intended repository was selected.
