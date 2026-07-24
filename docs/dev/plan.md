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

- live outside the target project;
- are not workflow artifacts;
- are never scanned by `isAgyAuthFailure`;
- are not returned wholesale in structured errors;
- are cleaned after all ordinary terminal results; and
- expose only bounded parsed diagnostics in debug output.

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
update.

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
contract script/test. It must run from a unique target directory and use a
separate decoy project containing a sentinel.

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

1. Run the authenticated target/decoy fresh-write gate.
2. Resume the captured session and run the second target-only write.
3. Verify project and conversation identity stability.
4. Verify provider-default and representative explicit effort mappings.
5. Run deterministic and focused regression suites.
6. Synchronize `AGENTS.md`, `README.md`, and
   `docs/architecture/overview.md`.
7. Archive a redacted manual verification record.

Release 3 is the first publishable boundary.

## Required test matrix

### Token and log parsing

- Fresh 1.1.6 log -> exact project/conversation pair.
- Resumed 1.1.6 log -> exact same pair.
- Token encode/decode round trip.
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
  timeout, and parser failure.

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

- Fresh `--new-project` binds the canonical target directory.
- The requested artifact/source mutation exists only in the target.
- A decoy sentinel and decoy worktree remain byte-for-byte unchanged.
- Returned token contains the project bound to the target.
- Resume uses the same project and conversation IDs.
- Resumed mutation again exists only in the target.
- Provider-default invocation omits effort and succeeds.
- Representative explicit effort invocations resolve to the intended variant.
- Invalid model/effort fails nonzero or before spawn and produces no artifact.

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

## Operator safety until release

Do not use the current AGY adapter for write-capable plan-follow-up,
review-follow-up, or implementation runs. Its `cwd`-only command does not
provide the explicit workspace binding proven necessary by research.

AGY may be exercised manually in isolated disposable projects for the contract
probes above. Do not treat successful stdout or a zero exit code as proof that
the intended repository was selected.
