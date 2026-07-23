# orc-smash

orc-smash is a stateless TypeScript subprocess harness for coding-agent CLIs:
`opencode`, `codex`, `claude`, and `agy` are real provider adapters, while
`fake` is test-only. The harness selects a provider per configured skill,
invokes it over stdio, validates the declared artifact, and reconstructs state
from project files. It never calls a model API directly and keeps no runtime
database.

The active contract is [docs/dev/plan.md](./docs/dev/plan.md). The single v1
manifest is `config/orc-smash.yaml`, optionally overridden by
`<project>/.orc-smash.yaml` or an explicit `--config <path>` (highest
precedence). `skills.yaml` and the old fixed workflow are not supported.

## Setup

```bash
pnpm install
pnpm build
```

`bin/orc.js` is the stable production entrypoint. Run `pnpm build` before
production execution; it packages the manifest, provider catalogues, roles,
skills, and process-group bootstrap. `dist/src/cli.js` is an internal build
artifact, not the public install path.

## Commands & Interactive Operator Surface

```bash
orc smash --project <path>                         # interactive menu with startup snapshot
orc smash --project <path> --loop <loop-id>        # ad-hoc approval loop
orc smash --project <path> --task <task-id>        # ad-hoc one-off task
orc smash --project <path> --pipeline <pipeline>   # explicit pipeline start
orc smash --project <path> --plain --task <task-id>
orc status --project <path> [--all] [--config <path>]
```

On launch, interactive `orc smash` renders a compact startup snapshot displaying the project root, config path, configured pipelines, suggested loop & reason, and a compact per-binding state summary (binding kind, target path, latest evaluate/repair/task steps with decision/outcome, provider/model, effort, session strategy/ID, missing inputs, and unclassified count).

All interactive choices use a standardized `(unavailable: reason)` label with boolean `disabled: true`. `Execute one-off task` opens a generic task chooser listing all configured tasks, followed by a task detail confirmation. Pressing `Back` on task detail returns to the task chooser, while pressing `Back` on the chooser returns to the main menu without re-scanning or re-printing the startup header.

Runner selection is independent per skill. Global overrides are
`--agent`, `--model`, and `--effort`; repeatable per-skill overrides are
`--runner skill=provider`, `--runner-model skill=model`, and
`--runner-effort skill=level`. Models are validated in their provider's own
namespace, and changing provider re-defaults its model.

The default panel uses an alternate screen. `--plain` emits an append-only,
typed event stream suitable for logs and CI. A direct loop or task is ad hoc
and has no inferred pipeline identity. Only an explicit pipeline start or a
later operator-confirmed suggested-stage action can carry pipeline identity
forward; downstream stages never start automatically.

## Manifest model

The manifest declares reusable skills and roles, approval-loop bindings,
one-off task bindings, and linear pipelines. Each binding owns its target,
named project-file inputs, prompt inputs, output pattern, output contract, and
runner profile. Output patterns use `{version}` and `{provider}` and resolve
under the selected project root. Roles and skill files resolve under the
manifest root. Missing project inputs are recorded in the global snapshot and
fail execution preflight without admitting ownership or spawning a provider.

Decision artifacts normalize configured tokens to `accepted`, `retry`, or
`unknown`. Completion artifacts require exactly one `## Outcome` section whose
first non-blank line is exactly `COMPLETED` or `BLOCKED`. Unknown evidence is
terminal; repair runs only after a concrete `retry` decision.

Artifacts persist pipeline/run/stage/chain identity, parent lineage, runner and
session provenance, input fingerprints, and target result fingerprints. Legacy
files without the v1 identity contract are unclassified and never advance a
stage or provide resume evidence. The generic index scans every configured
loop/task output and ignores `docs/dev/archived/`.

## Providers and safety

Providers are opaque native binaries behind `AgentAdapter`. Headless writes
use each provider's autonomy flag. Watchdogs are config-driven: opencode uses
`OPENCODE_RUN_TIMEOUT_MS` > `timeouts.opencode` > its 10-minute default;
claude, codex, and agy default to no watchdog unless configured.

`SIGINT`/`SIGTERM` writes a marker under the active project root, terminates
active children through the authorized process-group kill gate, and exits with
the conventional signal code. A rerun quarantines partial and late artifacts
before scanning. App-owned runs use `ORC_RUN_ID`, `ORC_RUN_TOKEN`,
`ORC_RUN_STATE_DIR`, lease records, and portable POSIX process groups. Every
group signal is identity-gated; unverifiable or recycled groups are never
signalled. Retained ownership is diagnosed with `orc ownership status` and
released only with explicit operator verification via `orc ownership release`.

The companion `orc-smash-supervisor` is a separate per-user macOS LaunchAgent.
orc-smash does not import or depend on it, and ordinary `orc smash` invocations
are not supervised. The supervisor launches the pinned absolute
`bin/orc.js`; changes to the shared ownership or launcher contract require
coordinated cross-repository verification.

## Verification

```bash
pnpm typecheck
pnpm test
```

Deterministic tests use the test-only `fake` adapter. `opencode`, `codex`, and
`claude` have env-gated real-provider contract suites. `agy` has deterministic
adapter/seam coverage and is manually verified from an authenticated shell.

See [docs/architecture/overview.md](./docs/architecture/overview.md) for the
architecture, the active audited [docs/dev/plan.md](./docs/dev/plan.md) for
planned work, and [AGENTS.md](./AGENTS.md) for repository invariants.
