---
status: ready-for-audit
confidence: 0.98
owners: harness-runtime
platform: macos-primary
---

# Crash-Safe Owned Runs with Portable Process Groups

## Decision and delivery boundary

This document is the sole design authority for owned-run behavior in `orc-smash`.
The supported cleanup mechanism is portable POSIX process-group signalling with
strict parent-side authorization. macOS is the mandatory release platform;
Linux uses the same product contract and may use stronger process-identity
evidence behind the same adapter seam.

The harness remains a stateless subprocess CLI. It does not become a daemon,
host application, model client, or independent supervisor. Ordinary terminal
runs are unchanged. Owned mode is opt-in and active only when a caller supplies
a complete short-lived ownership lease.

The guarantee is deliberately bounded:

- While the CLI is alive, it prevents work after lease loss, fences completed
  output, quarantines raw artifacts, and terminates a provider group represented
  by a continuously owned runtime handle.
- After a CLI crash, durable records support diagnosis and admission blocking,
  but never authorize an unattended macOS group signal. Ambiguous stale state
  requires operator recovery.
- Descendants that deliberately create another session or process group are not
  guaranteed to be discovered or terminated. Errors, documentation, and status
  output must not imply otherwise.
- Independent cleanup after both the host and CLI die belongs to the separately
  planned supervisor and is not claimed here.

## 1. Launch modes and ownership records

### Design

There are exactly three launch outcomes:

1. Terminal mode: neither `ORC_RUN_ID` nor `ORC_RUN_TOKEN` is present.
2. Owned mode: both selectors are present and valid.
3. Invalid mode: only one selector is present, a selector is malformed, or any
   obsolete ownership selector is present. Invalid mode exits before artifact
   scanning, admission writes, or provider spawn.

`src/run-ownership.ts` remains the single authority for operational ownership
state. Records live outside the target project beneath
`${ORC_RUN_STATE_DIR ?? os.tmpdir()}/orc-smash/`:

```
projects/<sha256(realpath(projectRoot))>/
  project.lock
  project.json
runs/<runId>/
  control.json
  active.json
```

Directories are mode `0700`; files are `0600`. Every read validates type,
ownership, permissions, schema, and immutable identity. Atomic updates use an
exclusive temporary file, file fsync, rename, and parent-directory fsync.
Malformed or ambiguous state fails closed and is never treated as absent.

`control.json` is written only by the lease issuer and contains schema version,
run ID, owner-token hash, canonical project root, host instance identity, lease
tuple, and issuer revision. The plaintext token is never persisted.
`active.json` is written only by the CLI and contains CLI identity, lifecycle,
registered provider-group identities, terminal reason, and CLI revision.

One owned run per canonical project is enforced by exclusive project admission.
A live holder rejects another run. A verified-dead holder enters reconciliation;
admission is reclaimed only when no registered group remains and no ambiguous
ownership state exists.

The owned child environment is constructed once by copying the caller
environment and removing `ORC_RUN_ID`, `ORC_RUN_TOKEN`, and
`ORC_RUN_STATE_DIR`. Every adapter and bootstrap process receives that exact
environment. Unrelated variables remain unchanged. Terminal mode retains normal
environment inheritance.

### File impact

- Update `src/commands/ownership-launch.ts` to implement the exhaustive mode
  table and reject obsolete selectors before admission.
- Update `src/run-ownership.ts` schemas and path resolvers so records contain
  only portable process identity and lifecycle fields.
- Keep ownership propagation through `src/commands/smash.ts`,
  `src/loops/execution.ts`, and all four adapter inputs.
- Update `src/adapters/errors.ts` with stable admission, stale-recovery, and
  process-identity remediation text.

### Verification

- Table-test neither/both/only-one selector, malformed values, obsolete
  selectors, and unrelated environment variables.
- Assert invalid mode performs no scan, lock write, active write, or spawn.
- Capture every adapter/bootstrap environment and prove ownership selectors are
  absent while terminal inheritance is unchanged.
