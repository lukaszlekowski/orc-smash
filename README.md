# orc-smash

orc-smash is a stateless TypeScript subprocess harness for coding-agent CLIs:
`opencode`, `codex`, `claude`, and `agy` are real provider adapters, while
`fake` is test-only. The harness selects a provider per configured skill,
invokes it over stdio, validates the declared artifact, and reconstructs state
from project files. It never calls a model API directly and keeps no runtime
database.

Binding-aware pipeline stage state and lineage are part of the current runtime.
The completed Batch 5 contract adds configured Tasks and an agent-run Commit
task, and the optional research-first Batch 6 contract adds a research loop
and plan-creation task; the Batch 8 contract adds the paired planning set —
`docs/dev/spec.md` as the acceptance source and `docs/dev/plan.md` as the
delivery and closeout source — audited by the plan loop through a named
`specPath` input, in
[docs/dev/plan.md](./docs/dev/plan.md). The single v1 manifest is
`config/orc-smash.yaml`, optionally overridden by
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
orc smash --project <path> --show-fingerprints
orc status --project <path> [--all] [--config <path>]
orc status --project <path> --show-fingerprints
```

On launch, interactive `orc smash` renders a compact startup snapshot displaying the project root, config path, configured pipelines, suggested loop & reason, and a compact per-binding state summary (binding kind, target path, latest evaluate/repair/task steps with decision/outcome, provider/model, effort, session strategy/ID, missing inputs, and unclassified count).

Every operator-facing surface consumes one shared semantic terminal styling vocabulary (`terminal-accent.ts`). Statuses, decisions, warnings, availability, and lifecycle states use consistent accents across compact snapshots, interactive menus, the live status panel, detailed project status (`orc status`), and line-oriented plain-mode event output. Output remains 100% complete and understandable when colour is unsupported or disabled (`NO_COLOR=1`, non-TTY, or piped execution emit zero ANSI escape codes).

All interactive choices use a standardized `(unavailable: reason)` label with boolean `disabled: true`. Unavailable choices, missing input blockers, and recommendations carry explicit, typed availability categories (`available`, `unavailable`, `missing-inputs`). **Tasks** opens a generic task chooser listing all configured tasks in manifest declaration order, followed by a task detail confirmation. Entering or re-entering Tasks performs one fresh state scan before its rows are rendered. If an eligible pipeline continuation exists, confirmation shows the configured pipeline and predecessor/successor stages and warns that the task may invalidate the suggestion; the warning is advisory and never disables the task. Pressing **Cancel — back to Tasks** returns to the rescanned chooser, while **Back to main menu** returns to the main action surface.

The packaged `commit` task is an ordinary provider-run task using the
`50-simple-commit` skill. It may create exactly one local commit for a clear
operator-selected scope, preserves unrelated changes, uses explicit-path
staging, leaves hooks enabled, never contacts a remote or runs direct tests,
and writes a normal `docs/dev/commit-vN-provider.md` completion artifact. Git
commit creation is performed by the selected agent; the harness does not own
or verify the commit beyond the declared task artifact contract. The artifact
is expected to remain as uncommitted evidence after a successful task.

Both interactive **Display pipeline and project state** and `orc status --project <path>` include a manifest-derived **Prompt Contracts** section. The contract details how each prompt recipe is assembled (role ID & path, skill ID & path, ordered inputs with typed resolution annotations, output pattern, output contract, decision tokens, and validator) without performing content reads or printing source file contents.

Pipeline eligibility is phase-specific: only a classified `evaluate` artifact
whose normalized decision is `accepted` unlocks the next stage of an approval
loop. A completed or valid repair is resumable evidence for another evaluation,
never successor evidence; task progression remains contract-specific. Status and
execution use typed reasons for target drift, consumed edges, missing
fingerprints, and other unavailable evidence.

Runner selection is independent per skill. Global overrides are
`--agent`, `--model`, and `--effort`; repeatable per-skill overrides are
`--runner skill=provider`, `--runner-model skill=model`, and
`--runner-effort skill=level`. Models are validated in their provider's own
namespace, and changing provider re-defaults its model.

The default live panel uses nine operational timeline columns: version, role,
agent, model, effort, result, time, session, and status. Add
`--show-fingerprints` to either command to show the four diagnostic fields
(`Artifact`, `Parent`, `Input FP`, and `Result FP`) in their existing wide-table
form, or as one compact identity/fingerprint line beneath each row on narrow
terminals. Detailed status keeps semantic stale, drift, and missing-evidence
reasons visible by default; the flag only restores their raw identity and
fingerprint values. The choice is per invocation and is not persisted. The
default panel uses an alternate screen. `--plain` emits an append-only,
typed event stream suitable for logs and CI; it remains complete and unchanged
when the flag is supplied. A direct loop or task is ad hoc
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

One-off tasks are operator-controlled and remain runnable at every pipeline
position. A task does not consume a suggested stage or automatically advance
the pipeline. A task that changes the worktree may make an existing
predecessor continuation stale; the next stage can then be run ad hoc and
existing project-state reconstruction reports the resulting target drift.

The packaged manifest preserves the `default` pipeline as
`plan → implement → review`. It also declares an optional
`research-first` pipeline: `research → create-plan → plan → implement → review`.
The research approval loop and `create-plan` task are ordinary generic
bindings. Research is never a prerequisite for the default pipeline, and every
stage transition remains operator-confirmed; no downstream stage starts
automatically. When approved research exists, its applicable non-negotiables
are traced into the spec and plan; optional research is never made mandatory.

The `plan` loop keeps `docs/dev/plan.md` as its target and audits
`docs/dev/spec.md` as one set through the named `specPath` file input;
`implement` and `review` declare both `specPath` and `planPath`, so missing
either document fails the generic missing-input preflight before a provider is
spawned. A plan-only project migrates with the ordinary `create-spec` task,
which preserves the plan byte-for-byte and requires a fresh joint plan
approval before implementation or review.

Second opinions remain fresh chains with no inherited provider session, and
artifact version never defines second-opinion semantics: a v2 evaluation can
be the ordinary audit after a v1 repair, while a second opinion is a fresh
chain whose prior artifact is `none`. Packaged skills assess current documents
independently and treat a supplied prior artifact as repair/comparison
evidence, never authority.

Decision artifacts normalize configured tokens to `accepted`, `retry`, or
`unknown`. Completion artifacts require exactly one `## Outcome` section whose
first non-blank line is exactly `COMPLETED` or `BLOCKED`. Unknown evidence is
terminal; repair runs only after a concrete `retry` decision. The shared
body-based classifier is used both after a provider run and during restart
scans, independently of provenance parsing. The named implementation-ledger
validator distinguishes `valid`, structurally classifiable `blocked` (with
bounded table/row diagnostics), and malformed `unknown`; blocked ledgers are
durable evidence but never unlock a pipeline successor.

