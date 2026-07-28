---
status: ready
confidence: 0.97
owners: harness-runtime
---

# Batch 5 — Configured Tasks and Agent-Run Commit Skill

## Goal

Make the existing task surface clearer and add a small, operator-invoked commit
task implemented entirely as a normal role + skill:

1. rename **Execute one-off task** to **Tasks**;
2. present configured tasks in manifest declaration order; and
3. add a `commit` task whose selected coding agent inspects and commits the
   intended working-tree changes.

The harness does not implement Git commit automation. It runs the commit skill
through the same task/provider path as `implement`, validates the normal task
artifact, and returns to the existing action surface.

## Release boundary

This batch adds:

- `roles/committer.md`;
- `skills/50-simple-commit/SKILL.md`;
- one configured `commit` skill and task;
- one declarative, read-only pipeline-checkpoint availability guard for tasks;
- the **Tasks** menu label;
- manifest-order task presentation; and
- focused configuration, menu, prompt, artifact, and documentation coverage.

This batch does **not** add:

- a `git-commit` output contract;
- a harness-owned `git add` or `git commit` path;
- proposal JSON parsing or a second Prepare/Finalize phase;
- Git index snapshots, transaction markers, optimistic concurrency, recovery
  commands, or action-specific process groups;
- approval-artifact selectors or conditional post-approval task availability;
- automatic commits, automatic pipeline transitions, push, amend, reset, clean,
  stash, force operations, or hook bypass;
- a general action/plugin framework; or
- any new pipeline stage.

The commit task is visible whenever configured. The operator decides when to run
it, normally immediately after an approval. The skill verifies approval evidence
and repository state before committing. The harness does not infer that an
approval automatically authorizes a commit.

## Architecture

### Reuse the normal task engine

Declare `commit` as an ordinary manifest task:

```yaml
roles:
  committer: roles/committer.md

skills:
  commit:
    file: skills/50-simple-commit/SKILL.md
    role: committer
    runnerProfile: implement

tasks:
  commit:
    skill: commit
    target: { path: ".", kind: worktree }
    availability:
      contract: pipeline-checkpoint
      pipeline: default
      allow:
        - { beforeStage: implement }
        - { afterStage: review }
    inputs:
      - { source: target }
      - { source: version }
      - { source: outputPath }
    output:
      pattern: "docs/dev/commit-v{version}-{provider}.md"
      contract: completion-artifact
```

The existing path remains unchanged:

```text
Tasks
  → commit
    → runner/model/effort/session selection
      → runTask
        → runBinding
          → executeLoopStep
            → selected provider adapter
```

The provider performs the repository inspection and Git commands. Existing
provider ownership, interruption, timeout, session, logging, and artifact
contracts apply without a commit-specific runtime path.

The task is not added to `pipelines.default`. Completing it does not start
implementation, review, or another loop. The operator returns to the existing
post-run/action surface.

### Pipeline interaction and safe commit points

Tasks launched from the **Tasks** submenu are ad hoc runs. They do not consume a
suggested pipeline stage or acquire that stage's pipeline identity.

Consequently:

- do not use **Tasks → implement** to continue an approved plan pipeline; use
  **Start suggested stage** so implementation receives the plan-stage lineage
  and can unlock the configured review stage;
- a commit immediately after plan approval is allowed: the packaged
  plan→implement predecessor targets the file `docs/dev/plan.md`, whose
  fingerprint is content-based, so committing unchanged plan content does not
  stale that suggestion;
- a commit after implementation but before review is not allowed: the
  implement→review predecessor targets the worktree, whose fingerprint includes
  `HEAD`, and a commit changes `HEAD`, making the suggested review stage stale;
- a commit during an active plan or review loop is not allowed because it can
  change the target while that loop is still resolving; and
- a commit after final review approval is allowed because the configured
  pipeline is already terminal.

The intended workflows are:

```text
plan APPROVED
  → optional Tasks → commit
  → Start suggested stage: implement
  → Start suggested stage: review
  → review APPROVED
  → optional Tasks → commit
```

The commit skill must fail with `BLOCKED` when non-archived artifacts show an
implementation without a later approved review, an active/rejected review that
still requires repair, or another ambiguous in-progress loop. This is a
skill-level safety check, not new pipeline automation. The operator remains
responsible for selecting **Start suggested stage** when continuing a pipeline.