- Test canonical/symlinked project contention, permissions, malformed records,
  immutable-field drift, concurrent writers, and atomic-write failures.

## 2. Process-group bootstrap and continuous runtime authority

### Design

`ProcessGroupRuntime` owns provider-group creation. It spawns a packaged Node
bootstrap with `detached: true`, making that bootstrap the leader of a new
session and process group. The bootstrap remains the group leader for the
provider lifetime; it launches the provider with the exact requested argv,
environment, cwd, and stdio contract, forwards termination signals, waits for
the provider, and mirrors its exit result.

The bootstrap protocol is bounded and ordered:

1. Before provider spawn, report one versioned readiness frame over the private
   child-to-parent channel containing bootstrap PID, PGID, session ID, start
   evidence, and expected provider executable/argv fingerprint.
2. The parent independently resolves the spawned bootstrap identity and requires
   `leaderPid === pgid === sessionId === child.pid`. It also proves the group and
   session differ from the CLI and every resolved ancestor group.
3. The parent writes a provisional group record durably to `active.json`.
4. Only then send ACK. EOF, malformed readiness, identity mismatch, parent death,
   or timeout before ACK makes the bootstrap exit without spawning the provider.
5. After ACK, the bootstrap spawns the exact provider argv in its inherited
   group and reports a bounded provider-started frame. The parent independently
   verifies the provider PID belongs to the recorded PGID/session before
   resolving the adapter's `ready` promise.
6. Provider-start mismatch, early exit, ambiguity, or timeout terminates the
   continuously owned fresh group, records ownership failure, and rejects
   `ready`.

No human-readable command display string is kill authority. Persist typed fields:
leader PID, PGID, session ID, leader start evidence, bootstrap executable path,
expected provider executable path, and argv fingerprint where the platform can
obtain it without lossy parsing.

The live runtime handle is a capability held only by the CLI process that
created the group. It includes the actual `ChildProcess` object, the independently
verified identity, and an unbroken ownership epoch. Reconstructing the same
numbers from `active.json` does not recreate fresh authority.

### File impact

- Replace `src/adapters/process-group-wrapper.sh` with a packaged Node bootstrap,
  for example `src/adapters/process-group-bootstrap.mjs`.
- Update `src/adapters/process-group.ts` with bounded framing, independent
  identity checks, durable pre-ACK registration, provider-start verification,
  fresh-handle tracking, and checked retirement.
- Update packaging so the bootstrap ships with the CLI.
- Update `src/process-identity.ts` with typed macOS/Linux identity results and
  explicit `verified | gone | ambiguous` outcomes.

### Verification

- Test exact provider argv, spaces in executable paths/arguments, cwd, environment,
  stdio, exit code, and signal forwarding.
- Inject forged self/ancestor PGID/session values and prove no negative signal,
  provider spawn, or readiness occurs.
- Cover malformed/extra/partial frames, EOF, parent death, registration-write
  failure, ACK failure, provider-start mismatch, ambiguity, timeout, and early
  exit. Every pre-ACK case proves the provider never starts.
- Run a real macOS provider plus cooperative child and independently verify both
  remain in the bootstrap-owned group.

## 3. Single negative-signal gate

### Design

Every negative-PID signal in production routes through `src/kill-gate.ts`. No
other module may call `process.kill()` with a negative target. A repository scan
test enforces this boundary.

The gate accepts a discriminated authority:

- `fresh`: the continuously owned runtime capability created in the current CLI.
- `durable`: identity reconstructed from operational records after continuity
  was lost.

All signals first reject PGID values `<= 1`, the CLI PID, CLI group/session, and
every resolvable ancestor group/session. Failure to resolve the forbidden set
rejects every terminating signal.

Fresh authority may signal only when the current bootstrap identity still
matches the verified handle's leader PID, PGID, session ID, and start evidence.
The gate never falls back from a verified identity to partial evidence. After a
successful `SIGTERM`, the same live capability may check whether the group still
exists and escalate to `SIGKILL` after grace. The handle is retired only after
the direct bootstrap closes and the group no longer exists. If a cooperative
child outlives its provider, the still-live bootstrap remains leader and owns
its cleanup before exiting.

