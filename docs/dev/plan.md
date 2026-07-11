---
status: draft
confidence: 0.96
owners: harness-runtime-and-host-app
---

# Crash-Safe App-Owned Run Supervision

## Goal

Make an app-launched `orc smash` run impossible to continue unattended after the owning app has exited or lost ownership. This is a safety release: no implementation, audit, or follow-up provider may remain runnable after the app crash boundary, and an operator must be able to identify and stop every app-owned run without relying on artifact filenames.

## Scope and invariants

- The host app is the owner of every run it launches. The CLI and every provider descendant belong to one recorded run identity and one cancellable process group.
- A run is identified by an unguessable `runId` and owner token. PID alone is never authority to kill: a supervisor must also validate the recorded token, command identity, and process start time before signalling.
- The host app refreshes an expiring lease. If the lease expires, the CLI must not start another loop step; the supervisor must terminate the CLI/provider process groups immediately.
- Cancellation, normal app shutdown, app crash, and stale-run recovery use the same termination sequence: stop new work, `SIGTERM` all owned process groups, wait a bounded grace period, then `SIGKILL` survivors.
- Provider grandchildren are in scope. Signalling a direct `ChildProcess` is insufficient.
- Run-control records live outside the target project (the host app’s private runtime directory or OS temp directory). They are operational ownership state, not durable workflow state; no lease record participates in artifact scanning or resumption.
- A stale or malformed control record fails closed: it blocks new provider spawns and is surfaced as a terminal ownership failure. It must never cause an unverified PID to be killed.
- One project may have at most one app-owned active run. A second start is rejected until the previous run is proved complete or explicitly terminated.

## 1. Define the host–CLI supervision contract

### Design

Define a versioned run-control schema shared by the host app and this CLI. The host creates the record before it launches `orc`; it supplies the control-record path and owner token through explicit CLI options (not implicit shell environment alone). The record includes:

- `schemaVersion`, `runId`, `ownerToken`, `projectRoot`, and host app instance identity;
- host heartbeat/lease expiry and the host’s expected PID/start identity;
- CLI PID/start identity and each active provider process-group identity;
- lifecycle state (`starting`, `running`, `stopping`, `completed`, `failed`) plus timestamps.

The host app owns a small supervisor that watches the lease independently of the app’s UI/main process. On heartbeat loss it terminates the recorded groups and atomically marks the record stopped. The app must never invoke `orc` directly; it requests runs through this supervisor and receives a run ID plus status events.

The CLI validates the control record and owner token at startup, before every `executeLoopStep`, and immediately before each provider spawn. It reports CLI/provider group registration and completion atomically through the same contract. A valid CLI run without host ownership remains available for normal terminal use; the ownership contract is required only for app-launched runs.

### File impact

- Add `src/run-ownership.ts`: schema validation, token comparison, safe process identity checks, lease reads, lifecycle updates, and a pure `mayStartStep()` decision. This is the single ownership boundary; do not place lease logic in `loop.ts` or adapters.
- Update `src/cli.ts` and `src/commands/smash.ts`: add explicit private ownership options, validate them before configuration/loop work, register CLI lifecycle, and return a structured ownership failure rather than spawning.
- Update `src/loops/execution.ts`: call the ownership gate before publishing `stepStarted` and before adapter selection/spawn.
- Add the host-app supervisor implementation at the app’s actual launcher path (to be identified before implementation). It owns lease heartbeats, exclusive-per-project locking, process-group termination, and restart cleanup.
- Update `README.md`, `docs/architecture/overview.md`, and `AGENTS.md`: document that app ownership state is external operational state and does not alter artifact-driven workflow state.

### Verification

- Unit-test malformed, expired, wrong-token, wrong-project, and PID-reuse control records; each must reject spawning and never issue a signal.
- Unit-test the pure ownership gate at CLI startup and at each step boundary.
- Add an integration contract between host supervisor and CLI proving atomic registration of one run and rejection of a second active run for the same canonical project root.