### Declarative menu availability

The menu should not spend a provider call merely to discover that commit is at
an unsafe pipeline point. Add an optional task-level availability contract:

```yaml
availability:
  contract: pipeline-checkpoint
  pipeline: default
  allow:
    - { beforeStage: implement }
    - { afterStage: review }
```

This is a generic manifest contract. TypeScript branches on
`pipeline-checkpoint`, never on the literal task ID `commit` or workflow names
such as `plan`, `implement`, or `review`. Pipeline and stage IDs are data read
from the manifest.

Semantics:

- `beforeStage` is available only when the existing pipeline resolver currently
  reports that exact stage as an eligible successor;
- `afterStage` is available only when that stage is the configured terminal
  stage and its latest non-stale pipeline run completed successfully
  (`accepted` for a loop or valid/completed for a task);
- any unresolved/retry stage, stale target, conflicting current runs, missing
  pipeline evidence, or next stage not listed by the rule is unavailable; and
- a task without `availability` keeps today's missing-input-only behavior.

Manifest validation must reject:

- an unknown pipeline ID;
- an unknown stage ID;
- an empty `allow` list;
- an entry containing both/neither `beforeStage` and `afterStage`;
- `afterStage` naming a non-terminal stage; and
- duplicate checkpoint entries.

The resolver returns a typed state and concise reason. The packaged commit task
should render examples equivalent to:

```text
commit — commit · committer (available: next pipeline stage is implement)
commit — commit · committer (unavailable: next pipeline stage is review; commit would stale it)
commit — commit · committer (available: terminal review stage is approved)
commit — commit · committer (unavailable: review rejected; follow-up required)
commit — commit · committer (unavailable: pipeline state is stale or ambiguous)
```

Available and unavailable entries both show their reason in parentheses after
the task's skill/role label. Unavailable entries remain visible and disabled
using the existing standardized menu formatting.

The menu reason is guidance, not authorization. Immediately after task-detail
confirmation and before runner selection/provider execution, recompute the same
availability contract from a fresh snapshot. If it is no longer available,
show the new reason and return to the refreshed Tasks submenu without calling a
provider.

### Normal completion artifact

The skill writes a `completion-artifact` to the exact `outputPath` supplied by
the harness. It contains one exact outcome:

```markdown
## Outcome

COMPLETED
```

or:

```markdown
## Outcome

BLOCKED
```

The artifact records what the agent observed and did. It is evidence, not a
second source of Git state.

The provider writes the artifact after attempting the commit, and the harness
then adds provenance. Therefore the new `docs/dev/commit-vN-provider.md`
artifact is expected to remain uncommitted after a successful run. Batch 5 does
not create a second commit to include its own evidence and does not promise a
completely clean worktree after the task. This is the accepted tradeoff for
keeping commit behavior inside the normal task engine.

## Committer role

Add `roles/committer.md` with one responsibility: safely create one local commit
from already reviewed/approved working-tree changes when the repository state is
clear.

The role must:

- follow repository `AGENTS.md` instructions;
- treat the operator as the authority for invoking the task;
- prefer a safe `BLOCKED` result over guessing scope;
- avoid modifying source files merely to make them easier to commit;
- never claim that the harness itself verified or created the commit; and
- never add AI-authorship or agent-attribution text to the commit message.

The role is deliberately narrower than `implementer`: it packages existing
changes and does not implement or repair the feature.

## Commit skill contract

Add `skills/50-simple-commit/SKILL.md`.

### Required inspection

Before staging or committing, the skill must:

1. read repository instructions (`AGENTS.md` and directly applicable nested
   instructions);
2. identify the latest non-archived decision artifact relevant to the current
   changes and require its exact verdict to be approved — an older approval must
   not override a later rejection;
3. inspect `git status --short`, unstaged diff, and staged diff;
4. check for merge/rebase/cherry-pick/revert conflicts or another active Git
   operation;
5. confirm there are changes worth committing; and
6. determine from non-archived artifacts whether this is a safe commit point:
   immediately after plan approval or after final review approval, never between
   implementation and review or during an unresolved loop; and