Durable authority never sends an unattended group signal on macOS. Second-level
start time, executable display text, matching PID/PGID/session, or “medium”
confidence is insufficient to rule out reuse. Durable ambiguity records a
terminal ownership failure, retains group records and project admission, and
directs operator recovery. Linux may authorize durable cleanup only when its
typed identity resolver supplies collision-resistant incarnation evidence and
all persisted fields match exactly; otherwise it follows the same refusal path.

Signal results are explicit: `sent`, `already-gone`, or `rejected`. Callers may
clear a group record only after `sent/already-gone` plus verified group absence.
A rejected or unverifiable result must never be ignored, converted to success,
or followed by admission release.

### File impact

- Refactor `src/kill-gate.ts` so authority type changes behavior rather than logs.
  Remove authorization from `ambiguous.partial` evidence and remove terminating
  “medium confidence” outcomes.
- Update `src/adapters/process-group.ts` to pass only fresh capabilities during
  live runtime cleanup.
- Update `src/run-ownership.ts` reconciliation/finalization and
  `src/interrupted-artifact.ts` ownership-loss cleanup to preserve records and
  admission on every rejected result.
- Update `src/adapters/utils.ts` so active-child termination delegates to the
  same authorized group runtime when owned mode is active.

### Verification

- Assert fresh full identity can send TERM/KILL while fresh partial identity
  cannot.
- Assert every macOS durable case—full-looking, partial, leader-gone, same
  command/near start time, PID reuse, PGID reuse, malformed output—sends no
  negative signal and retains admission.
- Inject the real test-runner/terminal PGID and ancestor PGIDs across live,
  ownership-loss, finalization, and reconciliation paths; assert the signal seam
  records no negative target and the runner survives.
- Assert callers never clear `active.json.groups` or release `project.lock` after
  `rejected` or unverifiable cleanup.
- Add a repository scan test allowing negative-PID `process.kill` only inside
  `src/kill-gate.ts`.

## 4. Lease enforcement, fencing, and lifecycle

### Design

Lease state is per ownership context and monotonic. An accepted control update
must preserve immutable identity, advance issuer revision sequentially, contain
a consistent bounded lease tuple, and be future-valid. Re-reading the same
revision cannot extend the deadline. Once expiry is observed, the context never
revives.

Before each step and immediately before spawn, `mayStartStep()` gates work. While
an adapter runs, `watchLease()` races execution. After adapter completion,
`ownershipFence()` re-reads control state before artifact verification, verdict
parsing, provenance, or next-step resolution.

Ownership loss follows one idempotent sequence:

1. Stop new work and write the interrupted marker.
2. Terminate through fresh runtime capabilities only.
3. Quarantine the declared raw output and matching late artifacts.
4. Verify group absence before removing each active record.
5. If every group is retired, write `stopped: ownership-lost` and release
   admission. Otherwise write terminal ownership failure, preserve records and
   admission, and return `ownership-blocked`.

Normal finalization maps successful, failed, and user-stopped loop outcomes to
the corresponding lifecycle transition only after all groups are verified
retired. It must not clear records merely because a kill was attempted. Terminal
mode never reads or writes ownership state.

### File impact

- Keep the pure lease transition in its purpose-owned module or extract it from
  `src/run-ownership.ts`; watcher and fence must share it.
- Update `src/loops/execution.ts` to retain the double gate, watcher race, and
  completion fence.
- Update `src/interrupted-artifact.ts` and `src/run-ownership.ts` to share one
  checked terminalization boundary.
- Preserve distinct ownership-lost/blocked exit and error rendering through
  `src/loop.ts`, `src/commands/smash.ts`, and `src/cli.ts`.

### Verification

- Test watcher expiry, completion-fence expiry, malformed control updates,
  revision replay/regression/gaps, and read-error threshold.
- For audit, follow-up, and implementation steps, prove no verdict/provenance/
  next-step advancement and raw output present only under `docs/dev/archived/`.
