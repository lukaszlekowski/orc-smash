# Research — AGY 1.1.6 workspace, model, effort, and continuity patch

## Status

Research is complete enough to plan the patch. One authenticated write-fixture
gate remains deliberately part of the implementation plan because it must
exercise the finished adapter command and capture path.

This document supersedes the exploratory notes in
`docs/dev/archived/agy-model-effort-migration.md`. That file remains useful
historical evidence for the 1.1.5 interface change.

## Research question

How can orc-smash safely use AGY for write-capable follow-up skills while:

- binding every invocation to the requested project rather than AGY's
  previously active workspace;
- representing the current AGY model and effort interface accurately;
- capturing and resuming an AGY conversation without shell-history inference;
- preserving the existing timeout, ownership, auth-failure, and artifact
  quarantine boundaries; and
- avoiding a provider-specific execution engine outside the AGY adapter?

## Executive conclusion

The installed AGY CLI is version `1.1.6`. It has the provider primitives needed
for a safe adapter:

- `--new-project` creates a project bound to the invocation workspace;
- `--project <project-id>` selects an explicit existing project;
- `--conversation <conversation-id>` resumes an explicit conversation;
- `--model` accepts stable model slugs;
- `--effort` selects `low`, `medium`, or `high`; and
- `--log-file <path>` sends invocation diagnostics to a caller-owned path.

A live isolated probe established that AGY stores a durable project ID and
conversation ID and can resume their exact pair. Normal headless stdout contains
only the assistant response, however, so the current adapter cannot capture the
IDs from its existing process result.

The patch should use a unique temporary `--log-file` for each invocation,
extract the project and conversation IDs with a bounded parser, encode them into
the existing opaque `RunResult.sessionId`, and delete the temporary log after
parsing. Fresh invocations use `--new-project`; resumed invocations use both
`--project` and `--conversation`. The adapter must never use `--continue`.

## Current implementation

`src/adapters/agy.ts` currently:

- declares `resumeSession: false` and `effort: false`;
- invokes `agy -p <prompt> --model <model>
  --dangerously-skip-permissions`;
- relies only on subprocess `cwd` for workspace selection;
- returns no session ID; and
- performs bounded auth-failure detection over stdout and stderr.

`config/providers/agy.yaml` still uses pre-1.1.5 human-readable names such as
`Gemini 3.5 Flash (Medium)`. It has no `modelEfforts` catalogue.

The generic runtime already provides the required upper-level continuity
contract:

- `RunInput.continuity` distinguishes fresh from resumed invocations;
- `RunResult.sessionId` is an opaque provider session string;
- provenance persists the session string;
- `resolveContinuity` requires the same chain, skill, provider, model, effort,
  session strategy, and adapter capability before resuming; and
- changing provider/model/effort starts a fresh provider session without
  changing artifact-chain identity.

No generic continuity schema change is required.

## Live evidence — 24 July 2026

### Installed CLI and catalogue

The installed command reports:

```text
agy --version
1.1.6
```

`agy models` reports:

```text
gemini-3.6-flash-high
gemini-3.6-flash-medium
gemini-3.6-flash-low
gemini-3.5-flash-high
gemini-3.5-flash-medium
gemini-3.5-flash-low
gemini-3.1-pro-high
gemini-3.1-pro-low
claude-sonnet-4-6
claude-opus-4-6-thinking
gpt-oss-120b-medium
```

The help surface includes:

```text
--continue
--conversation
--effort
--model
--new-project
--project
--log-file
```

The 1.1.6 changelog does not replace the model/effort interface introduced in
1.1.5.

### Model and effort representation

An authenticated no-tools probe used:

```text
--model gemini-3.6-flash --effort low
```

The invocation succeeded. AGY's log resolved this pair to
`gemini-3.6-flash-low` and selected `Gemini 3.6 Flash (Low)`.

Therefore the harness should expose Gemini base slugs as logical models and
their verified levels as `modelEfforts`. It should not make operators select an
effort-qualified Gemini slug and then separately select effort.

The safe initial catalogue is:

| Logical configured model | Explicit effort choices |
| --- | --- |
| `gemini-3.6-flash` | `low`, `medium`, `high` |
| `gemini-3.5-flash` | `low`, `medium`, `high` |
| `gemini-3.1-pro` | `low`, `high` |
| `claude-sonnet-4-6` | none proven |
| `claude-opus-4-6-thinking` | none proven |
| `gpt-oss-120b-medium` | none proven |

Provider default remains selectable for every model and means that orc-smash
omits `--effort`. No unverified effort choices should be advertised for the
last three entries.

Representative authenticated probes for each distinct mapping shape remain a
release gate. They are catalogue verification, not runtime discovery.

### Explicit workspace binding

From an isolated directory, `--new-project` created an AGY project whose
persisted project resource was exactly:

```text
file:///private/tmp/orc-agy-session-probe-20260724
```

The invocation log also reported the same directory in `workspaceDirs`.

This proves the CLI can create an explicit project for the supplied `cwd`. It
does not by itself prove that a write-capable agent cannot touch a previously
active workspace. The finished adapter must pass the isolated target/decoy
write gate in `docs/dev/plan.md`.

