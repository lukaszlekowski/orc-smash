---
status: draft
confidence: 0.97
owners: harness-runtime
---

# Crash-Safe App-Owned Run Supervision — CLI Protocol Foundation

## Delivery boundary (read first)

This repository (`orc-smash`) is a **stateless TypeScript CLI harness**. It contains
**no host application, launcher, GUI process, or independent supervisor** — confirmed against
`package.json`, `README.md` ("No DB, no S3, no web UI"), `docs/architecture/overview.md`, and both
roadmaps (grep for `host-app|launcher|supervisor|app-owned` returns no hits outside this plan). The
CLI is the only runtime in this repo.

Crash-safety for an *app-launched* run requires an **independent supervisor process** that survives
the app/UI death it is supposed to detect. Such a supervisor does not exist here and cannot be
implemented from this repository. Therefore this plan is split into two phases with a hard, named
boundary:

- **Phase 1 — CLI protocol foundation (shippable from this repo, this plan's scope of approval).**
  The CLI owns and verifies the complete ownership lifecycle **in-process**: the versioned control
  records and their validation; a **canonical-project admission lock** (one live app-owned run per
  project, regardless of run ID); the lease gate, an **in-flight lease watcher**, and a
  **completion-side ownership fence** that together guarantee an expired run never advances workflow
  provenance/state (and its raw output is quarantined, not left resumable); a **bootstrap
  spawn-registration barrier** so every exec'd provider is durably tracked before it runs; a durable
  **run lifecycle** with terminal transitions for *every* outcome (`completeRun`/`failRun`/`stopRun`);
  group-aware termination; fail-closed behavior for malformed/expired/stale records; and start-time
  reconciliation of a verifiably-owned stale group. All verified in-repo using a **test-fixture
  process as the lease issuer** (a small script that writes/refreshes the issuer record and then
  exits, standing in for a future host app).

- **Phase 2 — Crash-safety release gate (DEFERRED / BLOCKED, out of scope for this plan).** The
  independent host-app supervisor that runs **outside** the CLI/app UI, detects host heartbeat loss,
  terminates groups the CLI cannot reach, and the cross-repository integration suite that proves it.
  **Blocked** until a precondition is met: **a host-app repository/package and its exact launcher,
  supervisor, and status-surface paths are named and available.** This plan names no fictional host
  repo/launcher/CI command.

**Explicit non-claim (must survive audit):** Until Phase 2 lands, this repo does **not** claim that an
app/UI crash is observed by an independent process. What Phase 1 *does* guarantee: (a) the **CLI
process**, while alive and running a provider, watches its own lease and self-terminates the provider
group on expiry — and a provider that finishes at/after expiry is fenced so its result never advances
provenance/state (its raw output is quarantined to `docs/dev/archived/`, never left resumable in
`docs/dev/`); (b) no further loop step ever starts after expiry; (c) every exec'd provider is durably
registered before it runs, so a CLI crash mid-spawn leaves no untracked provider; (d) a
verifiably-owned stale group is terminated at the next CLI start; (e) malformed/stale/tampered records
fail closed and block new spawns; (f) every terminal outcome (success, failure, user-stop, crash)
releases project admission safely; (g) ordinary terminal use is unchanged.

## Goal

Make an app-launched `orc smash` run **unable to continue unattended after the owning app has exited
or lost ownership**, enforced by the CLI process itself. No implementation, audit, or follow-up
provider step may start or advance workflow state after the ownership boundary, and a provider already
running when the lease expires is terminated, marked, and its raw output quarantined.
External/production crash-detection (Phase 2) remains deferred.

## Scope and invariants

- The host app is the **owner** of every run it launches. In app-owned mode, the CLI and every provider
  descendant belong to one recorded run identity and one cancellable cgroup-v2 containment boundary.
- A run is identified by an unguessable `runId` plus an `ownerToken`. **PID/PGID alone is never
  authority to kill** — the durable per-run cgroup is. **Token validation is mandatory for live-run
  termination** (`authorizeLiveRunSignal`); **tokenless reconciliation is permitted only** via
  `authorizeReconcileSignal` **after** a dead CLI holder is verified, the prior run directory is
  private/owned, and the recorded cgroup identity is verified. A new run's token never substitutes for
  a prior run's.
- The owner refreshes an expiring lease. On expiry the CLI's in-flight watcher terminates the running
  provider group and writes the interrupted marker; a provider finishing at/after expiry is fenced so
  its result never advances provenance/state, and its raw output is quarantined; no subsequent step
  starts.
- One **canonical project** has at most one **app-owned** active run, enforced by a project-keyed
  admission lock independent of `runId`; a second start (even with a different run ID) is rejected
  until the prior run is provably complete or reconciled.
- Cancellation, shutdown, and stale-run reconciliation use one sequence: stop new work → optional
  `SIGTERM` to a verified live PGID → bounded grace → `cgroup.kill` for the validated owned cgroup.
- Provider grandchildren are in scope; signalling only the direct `ChildProcess` is insufficient.
- Run-control records live **outside the target project** (operator-resolved private runtime dir).
  They are operational ownership state, **not** durable workflow state; no record participates in
  artifact scanning, resumption, or status loop selection.
- A stale/malformed record **fails closed**: blocks spawns, surfaces a terminal ownership failure,
  never causes an unverified PID to be killed.
- **Threat model (stated):** defends against accidental orphaning, operator confusion, and **PID
  reuse** (killing the wrong process). It does **not** defend against a malicious same-user process,
  who already owns the tree, artifacts, and runtime dir. Every choice below is justified against that.

## 1. Ownership control-record contract — project admission + two single-writer run files

### Design

One module, `src/run-ownership.ts`, is the single ownership boundary; no lease logic lives in
`loop.ts` or adapters. State is split into two **namespaces** so that admission is keyed by
**canonical project** (not by `runId`) while per-run data stays keyed by `runId`.

```
<base>/orc-smash/projects/<sha256(realpath(projectRoot))>/
    project.lock   # O_EXCL admission lock (project-keyed)
    project.json   # index: { currentRunId, runDir, pid, startMs, state }
<base>/orc-smash/runs/<runId>/
    control.json   # issuer-only writer
    active.json    # CLI-only writer
```

`<base> = ${ORC_RUN_STATE_DIR ?? ${XDG_RUNTIME_DIR ?? os.tmpdir()}}`. The **project** directory is
selected by the canonical root hash; the **run** directory is selected by the non-secret `runId`.
`mkdir(dir, {recursive:true, mode:0o700})`; all files `0o600`; on every open `stat` and **reject if
`mode & 0o077 !== 0`** (loosened/tampered → fail closed).

| File | Writer | Contents |
| --- | --- | --- |
| `runs/<runId>/control.json` | **Issuer only** (host in Phase 2; fixture issuer in Phase 1). CLI reads only. | `schemaVersion`, `runId`, `ownerTokenHash` (= `sha256(ownerToken)`; **plaintext token is never stored**), `projectRoot` (canonical), `hostInstanceId`, lease (`leaseIssuedMs`, `leaseTtlMs`, `leaseExpiresMs`), `issuerRevision`. |
| `runs/<runId>/active.json` | **CLI only**. | CLI identity tuple, the set of registered provider group identities — each `{ cgroupPath, pgid, leaderPid, leaderStartMs, command }` — lifecycle `state`, terminal `reason`, `cliRevision`, timestamps. |
| `projects/<hash>/project.lock` | **CLI only**, admission. | `O_EXCL` lockfile `{runId, pid, startMs, runDir}`. **Keyed by canonical project**, held for the run, released in a `finally` on every exit path. |
| `projects/<hash>/project.json` | **CLI only**, index. | `{ currentRunId, runDir, pid, startMs, state }`. Atomically written; points admission at the live run directory. |

**Atomic I/O.** Each writer updates its own file via temp (`<file>.tmp.<pid>`) → `fsync` → `rename`
(atomic on the same filesystem). A reader that observes partial/garbage JSON **fails closed** (never
as absent). Each file has exactly one writer, so **no cross-writer CAS** is needed; each file carries
its own monotonic revision only so a reader can detect a torn read and retry once, then fail closed.

**Issuer heartbeat (no CLI lock).** The issuer refreshes the lease by rewriting `control.json`
atomically (new `leaseExpiresMs`, bumped `issuerRevision`). The **immutable** fields
(`runId`, `ownerTokenHash`, `projectRoot`, `hostInstanceId`) must be byte-identical across heartbeats;
if the CLI observes any of them change mid-run, it **fails closed** (issuer identity drift). Heartbeats
touch only the run file and never the project admission lock.

**Project admission + stale-lock rules (`acquireProjectLock()`).** `project.lock`
(`fs.openSync(path,'wx')`). On `EEXIST`, the holder is checked for liveness via `verifyIdentity()`:
dead → reclaim (read `project.json` → run `reconcileOnStart()` on the prior run, then acquire); live →
**reject** the second start. Because the lock is keyed by canonical root, **two launches with
different `runId`s for the same project contend on the same `project.lock`** and the second is
rejected.

**Canonical root.** `fs.realpath(projectRoot)` before hashing or comparing; symlinked paths collapse to
one project directory (one admission lock). `realpath` failure fails closed.

**Lease clock.** `isExpired(now) = now >= leaseExpiresMs` (wall-clock). Monotonic floor: once a
process observes expired, it stays expired for that process. Recorded `leaseExpiresMs` is
authoritative; skew grace is the issuer's responsibility.

**Identity tuple + validation (`verifyIdentity()`), per-platform.** A recorded `{pid, startMs,
command}` is *verified-owned* iff the PID is alive, its command matches, and its start time matches
within tolerance. Parsers are explicit and **fail closed on ambiguity**:
- **Linux:** command from `/proc/<pid>/cmdline` (NUL-separated `argv[0]`); start time =
  `/proc/<pid>/stat` field 22 (starttime in clock ticks since boot) × `1000 / getconf CLK_TCK` +
  boot epoch (from `/proc/stat` btime).
- **macOS:** no `/proc`; use `ps -p <pid> -o lstart=,command=` parsed by a **fixed-format** parser
  (bounded month table, no locale-dependent month names); `etime` cross-checked where available.
- **Unavailable / unparseable** (unknown platform, `ps` error, ambiguous date) → **fail closed**.

A **live, freshly-registered** group validates against the **exact identity the bootstrap wrapper
self-reports at spawn** (§2) — no `/proc`/`ps` parsing required. The platform parsers govern only
**stale reconciliation** of a group recorded by a prior, crashed CLI.

**Group-termination authorization — validated cgroup-bound, leader-independent, no reuse risk.** The
authoritative kill identity is the per-run **cgroup-v2 container** recorded in `active.json` (§2), not a
recyclable PGID and not the leader. Before *every* cgroup membership read or kill,
`validateRunCgroup(handle, capability)` must succeed. It derives the sole valid path from the capability's
canonical delegated root and the validated `runId` as `<delegatedRoot>/orc-smash/<runId>`; rejects absolute
or traversal-bearing input, paths outside that root, sibling paths, missing paths, or a recreated cgroup;
verifies cgroup-v2 ownership/delegation; and compares the recorded creation identity (device/inode where
available) with the live directory. The cgroup directory remains in place until terminal cleanup, so a
deleted or recreated path is never trusted. Failure is an ownership failure: no `cgroup.kill`, retain
admission, and require operator recovery.

After validation, its membership (`cgroup.procs`) is exactly the run's provider tree — **including
descendants that outlive the leader**. `cgroup.kill` therefore reaches every member leader-independently
and race-free. Two authorization entry points:
- `authorizeLiveRunSignal(handle, { liveToken })` — used by the **running CLI** (normal termination and
  ownership loss): `validateRunCgroup()` succeeds **and** `sha256(liveOwnerToken) ===
  control.ownerTokenHash` (the running CLI holds its own token in memory).
- `authorizeReconcileSignal(handle)` — used by **stale reconciliation** (`reconcileOnStart()`): authorizes
  tokenlessly after the prior CLI holder is verified dead, the prior run directory is private/owned, and
  `validateRunCgroup()` succeeds. It does **not** require the provider leader to be live: leader identity
  is only an optional graceful-`SIGTERM` optimization. The prior plaintext token is unavailable after a
  crash (`control.json` stores only its hash); the validated durable cgroup identity, not a new run's
  token, is the binding proof. A new run's token is never substituted for the prior run's token.

Because the cgroup is durable, **leader-gone descendants are still stopped** (not left running): a
non-empty cgroup is provably the run's, so `killCgroup()` is authorized regardless of leader liveness.
The only fail-closed case is a cgroup whose membership cannot be read/killed (e.g. an unkillable
`D`-state member or a lost cgroup file) — then retain admission and surface a terminal ownership
failure (with the documented operator recovery procedure).

**Durable run lifecycle — one state machine, terminal in every outcome.** All transitions are
revisioned `active.json` writes; `project.json` is cleared and `project.lock` released on terminal
states. States: `starting → running → stopping → { completed | failed | stopped }`.
- `registerGroup(handle)` — at the bootstrap ACK (§2): add the group identity to `active.json`, set
  `state: 'running'`, bump `cliRevision`.
- `confirmGroupClosed(handle)` — a **verified group-retirement**, not a mere child-close callback.
  Called from the owned `SpawnRuntime` close path **after the leader has closed**: `readCgroupProcs()`
  (§2) and remove the handle from the active set **only when the cgroup is empty** (normal clean exit).
  If members remain (a descendant outlived the leader), the cgroup is still provably the run's, so
  `killCgroup()` is authorized and the survivors **are stopped** — re-read and retire when empty. If
  membership cannot be read/killed → **fail closed** (retain the handle + admission, surface a terminal
  ownership failure). Bump `cliRevision` on every change.
- `completeRun()` — invoked by the finalization layer (§3) **only after** successful artifact
  closeout: `state: 'completed'`, release admission.
- `failRun(reason)` — terminal loop failures (terminal `unknown`, missing artifact, REJECTED at the
  iteration ceiling, thrown exception): `state: 'failed'`, ensure no active group remains (else fail
  closed), release admission.
- `stopRun(reason)` — user/interactive stop: `state: 'stopped'`, same cleanup, release admission.

Crash points and reconciliation (used by `reconcileOnStart()`, §3): crash after `registerGroup`
before `confirmGroupClosed` → a registered group may be live; reconcile authorizes via
`authorizeReconcileSignal()` (cgroup-bound, tokenless) and `killCgroup()`s it — **including any
descendant that outlived the leader** — then allows after the cgroup is empty. Crash after the leader
closed but before empty retirement → a surviving descendant is still in the durable cgroup; reconcile
kills it via `killCgroup()` and allows when empty. Crash after `confirmGroupClosed` before any terminal
transition → active group set empty, run non-terminal, dead holder on `project.lock`; reclaim the lock,
clear the non-terminal run, allow a new run (artifact quarantine handles partial output). Crash after a
terminal transition → admission already released; clean. **A terminal ownership-failure state
(unkillable/unreadable cgroup) is never auto-reclaimed**: even with a dead holder, `reconcileOnStart()`
surfaces it for an operator (with the documented recovery procedure) rather than releasing admission.

**Out-of-band token (no circularity).** `control.json` stores only `ownerTokenHash`. The plaintext
token reaches the CLI out-of-band via `ORC_RUN_TOKEN` (Phase 1) or an inherited fd/IPC handle (Phase 2
target). The CLI computes `sha256(token)` and compares; `argv` transport is rejected (world-readable
via `ps`).

### File impact

- **Add `src/run-ownership.ts`** (new): `projectDir()`/`runDir()` (`sha256(realpath)` / `runId`),
  `canonicalRoot()`, zod schemas + `readControl()`/`readActive()`/`writeActive()`/`readProjectIndex()`/
  `writeProjectIndex()` (fsync+rename, permission enforcement), `acquireProjectLock()`/
  `releaseProjectLock()` (O_EXCL + stale-lock liveness), `isExpired()` (monotonic floor),
  `verifyIdentity()` (per-platform parsers, fail-closed), `authorizeLiveRunSignal()` /
  `authorizeReconcileSignal()` (cgroup-bound; §1), `tokenMatches()` (`sha256` compare), the
  immutable-field-drift check, the pure `mayStartStep()`
  decision, `registerGroup()`/`confirmGroupClosed()`/`completeRun()`/`failRun()`/`stopRun()`,
  `watchLease()` (§3), `ownershipFence()` (§3), `finalizeOwnedRun()` (§3), and `reconcileOnStart()`
  (§3).
- **Add `src/commands/ownership-launch.ts`** (new): parses `OwnershipLaunchInput` and exposes
  `openOwnedRun()`.
- **Update `src/commands/smash.ts::smashAction()` / `resolveSmashRunSetup()`**: build
  `OwnershipContext` (or `null` for terminal mode); run `openOwnedRun()` (acquires the project lock) +
  `reconcileOnStart()` before any scan/spawn; wrap `runLoop()` in the `finalizeOwnedRun()` layer so
  every terminal outcome releases admission; map ownership outcomes to the distinct exit code.
- **Update `src/loops/execution.ts::executeLoopStep()`**: double lease gate (pre-`stepStarted`,
  pre-spawn); start `watchLease()` around the adapter run; race expiry against `adapter.run()`; run the
  **completion-side `ownershipFence()`** after `adapter.run()` resolves (§3).
- **Extend `src/adapters/errors.ts`** with an `ownership` error kind + remediation wording, via the
  existing `structuredMessage()` seam.
- **Update `README.md`, `docs/architecture/overview.md`, `AGENTS.md`**: external operational state
  (never under `docs/dev/` or `.orc-smash/`); same-user threat model; cgroup-v2 app-owned support with
  reject-before-spawn elsewhere; deferred Phase 2 gate; and the **operator recovery procedure** for a
  retained-admission terminal ownership-failure — inspect `<runStateDir>/orc-smash/projects/<hash>/` and
  clear `project.lock` only after revalidating that no owned cgroup/processes remain (an
  `orc ownership clear --project <path>` confirmation action that re-runs `readCgroupProcs` +
  `verifyIdentity` before any unlock).

### Entry contract — `OwnershipLaunchInput` + `openOwnedRun()`

App-owned mode is **active** iff an `OwnershipLaunchInput` is present and well-formed. It is supplied
out-of-band, never via `argv`:

- `ORC_RUN_ID` — non-secret run identifier; selects the run directory.
- `ORC_RUN_TOKEN` — secret owner token (plaintext; out-of-band).
- `ORC_RUN_STATE_DIR` — optional base-directory override.

Activation rules (all enforced in `openOwnedRun()`):
- **Both `ORC_RUN_ID` and `ORC_RUN_TOKEN` present** → app-owned mode.
- **Both absent** → terminal mode (current behavior). The two modes are **mutually exclusive**.
- **Partial** (one present, the other absent) → **fail closed**; **never** silently fall back to
  terminal mode.
- **Mismatch** (`control.json` absent; `runId`/canonical-root mismatch; `sha256(token) !==
  ownerTokenHash`) → fail closed; do not spawn.
- **Ambiguous** (selector matches more than one record) → fail closed.

`openOwnedRun(input, projectRoot)`: resolve `runDir` from `runId`; read `control.json`; validate
schema + `sha256(token) === ownerTokenHash` + `runId` + canonical root (fail closed on any issue);
compute `projectDir`; `acquireProjectLock(projectDir)` (reject on live holder, reclaim on dead);
write `project.json` index; return an `OwnershipContext` (live token in memory only, read-only control
record, writable active/project handles).

### Verification

- Unit (pure) `mayStartStep()` at startup/step boundaries; immutable-field-drift detection.
- Unit `readControl`/`readActive` for malformed, wrong-`schemaVersion`, wrong-root, wrong-token,
  loosened-permission, tampered, torn-read → each rejects, issues **no signal**.
- Unit `verifyIdentity` per platform (Linux `/proc`, macOS `ps`, unknown) including PID-reuse
  (live PID, wrong command → reject) and ambiguous `ps` output → fail closed.
- Unit `tokenMatches`: plaintext token matches hash; wrong token rejected; record stores no plaintext.
- Unit issuer-heartbeat: rewriting `control.json` while `project.lock` is held succeeds without the
  lock.
- Unit lifecycle: `registerGroup`→`confirmGroupClosed`→`{completeRun|failRun|stopRun}` revision bumps
  and final admission release; illegal/non-terminal-leftover transitions fail closed.
- `tests/run-ownership.cross-process-lock.test.ts` — **two distinct `runId`s for the same
  realpath/symlinked root**: the second `openOwnedRun()` is rejected via the shared project-keyed
  `project.lock`; a dead holder is reclaimed; issuer heartbeats continue throughout.
- `tests/ownership-launch.command.test.ts` — command-level coverage: both-env-present → app-owned;
  both-absent → terminal; **partial** → fail closed (no silent fallback); mismatched/ambiguous → fail
  closed before admission and spawn nothing.

### Non-goals

- Do not persist workflow progress or resume decisions in any ownership file.
- Do not place ownership files under `docs/dev/` or `.orc-smash/`.
- Do not pass `runId`/token via `argv`. Do not store the plaintext token.
- Do not key admission by `runId`. Do not overload provider timeout config for watcher settings. Do not
  implement the independent supervisor here (Phase 2).

## 2. Terminable process groups with a spawn-registration barrier

### Design

Direct-child-only termination is replaced by **durable per-run process containment** so the entire
provider tree — including a descendant that outlives the leader — is stopped provably after lease loss.
A recyclable PGID cannot provably bind a leaderless group (the numeric PGID may be reused once the group
is empty), so the authoritative kill identity is a **per-run cgroup-v2 container**, terminated by
`cgroup.kill` (leader-independent, race-free, reuse-immune). The POSIX-shell wrapper is retained for the
graceful-SIGTERM phase and a pid-stable handoff; the cgroup is the durable kill identity.

**Capability check.** A PGID alone is insufficient, and cgroup-v2 is Linux-only, so app-owned mode is
**gated on a cgroup-v2 capability check** at `openOwnedRun()`: locate and canonicalize the delegated
cgroup root from `/proc/self/cgroup` (`0::<path>`), create a test sub-cgroup below it, start a short
helper process that self-joins via `cgroup.procs`, verify membership plus `cgroup.kill` are writable,
then kill/reap the helper and remove the test hierarchy. The capability records the canonical delegated
root and the filesystem identity needed by `validateRunCgroup()`. If any step fails, or cgroup-v2 is
absent/not delegated (macOS, Windows, non-delegated Linux), app-owned mode is **rejected before spawn**
with a clear operator message; ordinary terminal mode is unaffected.

**Bootstrap spawn-registration barrier (cgroup + wrapper).** In app-owned mode the CLI does not spawn
the provider directly. `ProcessGroupRuntime.createGroup()`:
1. validates `runId` as an opaque non-path identifier, creates the per-run cgroup at the deterministic
   `<canonicalDelegatedRoot>/orc-smash/<runId>/` path, and records its creation identity in the handle;
2. spawns the POSIX-shell wrapper `detached:true` (new session/group, `pgid === sid === wrapper.pid`)
   with a 5-fd `stdio` (fd 3 = child→parent identity, fd 4 = parent→child ACK), passing the cgroup path
   as `argv[1]`;
3. the wrapper **moves itself into the cgroup** (`echo $$ > "<cgroupPath>/cgroup.procs"`, permitted as
   self-membership), reports `{pid, pgid, sid, cgroupPath}` on fd 3, and blocks on ACK from fd 4;
4. on ACK the wrapper POSIX-`exec`s the provider into the same pid/pgid/session **and cgroup** — so
   every forked descendant inherits cgroup membership. If **fd 4 closes (parent died) before ACK**, the
   wrapper exits without exec'ing (no provider started);
5. `registerGroup(handle)` — **durably** writes `{cgroupPath, pgid, leaderPid, leaderStartMs, command}`
   to `active.json` (fsync+rename) and bumps `cliRevision`; the ACK is written only after the rename is
   durable.

Because the wrapper is contained **before** it execs, no descendant can escape the per-run cgroup. Thus
the provider cannot run until `{runId, cgroupPath, pgid, leaderPid, leaderStartMs, command, revision}`
is persisted, and the pid that reported readiness is the pid that runs the provider. On any failure
between spawn and durable registration, the parent `killCgroup()`s the cgroup before releasing it (the
wrapper has not exec'd, so only the wrapper is present). `createGroup()` returns
`{ child, handle, ready }`; downstream streaming begins after `ready`. On leader close, the owned
`SpawnRuntime` close path **awaits** `confirmGroupClosed(handle)` (§1), which kills any descendant that
outlived the leader via the durable cgroup before returning.

**Wrapper asset + resolution.** The wrapper is a small POSIX `sh` script
`src/adapters/process-group-wrapper.sh` (shebang `#!/bin/sh`; uses only POSIX `exec`, `read`, `echo`).
The current package ships **source** — `bin/orc.js` runs `src/cli.ts` via `tsx` and `package.json` has
no build/`prepack` step — so there is no separate packaged location: `resolveWrapperPath()` in
`src/adapters/process-group.ts` resolves the **source asset** co-located with the module via
`fileURLToPath(import.meta.url)` (the same source-relative resolution `bin/orc.js` uses to find
`src/cli.ts`), and a unit test asserts the resolved path exists and is readable. If a future build/
pack step is added it must carry the wrapper alongside (out of scope for Phase 1). It is launched as
`spawn('sh', [wrapperPath, providerCommand, ...providerArgs], { detached:true, stdio:
['ignore','pipe','pipe','pipe','pipe'] })` — invoking `sh` explicitly avoids executable-bit issues.
**No `process.execve` and no Node-engine constraint** is required: the in-place handoff is POSIX
`exec`, not a Node API.

**Platform capability matrix:**

| Platform | App-owned mode | Terminal mode |
| --- | --- | --- |
| Linux + delegated cgroup-v2 | **Supported.** Per-run cgroup containment + POSIX-`exec` wrapper + `cgroup.kill` termination (stops the whole tree, incl. leader-gone descendants). | Unchanged (direct-child termination). |
| macOS / Windows / non-delegated Linux | **Rejected before spawn** (cgroup-v2 capability check fails → fail closed at setup). | Unchanged. |

**Registration failure fails closed.** In app-owned mode, if the group cannot be created or its
identity cannot be durably persisted before exec, the step fails closed (no provider exec). In terminal
mode there is no ownership barrier; the existing direct-child interrupted-run path is unchanged.

**Durable containment primitives** in `src/adapters/process-group.ts` (cgroup v2; fail-closed):
- `validateRunCgroup(handle, capability)` → validated cgroup path or ownership failure. This is mandatory
  before all reads/kills and enforces the deterministic path, delegated-root boundary, and creation
  identity rules above.
- `readCgroupProcs(handle, capability)` → `string[]` of member PIDs (`cgroup.procs`) only after
  `validateRunCgroup()`; exact membership, leader-independent, no `/proc` walk, no reuse ambiguity.
- `killCgroup(handle, capability)` → validates first, writes `1` to `cgroup.kill` (atomic SIGKILL of
  every member), then re-reads membership; returns `{ survivors: string[]; unverifiable: boolean }`.

The cgroup — not the leader's `'close'` event and not a recyclable PGID — is the authoritative
condition for both `confirmGroupClosed()` and ownership-loss completion: it is durable (owned by the
run until torn down) and cannot be reused while held, so a leaderless-but-non-empty cgroup is provably
the run's and is safely killable. **Two-phase termination:** graceful `SIGTERM` to the PGID
(`process.kill(-pgid, ...)`, while the leader is alive) → bounded grace → **`killCgroup()`** as the
guaranteed finisher that reaches leader-gone descendants. Termination is idempotent, bounded, and
preserves the durable interrupted-artifact behavior before exit.

**Threading through adapters.** A new `SpawnRuntime` seam **extends `ProcessRunner`** so every adapter
selects the owned path without bespoke wiring:
```ts
interface SpawnRuntime {
  spawn(req: SpawnRequest): { result: Promise<RawProcessResult>; handle?: ProcessGroupHandle; ready?: Promise<void> };
}
```
- **Legacy `SpawnRuntime`** wraps `runProcess` (no group) — terminal mode.
- **Owned `SpawnRuntime`** uses `ProcessGroupRuntime` + the shell wrapper — app-owned mode.

`OwnershipContext` flows: `LoopOptions.ownership` → `LoopExecutionDeps.ownership` →
`RunInput.ownership`/`RunInput.spawnRuntime` → each `AgentAdapter.run()` → `spawnAgentProcess()` /
`spawnOpencode()`. When `ownership` is present the adapter builds the owned `SpawnRuntime`; otherwise
it uses the legacy runner. `src/adapters/registry.ts` factories gain an optional `groupRuntime?`
injection seam (parallel to `codexProcessRunner`/`claudeProcessRunner`/`agyProcessRunner`/
`opencodeSpawn`) so deterministic tests inject a **fake** group runtime. The `fake` adapter
(`src/adapters/testing.ts`) honors `RunInput.spawnRuntime`/`ownership` so fake-path loop tests
exercise the **same** ownership lifecycle (lease gate, registration ACK, expiry, completion fence)
with no real processes.

### File impact

- **Add `src/adapters/process-group.ts`** (new): `ProcessGroupRuntime`, `ProcessGroupHandle`,
  `SpawnRuntime`, `resolveWrapperPath()`, `createCgroup()`/`readCgroupProcs()`/`killCgroup()` (cgroup v2;
  `cgroup.procs` census + `cgroup.kill` finisher), the owned spawn/cgroup-self-join/`registerGroup`/ACK
  path, the two-phase termination (SIGTERM `-pgid` → grace → `killCgroup`), and the close path that
  **awaits cgroup-empty `confirmGroupClosed()`**; plus an `unsupported` path (no cgroup v2) whose
  `createGroup` throws → reject app-owned before spawn.
- **Add `src/adapters/process-group-wrapper.sh`** (new): POSIX `sh` wrapper (report `{pid,pgid,sid}`
  on fd 3 → block on ACK from fd 4 → `exec "$@"`; fd-4 close before ACK → exit). Uses real POSIX
  `exec` (process replacement); no Node API.
- **Refactor `src/adapters/utils.ts`**: `runProcess()`/`spawnAgentProcess()`/`spawnOpencode()` route
  through the `SpawnRuntime` selected by `RunInput` (legacy default unchanged); the owned close path
  awaits `confirmGroupClosed()`; `terminateActiveChildren()` delegates to two-phase cgroup termination
  for registered handles.
- **Extend `src/adapters/types.ts::RunInput`** with optional `ownership?`/`spawnRuntime?`.
- **Extend `src/loops/execution.ts::LoopExecutionDeps`** and `src/loop.ts::LoopOptions` with
  `ownership?: OwnershipContext`; `runLoop` threads it to `executeLoopStep`.
- **Extend `src/adapters/registry.ts`** factories with the `groupRuntime?` seam; extend
  `src/adapters/testing.ts` (fake adapter) to honor `spawnRuntime`.

### Verification

- Deterministic (fake-adapter) tests: owned spawn calls `createGroup` (creates cgroup + spawns wrapper
  + ACKs after `registerGroup`), waits on `ready`, and `terminateActiveChildren` runs two-phase
  termination (SIGTERM then `killCgroup`); the close path awaits cgroup-empty `confirmGroupClosed`;
  terminal spawn uses the legacy runner unchanged.
- Per-adapter tests (`tests/adapters/<agent>-ownership.test.ts` for codex, claude, agy, opencode): in
  owned mode the adapter's `run()` uses the owned `SpawnRuntime`; in terminal mode the legacy runner;
  verified via the existing `*ProcessRunner`/`opencodeSpawn` injection seams.
- **`tests/process-group.bootstrap.test.ts`** (Linux + cgroup-v2-gated): asserts (a) the wrapper's
  session/pgid equal its pid **before ACK**; (b) **the pid reporting readiness before ACK is the same
  pid executing the provider after ACK** (POSIX `exec`); (c) the provider and a forked grandchild are
  members of the per-run cgroup (`cgroup.procs`); and (d) cancellation leaves neither alive.
- **`tests/process-group.descendant-stopped.test.ts`** (Linux + cgroup-v2-gated): the provider leader
  exits **before lease expiry** while a forked grandchild closes inherited stdio and remains alive in
  the per-run cgroup; the lease then expires. Assert `confirmGroupClosed()`/`handleOwnershipLoss()`
  **stop the descendant** via `killCgroup()` (leader-gone, but the cgroup is durable ⇒ safely killable)
  and the grandchild is dead **before** admission is released. (A clean leader exit with no survivor
  retires normally; an unkillable `D`-state member fails closed.)
- **`tests/process-group.fault-injection.test.ts`** (Linux + cgroup-v2-gated): controlled parent death
  at (1) after wrapper spawn / before `active.json` write, (2) after write / before ACK, (3) after ACK
  / during provider exec; assert in **every** case no provider/grandchild survives and none is left
  untracked (pre-registration cases rely on the wrapper's fd-4-close self-termination; post-registration
  cases leave a cgroup the next start reconciles).
- Stale-record reconciliation test: a verifiably-owned recorded group is killed; an unrelated process
  with a reused PID is **not** killed.
- Windows/other: app-owned mode rejected before spawn (`process.platform`-gated unit test).

### Non-goals

- Do not rely on Node's default parent/child exit behavior as crash cleanup, and do not use a recyclable
  PGID as the authoritative kill identity (use the durable cgroup).
- Do not call `setsid()`/`process.execve()` from the wrapper; the parent's detached spawn establishes
  the session and POSIX `exec` performs the handoff.
- Do not support app-owned mode where a delegated cgroup-v2 hierarchy is unavailable (macOS, Windows,
  non-delegated Linux) — reject before spawn rather than run with an unprovable kill identity.
- Do not broaden provider autonomy flags or alter provider command arguments.

## 3. Fail closed across expiry, crash, recovery, and concurrent-launch paths

### Design — in-flight lease expiry, completion fence, raw-artifact quarantine, and finalization

The CLI process is alive while a provider runs, so it can **watch its own lease** and self-terminate
on expiry, **fence** every completed step so an expiry landing between the last watcher tick and
provider exit cannot advance state, and **quarantine** any raw provider output so nothing resumable is
left in `docs/dev/`.

**Watcher constants** are internal to `src/run-ownership.ts` with env overrides
(`ORC_LEASE_WATCH_INTERVAL_MS`, `ORC_LEASE_WATCH_MAX_READ_ERRORS`) mirroring the existing
`OPENCODE_RUN_TIMEOUT_MS` env-first pattern — **not** overloaded onto `registry.timeouts`:
- `LEASE_WATCH_INTERVAL_MS` (default **500 ms**) — polling interval; the **maximum detection delay**
  for a mid-run expiry is one interval.
- `LEASE_WATCH_MAX_READ_ERRORS` (default **3**) — consecutive read failures before the watcher resolves
  `expired` (fail closed).

`watchLease(control, opts)` reads `control.json` on this timer and returns
`{ expired: Promise<void>; cancel(): void }`; `expired` resolves exactly once when `isExpired()` holds
(monotonic floor). `watchLease()` is **started before** `adapter.run()` and **cancelled in the
`finally`** of `executeLoopStep()`.

`executeLoopStep()` awaits `Promise.race([adapter.run(input), ownershipLost])`, where `ownershipLost`
is the watch's `expired` promise mapped through a **single idempotent handler**
`handleOwnershipLoss(loopSpec)` in `src/interrupted-artifact.ts`:
1. guarded by a module-level once-flag (idempotent vs. a concurrent `SIGINT`/`SIGTERM` and the
   completion fence);
2. write the interrupted marker;
3. two-phase terminate each registered group — graceful `SIGTERM` (`-pgid`, leader alive) → grace →
   `killCgroup()` authorized via `authorizeLiveRunSignal()` — and collect the per-group verified-exit
   result (`{ survivors, unverifiable }` from the post-kill `cgroup.procs` read);
4. **quarantine the raw provider output**: resolve the in-flight artifact path from `activeStepCtx` +
   `loopSpec` patterns and run the existing `quarantineLateArtifactsForLoop()` plus the in-flight
   `quarantineArtifact()` so **nothing resumable remains in `docs/dev/`** (moved to
   `docs/dev/archived/`); this is the backstop for a provider that wrote its declared file before
   expiry;
5. **survivor gate**: release the project admission lock **only if every registered cgroup is empty**
   (`readCgroupProcs`). If any group has unkillable survivors or unreadable membership, instead write a
   **terminal ownership-failure** state in `active.json`/`project.json`, **retain admission** (do not
   release the lock, do not allow a new run), and resolve `ownershipLost` as a distinct **blocked**
   outcome for an operator (documented recovery procedure);
6. resolve `ownershipLost`.

**Completion-side ownership fence.** When `adapter.run()` wins the race, the watcher may have missed
an expiry that occurred after the last tick — and the provider may have already written its raw output
file. So **after `adapter.run()` resolves and before `executeLoopStep()` returns success**, run
`ownershipFence(ctx)`:
1. re-read `control.json`, validate immutable fields + `sha256(token) === ownerTokenHash`;
2. evaluate `isExpired(Date.now())`;
3. on drift/expiry/invalid → invoke the same idempotent `handleOwnershipLoss(loopSpec)` (which
   quarantines the raw output) and return an **ownership-lost** step result
   (`error.kind === 'ownership'`); on success → return the normal result.

The fence plus the handler's quarantine make the "after provider exit, pre-closeout" row enforceable:
a provider that finishes at/after expiry is fenced before its result can advance anything, and its raw
output is archived — **not** left resumable in `docs/dev/`.

**Enforceable artifact claim (corrected).** The CLI cannot stop a provider from writing its own
declared file before the fence. The guarantee is therefore: **no provenance/state advancement** (no
`writeArtifactWithMeta()`, no verdict parse, no next step) **and the raw output is immediately
quarantined to `docs/dev/archived/` on ownership loss** — so it is not resumable and never reaches the
decision-path `scan()`. The existing rerun-time `quarantineInterruptedResume()` remains as a backstop.

**Ownership-loss result threading through `loop.ts`.** `executeLoopStep()` returns a discriminated
result:
```ts
type ExecuteLoopStepOutcome =
  | { kind: 'ran'; result: RunResult; durationMs: number }
  | { kind: 'ownership-lost' };
```
`runLoop()`'s per-step handler checks `outcome.kind` **first**; on `'ownership-lost'` it returns
immediately with `{ success: false, verdict: 'ownership-lost', message, lastAuditPath: null }`,
**skipping** artifact verification, `writeArtifactWithMeta()`, provenance write, and next-step
resolution. `cli.ts` maps that verdict to the distinct ownership-loss exit code.

**Terminal finalization for every outcome.** `smashAction()` wraps `runLoop()` in a single
`finalizeOwnedRun()` layer (try/finally, active for the whole duration after `openOwnedRun()`). It
selects the terminal transition for **every** non-ownership return/throw: `completeRun()` on success,
`stopRun('user-stop')` on interactive stop, `failRun(reason)` on terminal `unknown`/missing
artifact/REJECTED-at-ceiling/exception. Before releasing admission it asserts via `readCgroupProcs()`
that **every registered cgroup is empty**; if any group still has members it `killCgroup()`s them
(durable, leader-independent), and if any member is unkillable or the cgroup is unreadable → **fail
closed** into a terminal ownership-failure state (do not silently release); otherwise clear
`project.json` and `releaseProjectLock()`. The ownership-loss path applies the same gate inside
`handleOwnershipLoss()` (also terminal-safe). Thus there is no `openOwnedRun()` exit that leaves
`project.json`/`project.lock` in an undefined state.

**Lease-expiry / termination race table (Phase 1):**

| Lease expires when | Authoritative recorder | CLI action | Exit / result | Restart reconciliation |
| --- | --- | --- | --- | --- |
| **Before spawn** (pre-`stepStarted`) | CLI | `mayStartStep()` false → ownership-loss result, no spawn | Ownership-loss exit; no advance | Fresh start; no stale group |
| **During registration** (post-`stepStarted`, pre-ACK) | CLI | re-check lease pre-spawn; abort; barrier ⇒ no provider exec'd | Ownership-loss exit; no marker | Fresh start |
| **During provider execution** (step in flight) | CLI | `watchLease()` fires → `handleOwnershipLoss()`: marker → two-phase terminate (`SIGTERM -pgid` → `killCgroup`, reaches all members incl. leader-gone descendants) via `authorizeLiveRunSignal()` → **quarantine raw output** → release lock **only if every cgroup empty (else terminal ownership-failure + retain + blocked)**; `Promise.race` returns ownership-lost | Ownership-loss exit (≠ `128+signal`); marker present; raw output archived | `quarantineInterruptedResume` backstop, then resumes |
| **After provider exit, pre-closeout** (completion-side) | CLI | `ownershipFence()` re-reads `control.json`, detects expiry → `handleOwnershipLoss()`; returns ownership-lost | Ownership-loss exit; marker present; **no provenance/state advance; raw output archived** | Rerun resumes from the interrupted version |
| **CLI force-killed (`SIGKILL`)** | `project.json` + `active.json` | n/a — CLI dead | no CLI exit; no marker | `reconcileOnStart()` (via `acquireProjectLock` dead-holder reclaim), **tokenless** (prior token unavailable), cgroup-bound: lease provably expired **and** cgroup empty → clear+allow; cgroup non-empty → `authorizeReconcileSignal()` + `killCgroup()` (durable, leader-independent, reaches leader-gone descendants), allow only after empty; unkillable/unreadable cgroup or a terminal ownership-failure state → **fail closed for operator** (documented recovery procedure) |

**Marker-write ordering (fixed):** marker is written **before** termination (reuses the existing
`handleInterruptSignal()` ordering), so an interrupted step is always resumable even if group
`SIGKILL` races the write. The raw-artifact quarantine and project admission lock release happen after
termination in the same path.

**Authoritative recorder (Phase 1):** the in-project `.orc-smash/interrupted.json` marker (existing)
is authoritative for **resume**; `project.json` + `active.json` + `control.json` are authoritative for
**"may a new run start"** and for **stale-group reconciliation**. On a `SIGKILL`-ed CLI these durable
files plus `reconcileOnStart()` (reached through `acquireProjectLock`'s dead-holder reclaim) are the
authority — a stale record is never silently trusted to permit spawns.

**`reconcileOnStart()`** (run when a project admission lock is held by a dead holder): if the prior
run is in a **terminal ownership-failure** state, do **not** auto-reclaim — surface it for an operator
(retain admission, documented recovery procedure). Otherwise read its `active.json`; for each registered
group — the prior run's plaintext token is **unavailable** (only its hash is on disk), so reconciliation
authorizes **tokenlessly** via `authorizeReconcileSignal()` (cgroup-bound): `readCgroupProcs()`; if
non-empty, `killCgroup()` (durable, leader-independent — reaches descendants that outlived the prior
leader), then allow only after empty. Unkillable/unreadable cgroup → fail closed. A fully empty prior
run is cleared and the new run allowed.

**Phase 2 escalation (named, deferred):** an independent supervisor's record becomes authoritative
when the CLI cannot acknowledge. Requires the host-app supervisor (blocked precondition) — out of
scope here.

### File impact

- **`src/run-ownership.ts`**: `LEASE_WATCH_INTERVAL_MS`/`LEASE_WATCH_MAX_READ_ERRORS` (+ env overrides),
  `watchLease()`, `ownershipFence()`, `finalizeOwnedRun()`, and lifecycle/cgroup-aware
  `reconcileOnStart()`. Any kill goes through `authorizeLiveRunSignal()` (running CLI, tokened) or
  `authorizeReconcileSignal()` (tokenless stale reconcile) — both act on the durable cgroup identity
  and require the cgroup to be read/killable (else fail closed).
- **`src/interrupted-artifact.ts`**: add idempotent `handleOwnershipLoss(loopSpec)` (marker → two-phase
  terminate per registered group (`SIGTERM -pgid` → `killCgroup`) via `authorizeLiveRunSignal()`
  collecting verified-exit results → **raw-output quarantine** → **survivor gate**: release admission
  only if all cgroups empty, else terminal ownership-failure + retain admission + blocked outcome →
  resolve); `handleInterruptSignal()` shares the same once-flag, ordering, and gate.
- **`src/loops/execution.ts::executeLoopStep()`**: double gate + `watchLease()` start/`finally`-stop +
  `Promise.race([adapter.run(), ownershipLost])` + `ownershipFence()` on the success path; return the
  discriminated `ExecuteLoopStepOutcome`; pass `deps.loopSpec` to `handleOwnershipLoss()`.
- **`src/loop.ts::runLoop()`**: short-circuit on `outcome.kind === 'ownership-lost'` — no artifact
  parse/`writeArtifactWithMeta()`/next-step.
- **`src/commands/smash.ts`**: thread `OwnershipContext` into `runLoop()`; wrap in
  `finalizeOwnedRun()`; map the `'ownership-lost'` `LoopReturn` to the distinct exit code.

### Verification (named in-repo tests)

- **`tests/ownership-expiry.inflight.test.ts`** — uses **fake time**: (a) a **blocked** fake adapter
  run is terminated within `LEASE_WATCH_INTERVAL_MS` of expiry; `handleOwnershipLoss()` writes the
  marker, kills the registered group, releases the lock, returns `'ownership-lost'` with no next step;
  (b) `LEASE_WATCH_MAX_READ_ERRORS` consecutive read failures resolve `expired` (fail closed).
- **`tests/ownership-expiry.completion-fence.test.ts`** — for **audit, follow-up, and implement**
  kinds: the adapter resolves after `leaseExpiresMs` but before the next watcher tick; assert
  `ownershipFence()` detects expiry, `handleOwnershipLoss()` runs, the result is `'ownership-lost'`,
  and `runLoop()` performs **no provenance/state advancement**.
- **`tests/ownership-expiry.raw-artifact.test.ts`** — the provider writes a raw
  `docs/dev/*-vN-*.md` just before expiry; on **both** the watcher-fired and completion-fence paths,
  assert the file is **absent from `docs/dev/`** (present under `docs/dev/archived/`) for audit,
  follow-up, and implement kinds — proving nothing resumable is left.
- **`tests/ownership-loss.survivor-gate.test.ts`** (Linux + cgroup-v2-gated): an unkillable member
  (simulated `D`-state, or a cgroup that cannot be read/killed) survives; assert `handleOwnershipLoss()`
  / finalization writes a terminal ownership-failure state, **retains admission**, returns the blocked
  outcome, and a subsequent app-owned launch with a **distinct `runId`** is **not admitted**; no late
  descendant write can escape the quarantine boundary.
- **`tests/run-ownership.terminal-paths.test.ts`** — command-level terminal matrix: REJECTED at
  iteration ceiling, terminal `unknown`, missing artifact, interactive stop, and an exception after
  `confirmGroupClosed()`; assert each reaches the right terminal state (`failed`/`stopped`) with no
  active group, admission released; a subsequent app-owned launch with a **distinct `runId`** for the
  same canonical root is admitted.
- **`tests/ownership-recovery.e2e.test.ts`** (Linux + cgroup-v2-gated) — the remaining race-table rows
  via the fixture issuer, using **distinct old/new run IDs and tokens**. SIGKILL-row reconciliation:
  prior run's cgroup **non-empty** (incl. a descendant that outlived the prior leader) → tokenless
  `authorizeReconcileSignal()` + `killCgroup()` then allow when empty; cgroup **empty** → clear+allow;
  unkillable/unreadable cgroup → **fail closed**. Lifecycle crash points (registered-not-closed,
  closed-not-terminalized, terminalized). Distinct tokens never substitute (tokenless cgroup-bound
  authority).
- **`tests/ownership-recovery.containment-isolation.test.ts`** (Linux + cgroup-v2-gated): an
  unrelated process/group is **not** in the per-run cgroup; assert it is never signalled or killed by
  `confirmGroupClosed()`/`handleOwnershipLoss()`/`reconcileOnStart()` (only `cgroup.procs` members are
  touched), and the cgroup cannot be reused/recycled while the run holds it.
- **`tests/ownership-reconcile-boundary.test.ts`** — API-level negative tests: `handleOwnershipLoss()`
  routes only through `authorizeLiveRunSignal()` (tokened) and **cannot** reach
  `authorizeReconcileSignal()`; `authorizeReconcileSignal()` rejects a current **live** run (holder
  alive) and requires a verified-dead prior holder + private run dir + validated cgroup identity. A live
  run with a mismatched/missing token is **not** killed tokenlessly; a dead prior holder with a valid,
  leader-gone cgroup is reconciled without leader revalidation.
- **`tests/process-group.cgroup-validation.test.ts`** (Linux + cgroup-v2-gated) — corrupt
  `active.json` to name (a) an outside-root cgroup, (b) a sibling run cgroup, (c) a deleted/recreated
  cgroup at the expected path, and (d) an unrelated populated cgroup. Every case returns ownership
  failure, retains admission, and performs **no** `cgroup.kill` write. A valid leader-gone cgroup for a
  dead prior holder is killed successfully.
- **`tests/process-group.capability.test.ts`** (Linux + cgroup-v2-gated) — the probe starts a helper
  that self-joins its test cgroup, verifies membership and `cgroup.kill`, then reaps the helper and
  removes the test hierarchy. Failure at any stage rejects app-owned mode before wrapper spawn.
- **`tests/run-ownership.cross-process-lock.test.ts`** — distinct run IDs, same canonical root (§1).
- **`tests/process-group.bootstrap.test.ts`** / **`tests/process-group.fault-injection.test.ts`** (§2).
- Regression: terminal CLI execution without ownership options keeps current behavior and signal
  cleanup (extend existing smash/signal coverage).
- `npm run typecheck`, `npm test` on macOS/Linux (CI). Windows app-owned mode covered by
  reject-before-spawn, not execution.

### Non-goals

- Do not claim the CLI prevents a provider from writing its own declared file; claim only no
  provenance/state advancement plus immediate quarantine of the raw output.
- Do not let a new run's token stand in for a prior run's token — stale reconciliation is tokenless,
  cgroup-bound; token validation is mandatory for live-run termination only.
- Do not use a recyclable PGID as the authoritative kill identity (use the durable cgroup). Do not
  auto-restart a failed/killed run, and do not implement the independent supervisor (Phase 2).

### Next audit boundary

The Phase 1 architecture decision is settled: **app-owned mode is Linux with a writable delegated
cgroup-v2 hierarchy only**; unsupported environments reject before spawn. A follow-up may change this
decision only with an explicit product decision, not as an audit remediation. The next plan audit must
assess only whether this chosen cgroup design is internally consistent and safely handles corrupt,
sibling, outside-root, and recreated cgroup paths. It must not reopen portability, host-supervisor, or
non-cgroup containment alternatives.

## Status display boundary (status modules)

`src/status.ts` is a **pure presentation** module (message + `PanelContext` builders); it owns no I/O.
`src/commands/status.ts` is the **read-only CLI command**. The read boundary is fixed:

- Terminal `orc status` reads **only** the in-project `.orc-smash/interrupted.json` marker (via
  `readInterruptedMarker`). It **never** reads the host-private ownership directory; `control.json`/
  `active.json`/`project.json` are not status sources for the terminal CLI.
- **Display contract:** Phase 1 shows only the marker's interrupted facts through the existing
  `assembleInterruptedMessage()` (`src/status.ts`) and `scanForStatus()` timeline merge (`src/state.ts`);
  no synthetic success state enters the decision-path `scan()` (ownership-quarantined raw output is
  archived, so it is never scanned). The richer ownership-loss surface (run id, group identities, last
  heartbeat, termination outcome) is a **Phase 2 host-app UI**, not claimed by the terminal CLI.

No change to marker-first status-loop selection (`marker.loop` precedence in `commands/status.ts`).

## Release gate

Two tiers so structural plumbing cannot pass it:

**Tier 1 — in-repo, mandatory for approval (Linux with delegated cgroup-v2):**
- **One app-owned run per canonical project**, enforced by a project-keyed admission lock: two
  `openOwnedRun()` calls with **distinct `runId`s** for the same realpath/symlinked root → second
  rejected; dead holders reclaimed; issuer heartbeats continue while locked.
- A **blocked** adapter run is terminated within one watch interval of expiry; a provider that
  **finishes at/after expiry** is fenced (`ownershipFence`) so there is **no provenance/state
  advancement**; in both cases the **raw output is quarantined** (absent from `docs/dev/`, present in
  `docs/dev/archived/`) — verified for audit, follow-up, and implement paths.
- The bootstrap barrier proves every exec'd provider is registered before run; the **POSIX-shell
  wrapper performs a real `exec` handoff** (the pid reported before ACK is the pid running the provider
  after ACK) and shares SID/PGID; fault-injection crashes at spawn/persist/release leave **no**
  surviving or untracked provider/grandchild.
- The durable lifecycle reaches a terminal state for **every** outcome (`completeRun`/`failRun`/
  `stopRun`) via the finalization layer, releasing admission safely; terminal-path matrix (REJECTED
  ceiling, unknown, missing artifact, interactive stop, exception) followed by a distinct-run-ID
  relaunch succeeds; lifecycle crash points reconcile safely.
- **The whole provider tree — including a descendant that outlives the leader — is stopped on lease
  loss**, via durable per-run cgroup-v2 containment (`cgroup.kill`), which is leader-independent,
  race-free, and reuse-immune; `confirmGroupClosed`/`handleOwnershipLoss`/finalization/reconcile all
  kill via the cgroup and release admission only when it is empty (unkillable → terminal
  ownership-failure that retains admission + documented recovery). App-owned mode is **Linux +
  delegated cgroup-v2 only**; macOS/Windows/non-delegated Linux reject before spawn. Stale
  reconciliation is **tokenless + cgroup-bound** (token validation is mandatory for live-run
  termination only); the boundary is enforced by `tests/ownership-reconcile-boundary.test.ts`,
  leader-gone-descendant-stopped by `tests/process-group.descendant-stopped.test.ts`, and containment
  isolation by `tests/ownership-recovery.containment-isolation.test.ts`.
- Only an authenticated, selected record (`runId` + `sha256(token)===ownerTokenHash` + canonical root)
  enables app-owned mode; partial/mismatched/ambiguous launches fail closed (no silent terminal
  fallback); the plaintext token is never stored.
- Tampered/stale/loosened-permission/PID-reuse records fail closed and issue no signal.
- Every cgroup read/kill validates the deterministic `<delegatedRoot>/orc-smash/<runId>` path and its
  recorded creation identity. Outside-root, sibling, malformed, missing, or recreated paths fail closed
  with no `cgroup.kill`; stale leader-gone runs are reconciled through a valid cgroup without requiring a
  leader PID.
- `OwnershipContext`/`SpawnRuntime` reach all four adapters (codex/claude/agy/opencode); terminal mode
  and Windows rejection unchanged across all platforms.
- `npm run typecheck` and `npm test` pass.

**Tier 2 — DEFERRED / BLOCKED (not claimable from this repo):**
- A deliberate **host-app** crash observed by an **independent supervisor** that survives the crash,
  killing the CLI/provider tree, preventing all subsequent steps, recording an interrupted outcome, and
  allowing safe later reconciliation. **Blocked on naming a host-app repo/package and its launcher,
  supervisor, and status-surface paths.** Until then, no production crash-safety claim for
  app-launched runs beyond the CLI-self-terminated Phase 1 guarantees above.

## Next step

Rerun `21-simple-plans-audit`. Approval covers **Phase 1 only**; Tier 2 remains a tracked, explicitly
blocked dependency, not an implicit promise.