7. decide whether the intended scope is clear from the approval evidence,
   current changes, and repository context.

If approval evidence is missing, stale, contradictory, or not clearly related
to the current changes, write `BLOCKED` and do not commit. If unrelated staged
changes or ambiguous files cannot be separated safely, write `BLOCKED` rather
than unstaging or rewriting operator state. A path containing both staged and
unstaged changes is blocked unless the evidence makes it clear that the whole
current file belongs in the commit.

The skill may use read-only Git inspection commands freely. It must not run the
orc-smash application recursively to infer approval or pipeline state.

### Commit behavior

When the scope is clear, the skill must:

- stage explicit intended paths rather than using broad `git add -A` or
  `git add .`;
- preserve unrelated staged, unstaged, and untracked changes;
- create exactly one local commit;
- allow configured Git hooks to run normally;
- use a concise commit message describing the change;
- exclude AI/agent attribution and signature boilerplate;
- verify the resulting commit with read-only Git commands;
- record the full commit ID and committed paths in the output artifact; and
- report any remaining modified/staged/untracked paths without changing them.

The skill must never:

- push, fetch, pull, or contact remotes;
- amend or force-update a commit;
- run reset, clean, checkout/restore, stash, rebase, merge, cherry-pick, or
  destructive recovery commands;
- bypass hooks with `--no-verify`;
- change Git configuration or author identity;
- delete or rewrite unrelated files;
- include credentials, tokens, secrets, or sensitive file contents in the
  artifact; or
- create another commit solely for the task evidence artifact.

If `git commit` or a hook fails, the skill must not perform speculative cleanup.
It writes `BLOCKED`, records the failure concisely, and reports the resulting
repository state for operator review.

### No-test policy

This task runs after the operator has completed the relevant approval/review
workflow. The commit skill must **not run tests, builds, typechecks, linters, or
formatters**. It may read existing review/implementation evidence to confirm
that verification occurred.

The output artifact must state:

```text
Direct verification commands run by commit skill: none (by contract)
Git hooks: allowed; configured hooks may have run their own checks
```

This policy prevents a packaging task from consuming model time, changing files,
or reopening implementation. It does not weaken the implementation/review
release gates that must have completed before the operator invokes commit.

### Output artifact contents

The completion artifact must include:

- `## Outcome` with exactly `COMPLETED` or `BLOCKED`;
- approval/review evidence path used, or the reason none was usable;
- repository state inspected;
- committed paths;
- commit subject and full commit ID when successful;
- remaining uncommitted paths;
- `Direct verification commands run by commit skill: none (by contract)`;
- whether Git hooks ran or their activity was observable; and
- a concise blocker/failure description when blocked.

The artifact must not claim approval, implementation completion, test execution,
push success, or a clean worktree unless directly observed.

## Menu changes

### Label

Change the top-level label from **Execute one-off task** to **Tasks**. Keep the
existing action ID and routing (`run-task`) so this is presentation-only.

Selecting **Tasks** opens the existing generic task chooser submenu:

```text
Tasks
├── implement — 30-simple-implement · implementer
├── commit — commit · committer
└── Back to main menu
```

The submenu continues to show every configured task rather than hardcoding
`implement` or `commit`. Selecting a task opens the existing task-detail
confirmation and then the existing per-skill runner/model/effort/session
selection flow. **Back** from task detail returns to the Tasks submenu; **Back**
from the submenu returns to the main menu. No task starts merely by opening the
submenu.

### Rescan behavior

Today `runInteractiveBindingSelection` captures `snapshot` before displaying the
main menu and the inner Tasks loop reuses it. Batch 5 must not reuse that outer
snapshot for task availability.

At the top of every Tasks-submenu iteration:

1. call `scanGlobalSnapshot(projectRoot, manifest)` again;
2. recompute missing inputs and every task availability contract from that fresh
   snapshot;
3. rebuild the task labels/reasons; and
4. then prompt the operator.

This means a fresh scan occurs:

- immediately when **Tasks** is entered from the main menu;
- when task-detail **Back** returns to the Tasks submenu; and
- after a selected task loses eligibility during the execution-time recheck.

