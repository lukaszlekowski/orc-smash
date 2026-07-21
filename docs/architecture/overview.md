# orc-smash architecture

orc-smash is a stateless subprocess harness. It selects configured coding-agent
CLI invocations, runs them through provider adapters, validates their outputs,
and reconstructs workflow state from project artifacts. It never imports a
provider runtime or calls a model API. The active design contract is
[`docs/dev/plan.md`](../dev/plan.md); [`AGENTS.md`](../../AGENTS.md) preserves
the safety and supervisor invariants that apply during the migration.

## Runtime shape

```text
bin/orc.js
  └─ src/cli.ts
      ├─ commands/smash.ts ── config.ts ── manifest.ts
      │       ├─ runner.ts / runner-overrides.ts / interactive.ts
      │       ├─ loop.ts ── loops/binding-engine.ts
      │       │              └─ loops/execution.ts ── adapters/*
      │       ├─ binding-inputs.ts / target-snapshot.ts / pipeline-state.ts
      │       ├─ provenance.ts / artifact-contract.ts / state.ts
      │       └─ interrupted-artifact.ts / run-ownership.ts / kill-gate.ts
      └─ commands/status.ts ── state.ts ── status*.ts
```

The manifest is one v1 format: packaged `config/orc-smash.yaml`, optional
project `.orc-smash.yaml`, or explicit `--config`. Generic skills reference
roles, files, and runner profiles. Approval loops have `evaluate` and `repair`
steps; tasks run once; pipelines are linear stage instances referencing loops
or tasks. The binding, not the skill name, determines the output contract and
step semantics.

Configuration-owned role and skill definitions resolve from `manifestRoot`.
Targets, named project inputs, and rendered output paths resolve from
`projectRoot`. Project inputs may be missing at manifest load; the global
snapshot records them and command preflight reports `input.missing` before
ownership admission or provider spawn. Output patterns are validated and use
`{version}` and `{provider}` only.

## Execution and durable state

`loops/binding-engine.ts` is the one executor for both approval loops and tasks.
`loops/execution.ts` is the one provider-step seam. A loop follows:

```text
evaluate ── accepted ── completed
    └──── retry ── repair ── evaluate
```

Configured decision tokens normalize to `accepted`, `retry`, or `unknown`.
Unknown output, transport failure, invalid provenance, or invalid contracts
stop safely; repair is allowed only after `retry`. Completion artifacts require
exactly one `## Outcome` section with `COMPLETED` or `BLOCKED`.

Artifacts are the state store. v1 provenance records binding identity,
pipeline/run/stage identity, chain mode and identity, immediate parent,
provider/model/effort, session strategy and session ID, input fingerprint, and
post-step target result fingerprint. `binding-inputs.ts` owns canonical prior
artifact snapshots. `target-snapshot.ts` captures file content or the complete
visible worktree (including staged, unstaged, and untracked content while
excluding configured harness artifacts). `pipeline-state.ts` owns identity,
fingerprinting, predecessor resolution, and pure eligibility rules.

Ad-hoc loop/task starts have null pipeline fields. Explicit pipeline starts
mint a pipeline run and first stage identity. Only an operator-confirmed
suggested-stage action may continue an existing run; there is no automatic
downstream transition. Artifacts without the v1 identity contract are
unclassified and cannot provide completion, continuation, or resume evidence.

`state.ts` scans every configured loop/task output pattern into one global
snapshot, classifies each artifact through `artifact-contract.ts`, sorts the
timeline chronologically, validates lineage, and ignores `docs/dev/archived/`.
Status may filter the global result for display, but filtering does not change
what the index knows.

## Runner and provider boundaries

Each selected skill resolves an independent provider/model/effort tuple using
the precedence defined in `docs/dev/plan.md`. The production registry contains
only `opencode`, `codex`, `claude`, and `agy`; the deterministic `fake` adapter
exists only in the test registry. Provider-specific model namespaces,
autonomy flags, stream parsing, auth detection, watchdog behavior, and session
arguments stay behind adapters. Continuity is capability-driven by
`resumeSession`; no provider-name allowlist, `--last`, or shell history is
used. `agy` reports no resume capability and strictly accepts configured human
readable model names.

Typed events in `run-event.ts` are the canonical lifecycle stream consumed by
plain and panel output. Provider and harness diagnostics are separate debug
evidence. Every recoverable failure has a visible event; terminal outcomes are
mapped once at the command boundary.

## Interrupts and ownership

`interrupted-artifact.ts` owns the active project root, step context, durable
marker, pre-scan quarantine, and late-artifact quarantine. `SIGINT` and
`SIGTERM` terminate active provider children through `adapters/utils.ts` and
leave a marker that a later run handles before state resolution.

App-owned launches are admitted only with the authenticated
`ORC_RUN_ID`/`ORC_RUN_TOKEN` protocol and optional `ORC_RUN_STATE_DIR`.
`run-ownership.ts` owns admission, `control.json`, `active.json`, lease timing,
process capability records, and finalization. `owned-runtime-registry.ts`
keeps the live capabilities created by the current CLI.

The only negative-PID signal in the CLI is routed through
`kill-gate.ts`. The gate rejects forbidden PGIDs, resolves the CLI's own group
through `ps`, and identity-authorizes every real signal against the recorded
leader. An unverifiable, recycled, or foreign group is never signalled: the
run fail-closes and retains admission for operator recovery. Portable POSIX
process groups are used because cgroup-v2 is unavailable on macOS. A detached
descendant that creates another session remains an accepted residual risk; it
is not chased by unsafe group inference.

Recovery is diagnostic and no-signal: `orc ownership status --project <path>`
prints evidence, and `orc ownership release --project <path> --yes` marks the
matching run `failed: operator-released` before removing its admission lock.

## Companion macOS supervisor

`orc-smash-supervisor` is a separate per-user LaunchAgent and is not imported
by this repository. It launches the pinned absolute `bin/orc.js` through the
authenticated ownership protocol and renews the lease while its host client is
healthy. Ordinary `orc smash` invocations remain unsupervised.

The supervisor is the sole writer of `control.json`; orc-smash writes
`active.json`, admission, markers, quarantine, provenance, and workflow
artifacts. Durable macOS records never gain unattended signal authority, and
the supervisor never reconstructs a lost in-memory kill capability after a
restart. Any change to run IDs/tokens, state paths, lease semantics, process
identity, launcher arguments, or kill-gate behavior requires coordinated
cross-repository verification and a new pinned launcher commit.

## Verification

```bash
pnpm typecheck
pnpm test
```

The deterministic suite proves harness behavior with `fake`, including mixed
runners and target isolation. Real `opencode`, `codex`, and `claude` paths are
env-gated contract checks. `agy` is covered by deterministic seams and manual
verification from an already-authenticated shell. `pnpm build` is required
before production execution.