### Durable conversation identity

The same isolated invocation created:

- one project UUID;
- one conversation UUID;
- a conversation SQLite database; and
- a workspace-keyed entry in AGY's `last_conversations.json`.

Normal print-mode output was only:

```text
SESSION_PROBE_OK
```

The explicit log contained bounded lines identifying:

```text
Backend project ID updated dynamically to: <project-uuid>
Print mode: conversation=<conversation-uuid>, sending message
```

Resuming with:

```text
--project <project-uuid>
--conversation <conversation-uuid>
```

succeeded and the resumed log reported the same two IDs. This proves that the
pair is a working continuity token.

## Target continuity contract

Keep AGY's provider-specific composite inside the existing opaque session
string:

```text
agy:v1:<project-uuid>:<conversation-uuid>
```

The exact encoding and parser belong in a purpose-specific AGY session module.
Generic provenance, runner resolution, and status surfaces continue to treat it
as an opaque `sessionId`.

Fresh invocation:

```text
agy -p <prompt>
  --model <logical-model>
  [--effort <level>]
  --new-project
  --log-file <unique-temporary-path>
  --dangerously-skip-permissions
```

Resumed invocation:

```text
agy -p <prompt>
  --model <same-logical-model>
  [--effort <same-level>]
  --project <project-uuid>
  --conversation <conversation-uuid>
  --log-file <unique-temporary-path>
  --dangerously-skip-permissions
```

The generic continuity resolver already prevents resumption after a
provider/model/effort mismatch.

## Why not use other AGY state

### Do not use `--continue`

`--continue` means the provider's globally most recent conversation. It is
shell/provider-history inference, can cross projects, and violates explicit
per-skill continuity.

### Do not read `last_conversations.json` at runtime

The file proved that AGY persists conversations, but it is global mutable
provider state. Reading it after a run creates races across targets and couples
orc-smash to an internal cache layout.

### Do not read AGY SQLite databases

The databases are an internal storage format. orc-smash needs only the IDs
printed into its invocation-specific log.

### Do not accept `--add-dir` as binding

`--add-dir` expands access; it does not replace the active workspace. It cannot
prove that AGY writes to the intended project.

## Log parsing and security boundary

The parser should accept exactly one valid project UUID and one valid
conversation UUID attributable to the completed invocation. Missing,
malformed, ambiguous, or mismatched IDs fail closed.

The temporary log is a session-capture channel only:

- create it under a unique OS temporary directory;
- never place it in the target repository;
- never include it in auth-failure phrase scanning;
- never copy its full content into a `RunError`;
- remove it after success, provider failure, timeout, or interruption where
  process ownership permits cleanup; and
- keep debug reporting to bounded parsed facts.

This separation is important. A successful AGY startup log can contain
transient text saying the process is not logged in before silent keyring
authentication succeeds. Feeding the log into `isAgyAuthFailure` would turn a
successful authenticated run into a false auth failure.

The existing stdout/stderr auth matcher and loop-owned partial-artifact
quarantine remain authoritative.

## Failure semantics

- Invalid configured model/effort: reject before spawn.
- Fresh run without a unique project/conversation pair: structured fail-closed
  adapter error; do not persist a successful workflow artifact.
- Resumed run whose returned IDs do not equal the supplied token: structured
  fail-closed adapter error.
- Malformed stored AGY token: do not invoke `agy`.
- Provider auth failure: retain existing `error.kind === 'auth'` behavior and
  loop-owned artifact quarantine.
- Timeout/interruption/ownership loss: retain existing shared process and
  supervisor behavior; no fallback session inference.
- Missing required output: retain the binding engine's existing
  `missing_output` failure.

## Architectural boundary

Add at most one purpose-specific module, for example
`src/adapters/agy-session.ts`, owning:

- composite token encoding/decoding;
- bounded invocation-log parsing; and
- equality checks for resumed identity.

`src/adapters/agy.ts` owns AGY argument construction, temporary capture-file
lifecycle, and result post-processing. Generic runner, provenance, loop,
ownership, and pipeline modules should not branch on AGY.

## Verification implications

Deterministic tests can prove command construction, token parsing, continuity,
effort, log cleanup, mismatch behavior, auth separation, and registry
validation.

AGY's browser/keyring authentication remains unsuitable for a normal automated
CI gate. Release sign-off therefore requires a manually enabled,
already-authenticated isolated contract test that proves:

1. a fresh write lands only in the target workspace;
2. a decoy/previous workspace is unchanged;
3. the returned composite session token is persisted;
4. a resumed invocation uses the same project and conversation;
5. the resumed write again lands only in the target; and
6. provider-default and explicit effort invocations select the intended model.

## Out of scope

- Runtime catalogue discovery or mutation from `agy models`.
- AGY-only runner menus.
- Cross-skill or cross-chain session reuse.
- Automatic migration of old AGY artifacts whose session is `none`.
- Importing AGY conversation contents.
- Changing generic pipeline, approval-loop, timeout, ownership, signal, or
  artifact-quarantine semantics.
- Pipeline repair/adoption, qualified-verdict correction, or runner
  recommendation UX.