Returning from Tasks to the main menu retains the existing outer-loop rescan.
The application does not poll while a prompt is sitting open; freshness is
established at menu boundaries and again immediately before execution.

### Declaration order

`buildTaskMenu` currently iterates `Object.entries(manifest.tasks)`. Update it to
receive the task order from `config.manifestDeclarationOrder.tasks`, matching the
manifest-order presentation already used by project status.

Requirements:

- configured task order comes from the parsed YAML AST;
- missing IDs in the declaration-order list are ignored safely;
- any manifest task absent from the supplied list is appended in manifest object
  order as a defensive fallback;
- unavailable/missing-input presentation remains unchanged; and
- loop, pipeline, runner, and task execution behavior remain unchanged.

Thread task declaration order only through the menu-building call sites in
`src/commands/smash.ts`. Thread the fresh task snapshot and resolved
availability through the same call sites. Do not introduce a generic menu
registry.

## File impact

### Add

- `roles/committer.md`
- `skills/50-simple-commit/SKILL.md`

### Modify

- `config/orc-smash.yaml`
  - declare the `committer` role;
  - declare the `commit` skill using the existing `implement` runner profile;
  - add the normal `commit` task after `implement`;
  - attach the generic `pipeline-checkpoint` availability rule shown above;
  - leave `pipelines.default` unchanged.
- `src/manifest.ts`
  - add the optional discriminated task `availability` contract;
  - validate pipeline/stage references and terminal-only `afterStage` entries;
  - preserve all existing manifests when the field is absent.
- `src/task-availability.ts` (new)
  - resolve task missing inputs plus optional pipeline-checkpoint state;
  - reuse the existing global snapshot/pipeline-stage resolvers;
  - return typed available/unavailable state with a concise reason;
  - contain no Git mutations, provider calls, filename heuristics, or literal
    workflow/task-name branches.
- `src/stage-menu.ts`
  - rename the label to **Tasks**;
  - accept and apply task declaration order;
  - display available reasons and existing unavailable reasons after the
    skill/role label.
- `src/commands/smash.ts`
  - pass `config.manifestDeclarationOrder.tasks` to task-menu construction;
  - rescan at the top of every Tasks-submenu iteration rather than reusing the
    outer main-menu snapshot;
  - revalidate the selected task after detail confirmation and before runner
    selection/provider execution, returning to Tasks on changed eligibility.
- `tests/stage-menu.test.ts`
  - update the label assertion;
  - prove YAML declaration order is honored rather than relying on object order;
  - prove the fallback appends omitted task IDs exactly once;
  - prove available and unavailable reasons render once in parentheses.
- manifest/task-availability tests
  - validate accepted and rejected checkpoint declarations;
  - cover before-stage, terminal-after-stage, retry, stale, ambiguous, missing,
    and unrelated-next-stage states without literal workflow branching;
  - prove tasks without an availability contract retain current behavior.
- task-menu navigation tests
  - prove entering Tasks performs a fresh scan;
  - prove task-detail Back rescans before rebuilding the submenu;
  - prove execution-time eligibility loss calls no provider and returns to the
    refreshed Tasks submenu.
- manifest/config and prompt tests
  - prove the packaged commit role, skill, task, inputs, output pattern, and
    `completion-artifact` contract load correctly;
  - prove the composed prompt includes target, version, and output path.
- `README.md`
  - document **Tasks**, the agent-run commit behavior, output artifact residue,
    no-test policy, prohibited Git operations, safe commit points, and why
    pipeline continuation must use **Start suggested stage** rather than
    **Tasks → implement**.
- `AGENTS.md`
  - describe the commit task as a normal provider task, not harness-owned Git
    automation.
- `docs/architecture/overview.md`
  - document the normal task reuse and explicit non-goals.

No changes are planned for:

- task output schemas or output contracts;
- `src/loops/binding-engine.ts`;
- `src/interrupted-artifact.ts`;
- `src/run-ownership.ts`;
- `src/adapters/process-group.ts`;
- `src/owned-runtime-registry.ts`;
- `src/kill-gate.ts`;
- `src/artifact-contract.ts`;
- pipeline state mutation or next-stage resolution semantics; or
- recovery/status commands.

If implementation discovers that one of these core modules must change to make
the commit task work, stop and reopen planning rather than silently rebuilding
the discarded harness-owned action design.