When an interactive, non-plain run produces a qualified decision line such as
`REJECTED (narrow)`, the operator may explicitly choose one configured
canonical token. The replacement is validated before the untouched raw output
is archived, the active artifact receives normal provenance plus the correction
record, and the correction is visible in both event renderers. Declining,
ambiguous output, explicit CLI runs, and `--plain` runs fail closed with the
recoverable raw evidence and do not invoke the provider again.

Artifacts persist pipeline/run/stage/chain identity, parent lineage, runner and
session provenance, input fingerprints, and target result fingerprints. Legacy
files without the v1 identity contract are unclassified and never advance a
stage or provide resume evidence. The generic index scans every configured
loop/task output and ignores `docs/dev/archived/`. Exact predecessor edges are
single-use, while distinct accepted chains remain independent candidates.
Historical continuation is validated from its recorded binding, phase, and
parent identity; later unrelated activity or target drift does not rewrite
already-classified lineage.

The recorded `resultFingerprint` is the digest of the binding target plus every
declared `files:` project-file dependency (a canonical binding snapshot),
while the v1 provenance field name and the typed stale reasons
(`target-fingerprint-drift` / `missing-target-fingerprint`) are preserved.
Editing only `spec.md` stales accepted plan evidence; restoring the accepted
bytes restores eligibility; unrelated files do not stale a file-target plan
stage. Legacy target-only result fingerprints fail closed as stale and are
never migrated.

## Providers and safety

Providers are opaque native binaries behind `AgentAdapter`. Headless writes
use each provider's autonomy flag. Watchdogs are config-driven: opencode uses
`OPENCODE_RUN_TIMEOUT_MS` > `timeouts.opencode` > its 10-minute default;
claude, codex, and agy default to no watchdog unless configured. Progress
telemetry is an optional adapter capability (`structured` for `opencode`,
`codex`, and `claude`; `unavailable` for `agy`), carried generically through
live and plain event views without affecting workflow state or watchdog
deadlines.

AGY fresh invocations bind the canonical target with `cwd` plus `--new-project`.
Resumption uses the exact `--project`/`--conversation` pair from its opaque
`agy:v1:<project-uuid>:<conversation-uuid>` session token; it never uses
`--continue`. The pair is parsed from a unique temporary `--log-file`, which is
cleaned after terminal results. AGY exposes logical model slugs and separate
Gemini effort choices; provider default omits `--effort`.

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
`claude` have env-gated real-provider contract suites. AGY has deterministic
adapter/seam coverage and an explicitly gated authenticated target/decoy contract:

```bash
ORC_AGY_AUTHENTICATED_CONTRACT=1 \
ORC_AGY_CONTRACT_EVIDENCE=/tmp/orc-smash-agy-evidence.json \
pnpm vitest run tests/agy-authenticated.contract.test.ts
```

The AGY command must run from an already-authenticated operator shell; it writes
only a redacted evidence record, never raw invocation logs or credentials.

See [docs/architecture/overview.md](./docs/architecture/overview.md) for the
architecture, [docs/dev/plan.md](./docs/dev/plan.md) for the Batch 5 contract
and closeout, and [AGENTS.md](./AGENTS.md) for repository invariants.
