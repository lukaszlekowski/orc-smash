---
status: blocked
confidence: 0.97
owners: runtime-packaging
platform: macos-primary
---

# Canonical `orc` Runtime and Supervisor Compatibility Repair

## Summary

Make `bin/orc.js` the single stable production command for ordinary and supervised
runs. It will load the compiled CLI in the same Node process, eliminating the
wrapper/inner-PID mismatch. Add an explicit compatibility handshake, harden the
supervisor host client, and rerun the cross-repository macOS gate against the exact
documented installation path.

No ownership schema, lease, signal-gate, provider-adapter, or cgroup behavior changes.

## Implementation Changes

### `orc-smash`: canonical production runtime

- Add an explicit `pnpm build` that cleans `dist/`, compiles production `src/` only,
  and copies `config/`, `roles/`, `skills/`, `skills.yaml`, `package.json`, and
  `process-group-bootstrap.mjs`.
- Keep `bin/orc.js` as the stable package binary, but replace `spawnSync(tsx, ...)`
  with a same-process import of `dist/src/cli.js`. If build output is missing, exit
  with a clear `run pnpm build` error.
- Export an async CLI `main(argv)` and use it from both the compiled entrypoint and
  stable bin wrapper. Add `pnpm dev` for `tsx src/cli.ts`; set package `main` to the
  compiled CLI.
- Add `orc supervisor-contract`, returning exactly:

  ```json
  {
    "kind": "orc-smash-supervisor-contract",
    "schemaVersion": 1,
    "ownershipSchemaVersion": 1,
    "pid": 12345
  }
  ```

  The reported PID must be the process executing `bin/orc.js`.
- Keep the existing owned-run protocol unchanged. Preserve unrelated user changes
  and do not rewrite archived development artifacts.

### `orc-smash-supervisor`: validated install and reliable host client

- Before changing config or restarting the LaunchAgent, require an absolute,
  non-symlinked regular-file `orc` path and run:

  ```sh
  node <orc-path> supervisor-contract
  ```

- Strictly validate the JSON contract, ownership schema version, successful exit,
  bounded output, and that the reported PID equals the installer-spawned PID. A
  failed check must leave the existing config and service untouched.
- Continue storing the stable `/Volumes/projects/orc-smash/bin/orc.js` path after
  validation; do not expose `dist/src/cli.js` as the public install path.
- Refactor `SupervisorClient` to use one persistent frame parser with a FIFO message
  queue and pending-receiver queue. Preserve multiple frames received in one chunk,
  reject pending receivers on close/error, and remove timed-out receivers cleanly.
- Define the initial launch-response timeout as:

  ```text
  LAUNCH_READY_TIMEOUT_MS
  + (2 x TERM_KILL_GRACE_MS)
  + 5,000 ms margin
  ```

  Server launch errors must reach the CLI instead of being masked by a 10-second
  client timeout.
- Run heartbeats sequentially using the interval returned by `accepted`; consume and
  validate every acknowledgement. Stop nonzero on heartbeat rejection or transport
  failure. Make signal-triggered cancellation idempotent and consume its own response.
- Fix deterministic restart-test cleanup by retaining an out-of-band fixture handle
  and terminating only that exact test child in `finally`. Do not weaken the
  production rule against signalling durable post-restart identities.

### Cross-repository pin, docs, and rollout

- Commit the `orc-smash` runtime/build repair first and update the supervisor's pinned
  SHA to that immutable commit.
- Update both READMEs, architecture docs, and compatibility rules to document:

  ```sh
  cd /Volumes/projects/orc-smash
  pnpm build

  cd /Volumes/projects/orc-smash-supervisor
  pnpm build
  node bin/orc-smash-supervisor.js install \
    /Volumes/projects/orc-smash/bin/orc.js
  ```

- Change the release harness to call the official `orc-smash` build, validate the
  handshake, and run the live gate through the built worktree's `bin/orc.js`, the
  exact documented entrypoint.
- Mark release status `NOT RERUN` after production changes. After all checks pass,
  reinstall the user LaunchAgent, verify `status`, rerun the live gate once, and
  record `VERIFIED`.
- Historical failed supervisor records remain as diagnostics; the already-released
  `stock-screener` admission needs no migration.