## Verification

### Deterministic

1. Packaged manifest loads with the new role, skill, and task.
2. Existing tasks continue to load and execute unchanged.
3. The top-level action reads **Tasks** while retaining action ID `run-task`.
4. Selecting **Tasks** opens the task chooser containing `implement`, `commit`,
   and **Back**, without starting a task.
5. Task-detail **Back** returns to the chooser and chooser **Back** returns to
   the main menu.
6. Entering Tasks performs a fresh global scan rather than reusing the main-menu
   snapshot.
7. Returning from task detail performs another scan and refreshes reasons.
8. A task that loses eligibility after confirmation returns to the refreshed
   submenu without runner/provider execution.
9. The task menu follows `manifestDeclarationOrder.tasks`.
10. Reordering task keys in YAML changes menu order.
11. A partial/empty declaration-order list falls back without dropping or
   duplicating tasks.
12. The `pipeline-checkpoint` contract:
    - allows commit before configured stage `implement` when it is eligible;
    - blocks commit when configured stage `review` is the next required stage;
    - allows commit after terminal stage `review` completes successfully;
    - blocks retry, active, stale, ambiguous, and missing pipeline states; and
    - leaves tasks without the contract unchanged.
13. Available and unavailable menu rows display their reason once after the
    task skill/role label.
14. Commit task prompt composition resolves:
   - worktree target;
   - version; and
   - exact output path.
15. A deterministic fake-provider commit task can produce a valid
    `completion-artifact`, proving the ordinary task path needs no special
    contract or engine branch.
16. Skill-contract fixtures cover the allowed plan-approved/final-review-approved
    checkpoints and block implementation-without-later-approved-review,
    unresolved review, and ambiguous active-loop evidence.
17. Existing plan, implement, review, second-opinion, continuation, and pipeline
    tests remain green.

### Manual smoke

Use a disposable temporary Git repository or disposable clone—never the
developer's active working tree:

1. create a small committed baseline;
2. add an `AGENTS.md`, a representative approved artifact under `docs/dev`, and
   one intended changed file;
3. run the configured commit task with an authenticated provider;
4. verify exactly one local commit was created;
5. verify the commit contains only intended paths;
6. verify no remote operation occurred;
7. verify hooks were not bypassed;
8. verify the completion artifact records the commit, states that the skill ran
   no direct verification commands, and reports observable hook activity; and
9. verify the completion artifact remains as the expected uncommitted evidence
   residue.

Also smoke a blocked case with ambiguous/unrelated staged changes and confirm no
commit is created and operator state is not cleaned or rewritten.

## Release gate

Before Batch 5 is complete:

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm build`
4. deterministic configuration/menu/rescan/checkpoint/pre-execution-revalidation/
   prompt/task-artifact coverage passes;
5. disposable-repository successful and blocked manual smokes pass;
6. documentation clearly distinguishes agent-run Git from harness-owned Git;
7. direct `orc smash` can select the task without supervisor-only ownership
   requirements; and
8. implementation review reaches `APPROVED`.

## Completion criteria

Batch 5 is complete when:

- the top-level menu displays **Tasks**;
- tasks appear in manifest declaration order;
- every Tasks entry/re-entry rescans project state and refreshes task reasons;
- the commit row shows why its configured checkpoint is allowed or blocked, and
  eligibility is rechecked before any provider call;
- the configured commit task is a normal provider task using the existing
  `completion-artifact` contract;
- the committer role and skill enforce explicit-path staging, one local commit,
  no direct test/build/lint commands, no remotes, no destructive Git operations,
  no hook bypass, and no AI attribution;
- ambiguous or unsafe repository state produces `BLOCKED` without speculative
  cleanup;
- commit is allowed only after plan approval or final review approval and blocks
  between implementation and review or during an unresolved loop;
- pipeline continuation continues to use **Start suggested stage**; launching
  `implement` from **Tasks** remains explicitly ad hoc;
- the commit artifact truthfully records the result and remains accepted
  evidence residue rather than causing a second commit;
- no custom Git action engine, transaction/recovery subsystem, or pipeline
  behavior is introduced; and
- all deterministic, build, smoke, and review gates pass.