- Test every normal terminal outcome followed by a distinct-run relaunch.
- Test rejected cleanup produces `ownership-blocked`, retained records/lock,
  actionable status, and rejection of the next same-project launch.

## 5. Stale records and operator recovery

### Design

On startup collision, verify the prior CLI lock holder. If it remains live,
reject the new run. If it is dead and `active.json.groups` is empty, quarantine
any interrupted output, mark the stale lifecycle failed, and reclaim admission.

If a dead prior CLI has any registered group on macOS, do not signal from the
durable record and do not delete it automatically. Persist/retain terminal
ownership failure and block admission. The recovery command is diagnostic by
default: show recorded and observed PID/PGID/session/start/executable evidence,
explain ambiguity, and print exact manual inspection steps without signalling.

An explicit destructive recovery action requires interactive confirmation and
revalidates that the CLI holder is dead. It may release admission only after the
operator separately confirms no owned processes remain; it does not perform an
unattended group kill from stale numbers.

Obsolete ownership-record schemas are decoded read-only. They produce a stable
unsupported-record recovery error, preserve admission, and are never overwritten
or converted into process-group authority. Removal of this decoder requires a
documented release-age criterion and migration evidence.

### File impact

- Update `src/run-ownership.ts` stale reconciliation and legacy read-only decoder.
- Add or update a focused ownership recovery command under `src/commands/`.
- Document safe `ps` inspection, confirmation, and lock release in `README.md`
  and `docs/architecture/overview.md`.

### Verification

- Cover dead holder with no groups, live holder, leader-gone group, reused PID/
  PGID, command mismatch, malformed identity, unsupported platform, and obsolete
  record schema.
- Every ambiguous case asserts no signal, failed ownership state, preserved
  groups/lock, and blocked next launch.
- Recovery tests require explicit confirmation and refuse release while the CLI
  holder or any positively identified recorded leader remains live.

## 6. Documentation and release gate

### Design

`README.md`, `AGENTS.md`, and `docs/architecture/overview.md` must describe the
same portable process-group contract, fresh-versus-durable authority boundary,
operator recovery, and detached-descendant limitation. No document may claim
kernel containment, leader-independent stale cleanup, or guaranteed termination
outside the verified group.

macOS is the mandatory release platform. Linux behavior remains supported by
the same contract and deterministic identity tests, but cannot weaken macOS
fail-closed rules. Provider adapters remain black boxes behind the common
`SpawnRuntime` seam.

### File impact

- Rewrite ownership sections in `README.md`, `AGENTS.md`, and
  `docs/architecture/overview.md` rather than appending departure notes.
- Remove obsolete fixtures/tests and replace them with portable process-group,
  kill-gate, stale-recovery, and macOS integration tests.

### Verification

- `npm run typecheck` passes.
- `npm test` passes with no ownership/process-group test skipped because the
  machine is macOS.
- A real macOS test starts an owned run with a short lease and cooperative child,
  expires the lease, confirms provider/bootstrap/child exit, confirms artifact
  quarantine/no next step, and admits a later run only after safe finalization.
- A deliberately detached fixture demonstrates the documented non-guarantee;
  the CLI reports the general limitation without claiming discovery.
- Repository scans find no contradictory ownership architecture and no unsafe
  negative-PID signal outside the single gate.

## Non-goals

- Guaranteed termination of deliberately detached or independently daemonized
  descendants.
- Unattended stale process-group cleanup on macOS.
- Automatic restart or retry of interrupted coding-agent runs.
- Changes to normal terminal workflow, audit semantics, provenance, or provider
  CLI behavior.
- Independent host/CLI crash supervision; that belongs to the separate
  supervisor project.

## Required order

1. Audit this rewritten plan and obtain an `APPROVED` verdict.
2. Do not treat any prior rejected audit or implementation as approval.
3. Repair the current implementation against the approved plan.
4. Run implementation review and repair every rejected finding.
5. Pin the reviewed implementation before beginning supervisor integration.