### Non-goals

- Do not make the CLI persist workflow progress or resume decisions in the control record.
- Do not use `docs/dev/` or `.orc-smash/` as the host lease directory.

## 2. Put every provider run in a terminable process group

### Design

Replace direct-child-only termination with group-aware process ownership on supported Unix hosts. `runProcess()` creates a distinct provider process group/session, registers its group identity before streaming output, and removes it only after confirmed close. Timeout and interrupt cleanup signal the group, not only the direct provider PID.

Group termination must be idempotent and bounded. It must tolerate an already-exited leader, report which groups survived the grace period, and preserve the current durable interrupted-artifact behavior before the CLI exits. Windows support must use an explicit equivalent job-object/process-tree adapter; it must not silently fall back to killing only the direct child.

### File impact

- Refactor `src/adapters/utils.ts` around a purpose-named process-group runtime contract; retain `ProcessRunner` as the deterministic test seam.
- Update `src/interrupted-artifact.ts` to invoke group termination after writing the interrupted marker.
- Update adapter lifecycle types only if group registration must be rendered; provider adapters remain black boxes.
- Add a platform-specific process-group adapter/module only if needed to keep Unix and Windows termination semantics distinct and testable.

### Verification

- Deterministic tests prove timeout, `SIGINT`, `SIGTERM`, and host-initiated cancellation call group termination exactly once and clear active-group state.
- A real child-process test starts a provider-like parent that launches a long-lived descendant; cancellation must leave neither process alive.
- A stale-record cleanup test proves a new app launch terminates only the matching recorded group, never an unrelated process with a reused PID.

### Non-goals

- Do not rely on Node’s default parent/child exit behavior as crash cleanup.
- Do not broaden provider autonomy flags or alter provider command arguments unrelated to group ownership.

## 3. Fail closed across crash, recovery, and concurrent-launch paths

### Design

The host supervisor performs startup reconciliation before enabling a new run for a project: inspect its external control records, validate identity, terminate only verifiably owned stale groups, and retain an auditable status result. The CLI’s lease gate ensures that even if a supervisor cannot kill a provider immediately, no subsequent audit/follow-up/implementation step is started after ownership loss.

When ownership is lost during a step, the CLI writes the existing interrupted marker, exits with a distinct ownership-loss error, and lets normal quarantine-on-rerun protect the declared artifact. The host app presents the run ID, project, PID/group identities, last heartbeat, and termination outcome; it must not claim a run is stopped until the supervisor has observed all owned groups exit.

### File impact

- Extend `src/interrupted-artifact.ts`, `src/commands/status.ts`, and `src/status.ts` with a display-only ownership-loss reason while keeping decision-path scans free of synthetic success state.
- Add ownership-aware structured errors in `src/adapters/errors.ts` / command result rendering as needed.
- Add host-app status/recovery UI at the app’s actual run-management surface (path to be identified before implementation).

### Verification

- End-to-end fixture: app launches a multi-step rejected chain, then its heartbeat stops mid-provider; assert provider tree termination, interrupted marker creation, no next follow-up/audit file, and no new source edits after termination.
- End-to-end fixture: app restart finds an expired run, performs safe reconciliation, and permits exactly one new run only after prior groups exit.
- Regression: ordinary terminal CLI execution without ownership options retains its current behavior and signal cleanup.
- Run `npm run typecheck`, `npm test`, and the host-app integration suite on macOS; add Windows process-tree coverage before declaring cross-platform support.

### Non-goals

- Do not auto-delete artifacts produced before ownership loss; existing quarantine and terminal-unknown rules remain authoritative.
- Do not auto-restart a failed or killed agent run.

## Release gate

This work is not complete until a deliberate host-app crash during an active provider step demonstrably kills the CLI/provider tree, prevents all subsequent loop steps, records an interrupted outcome, and allows a later app launch to reconcile safely without touching unrelated processes.