- Existing orphaned `stub-orc.cjs` test fixtures are not killed automatically. Any
  one-time cleanup requires separate approval and exact PID/path verification, never
  a broad `pkill`.

## Test Plan

### `orc-smash`

- Build from a clean checkout and verify every runtime asset exists under `dist/`.
- Prove `node bin/orc.js supervisor-contract` reports the spawned process PID.
- Prove the former `tsx` child-wrapper implementation fails the PID contract.
- Run the compiled CLI for normal commands and confirm behavior matches the
  development CLI.
- Run typecheck, production build, deterministic tests, and add the build step to CI.

### Supervisor

- Installer accepts the new stable `bin/orc.js`.
- Installer rejects the old wrapper, malformed JSON, wrong schema, PID mismatch,
  timeout, symlink, directory, and missing build output without changing active
  configuration.
- Client tests cover partial frames, multiple frames in one chunk, queued receives,
  timeout cleanup, socket errors, sequential heartbeat acknowledgements, and
  cancellation with a heartbeat response in flight.
- A delayed launch failure beyond 10 seconds reaches the host as the real server
  error.
- Deterministic suites leave no new `stub-orc.cjs` processes behind.

### Final acceptance

- The exact documented install command succeeds and restarts the LaunchAgent.
- `launchctl print` reports the service running and supervisor `status` responds.
- Cross-repository readiness proves the captured capability PID equals
  `active.cliIdentity.pid`.
- The real macOS gate passes all five safety scenarios using the stable `bin/orc.js`.
- One final independent review is limited to this compatibility repair; no additional
  planning cycle is required.

## Assumptions and Defaults

- The stable checked-in `bin/orc.js` path is the public production interface; `dist/`
  is an internal build artifact.
- Production execution requires `pnpm build`; no automatic install hook is added.
- Compatibility handshake version and ownership schema both remain `1`.
- The supervisor remains macOS-only and continues to treat durable process records as
  diagnostic evidence, never signal authority.

## Implementation phase checklist

- [x] `bin/orc.js` is the same-process production entrypoint with a compiled `dist/src`
  runtime and packaged assets.
- [x] `supervisor-contract` reports the strict PID/schema handshake and the supervisor
  validates it before installer mutation.
- [x] Supervisor client framing, sequential heartbeats, explicitly serialized
  cancellation, timeout handling, exact fixture cleanup, release-harness build, stable
  entrypoint pinning, and production contract validation are implemented and covered by
  deterministic tests.
- [x] READMEs, architecture guidance, compatibility rules, CI, and release status are
  synchronized with the canonical runtime.
- [ ] The exact documented install/restart command and real macOS LaunchAgent release
  gate have been rerun after this production change.

## Change Log

### v1 — canonical runtime and supervisor compatibility repair — 2026-07-17

- Added the production `pnpm build` and same-process `bin/orc.js` runtime, including
  the strict `supervisor-contract` handshake and packaged asset layout.
- Added installer preflight validation, persistent FIFO client framing, sequential
  acknowledged heartbeats, idempotent cancellation, and the official build path to
  the release harness.
- Updated cross-repository documentation and marked the release record `NOT RERUN`.
- The normal approved-audit prerequisite was waived by the user for this implementation;
  no audit artifact was added or rewritten. The live LaunchAgent install/release gate
  remains pending.

### v2 — rejected-review follow-up repairs — 2026-07-17

- Serialized signal cancellation behind any in-flight heartbeat acknowledgement and
  added a command-level regression test covering repeated signals and one cancel.
- Retained the exact spawned fixture child in the restart test, terminated it in
  `finally`, and added a deterministic suite leak assertion.
- Added `bin/orc.js` to the release manifest and routed the release preflight through
  the production contract validator's PID-comparing probe.
- Deterministic follow-up verification is complete; the exact documented install,
  LaunchAgent restart, and real macOS release gate remain pending.

### v3 — release-provenance and teardown follow-up repairs — 2026-07-17

- Bound release contract validation to the detached supervisor worktree and added
  focused probe-path coverage, so the gate cannot depend on ordinary-checkout `dist/`.
- Made exact fixture termination and leak inspection run even when server teardown
  fails, while preserving teardown failures for the test result.
- Repaired cross-repository commit/pin provenance; deterministic verification remains
  complete and the exact documented install, LaunchAgent restart, and real macOS
  release gate remain pending.
