---
status: done
confidence: 0.96
owners: harness-runtime
---

# Batch 5 — Configured Tasks and Agent-Run Commit Skill

## Goal

Keep one-off tasks simple and operator-controlled:

1. rename **Execute one-off task** to **Tasks**;
2. show configured tasks in manifest declaration order;
3. rescan project state whenever the main menu or Tasks menu is entered;
4. warn, but never block, when running a one-off task may invalidate a
   currently eligible pipeline continuation; and
5. add a `commit` task whose selected coding agent safely creates one local
   commit through the existing task/provider path.

The harness does not implement Git commit automation. It invokes the configured
commit skill exactly as it invokes any other task. The operator remains the
authority for deciding when a one-off task runs.

## Release boundary

This batch adds:

- `roles/committer.md`;
- `skills/50-simple-commit/SKILL.md`;
- one configured `50-simple-commit` skill and `commit` task;
- the **Tasks** label and submenu navigation;
- manifest-order task presentation;
- one advisory confirmation when an eligible pipeline continuation exists;
- menu-boundary rescanning; and
- focused configuration, menu, prompt, task, Git-safety, and documentation
  coverage.

This batch does **not** add:

- task availability or pipeline-checkpoint contracts;
- task disabling based on pipeline position;
- a `git-commit` output contract;
- harness-owned `git add` or `git commit`;
- Git index snapshots, transaction markers, recovery commands, or pipeline
  repair;
- fingerprint equivalence for a dirty worktree and the same content after
  commit;
- automatic pipeline transitions;
- a new pipeline stage;
- push, amend, reset, clean, stash, force operations, or hook bypass;
- a general action/plugin framework; or
- a second scan immediately before provider execution.

Missing declared project inputs retain their existing preflight behavior. No
task gains a new pipeline-based availability restriction.

## Architecture

### Reuse the normal task engine

Declare Commit as an ordinary manifest task:

```yaml
roles:
  committer: roles/committer.md

skills:
  50-simple-commit:
    file: skills/50-simple-commit/SKILL.md
    role: committer
    runnerProfile: implement

tasks:
  commit:
    skill: 50-simple-commit
    target: { path: ".", kind: worktree }
    inputs:
      - { source: target }
      - { source: version }
      - { source: outputPath }
    output:
      pattern: "docs/dev/commit-v{version}-{provider}.md"
      contract: completion-artifact
```

The execution path remains:

```text
Tasks
  → select task
    → advisory confirmation
      → runner/model/effort/session selection
        → runTask
          → runBinding
            → executeLoopStep
              → selected provider adapter
```

There is no commit-specific engine branch. Existing ownership, interruption,
timeout, session, logging, provider, prompt-composition, and artifact contracts
apply unchanged.

The task is not part of `pipelines.default`. Running it is always ad hoc: it
does not consume a suggested stage, acquire pipeline identity, repair a
pipeline, or unlock a successor.

## Menu behavior

### Main action and Tasks submenu

Rename the top-level label from **Execute one-off task** to **Tasks** while
retaining action ID `run-task`.

Selecting **Tasks** opens the generic configured-task chooser:

```text
Tasks
├── implement — 30-simple-implement · implementer
├── commit — 50-simple-commit · committer
└── Back to main menu
```

The submenu must not hardcode `implement` or `commit`. It shows all configured
tasks. Selecting a task opens its confirmation screen; it does not start a
provider. **Cancel** returns to Tasks, and **Back to main menu** returns to the
main action surface.

### Manifest declaration order

Task rows follow `config.manifestDeclarationOrder.tasks`, which is derived from
the authoritative YAML AST declaration order.

When constructing the menu:

- include configured task IDs in recorded declaration order;
- ignore stale IDs absent from the loaded manifest;
- append any manifest task omitted from the supplied list exactly once in
  manifest object order; and
- retain the existing missing-input presentation.

Thread the existing declaration-order data only through the task-menu call
sites. Do not add a generic menu registry.

### Menu-boundary rescanning

The main interactive loop already scans before rendering the main menu. Preserve
that behavior.

Entering or returning to the Tasks chooser performs one fresh
`scanGlobalSnapshot(projectRoot, manifest)` before rendering its rows. This
means:

- entering Tasks from the main menu rescans;
- cancelling a task confirmation and returning to Tasks rescans; and
- returning to the main menu uses the main loop's normal rescan.

The selected Tasks snapshot remains authoritative for that confirmation. Do not
scan again after confirmation, during runner selection, or immediately before
provider execution. The harness does not poll while an interactive prompt is
open.

### Advisory pipeline-risk confirmation

One-off tasks remain runnable at every pipeline position. Pipeline state is
information, not authorization.

After the operator selects a task and before runner selection, inspect the
already-scanned Tasks snapshot for currently eligible pipeline candidates. If
one or more candidates exist, display them on the task confirmation screen and
show an advisory equivalent to:

```text
One-off task: commit

Current eligible pipeline continuation:
  default: implement → review

This task does not consume the pipeline continuation listed above and may invalidate it.
If invalidated, the next stage must be run ad hoc.

Continue
Cancel — back to Tasks
```

If several eligible candidates exist, list each candidate using its configured
pipeline ID and predecessor/successor stage IDs. Do not predict whether the
selected provider will modify the target and do not introduce task-name or
workflow-name branches.

The choices are:

- **Continue** — proceed to the existing runner/model/effort/session selection;
- **Cancel — back to Tasks** — make no provider call and return to the Tasks
  chooser, which rescans before rendering again.

If there is no eligible pipeline continuation, retain the same confirmation
screen and choices without the warning block.

The warning is deliberately advisory:

- it never disables a task;
- it does not consume or mutate pipeline state;
- it does not promise that the candidate will become stale; and
- it does not attempt to repair a candidate after the task.

After the task, ordinary state reconstruction remains authoritative. If the
task changed a predecessor target fingerprint, project status shows the
candidate as unavailable with `target-fingerprint-drift`. For the current
worktree fingerprint, a commit after pipeline implementation changes `HEAD`
and the staged/unstaged representation, so the existing `implement → review`
candidate will normally become stale even when committed file bytes are
unchanged. The operator accepted this consequence before execution and may run
Review ad hoc.

## Committer role

Add `roles/committer.md` with one responsibility: safely package clear existing
working-tree changes into one local commit.

The role must:

- follow applicable `AGENTS.md` instructions;
- treat explicit operator invocation as authority to attempt the task;
- avoid implementing, repairing, formatting, or otherwise changing source
  merely to make it easier to commit;
- prefer `BLOCKED` over guessing an ambiguous commit scope;
- preserve unrelated operator changes;
- never claim the harness verified or created the commit; and
- never add AI-authorship or agent-attribution text to a commit message.

The role does not inspect or enforce pipeline approval state. Pipeline position
is not a commit authorization rule.

## Commit skill contract

Add `skills/50-simple-commit/SKILL.md`.

### Required inspection

Before staging or committing, the skill must:

1. read the repository instructions and directly applicable nested
   instructions;
2. inspect `git status --short`, the staged diff, and the unstaged diff;
3. check for conflicts or an active merge, rebase, cherry-pick, or revert;
4. confirm that there are changes worth committing; and
5. determine whether the intended commit scope is clear from the working tree,
   repository context, and operator invocation.

The skill must not require an approved plan/review artifact and must not infer a
pipeline-safe execution window. Those checks would recreate the pipeline gate
that this plan explicitly rejects.

If unrelated staged changes or ambiguous files cannot be separated safely,
write `BLOCKED` rather than unstaging or rewriting operator state. A path with
both staged and unstaged changes is blocked unless it is clear that the complete
current file belongs in the commit.

### Commit behavior

When scope is clear, the skill must:

- stage explicit intended paths rather than `git add -A` or `git add .`;
- preserve unrelated staged, unstaged, and untracked changes;
- create exactly one local commit;
- allow configured Git hooks to run normally;
- use a concise commit message describing the changes;
- exclude AI/agent attribution and signature boilerplate;
- verify the commit with read-only Git commands;
- record the full commit ID and committed paths; and
- report remaining staged, modified, and untracked paths without changing them.

The skill must never:

- push, fetch, pull, or otherwise contact remotes;
- amend or force-update a commit;
- run reset, clean, checkout/restore, stash, rebase, merge, cherry-pick, or
  destructive recovery commands;
- bypass hooks with `--no-verify`;
- change Git configuration or author identity;
- delete or rewrite unrelated files;
- expose credentials, tokens, secrets, or sensitive file contents; or
- create a second commit solely for its evidence artifact.

If `git commit` or a hook fails, the skill performs no speculative cleanup. It
writes `BLOCKED`, records the failure concisely, and reports the resulting
repository state for operator review.

### No-test policy

Commit is a packaging task, not a verification or repair task. The skill must
not run tests, builds, typechecks, linters, formatters, or the orc-smash
application recursively. Normal Git hooks remain enabled and may run their own
checks.

The artifact states:

```text
Direct verification commands run by commit skill: none (by contract)
Git hooks: allowed; configured hooks may have run their own checks
```

The operator is responsible for choosing when verification is sufficient.

## Completion artifact

The skill writes the normal `completion-artifact` to the exact supplied
`outputPath` with one exact outcome:

```markdown
## Outcome

COMPLETED
```

or:

```markdown
## Outcome

BLOCKED
```

The artifact records:

- repository state inspected;
- committed paths;
- commit subject and full commit ID when successful;
- remaining staged, modified, and untracked paths;
- the direct-verification and Git-hook statements above; and
- a concise blocker or failure description when blocked.

It must not claim approval, implementation completion, test execution, push
success, or a clean worktree unless directly observed.

The provider creates the artifact after attempting the commit, and the harness
then adds provenance. Consequently,
`docs/dev/commit-vN-provider.md` normally remains as uncommitted evidence after
a successful task. Batch 5 does not create a second commit for this artifact.

## File impact

### Add

- `roles/committer.md`
- `skills/50-simple-commit/SKILL.md`

### Modify

- `config/orc-smash.yaml`
  - add the committer role, `50-simple-commit` skill, and ordinary `commit`
    task after `implement`;
  - use the existing `implement` runner profile and `completion-artifact`;
  - leave `pipelines.default` unchanged.
- `src/stage-menu.ts`
  - rename the top-level action to **Tasks**;
  - accept task declaration order and preserve the missing-input behavior.
- `src/commands/smash.ts`
  - pass `config.manifestDeclarationOrder.tasks` into task-menu construction;
  - rescan once whenever Tasks is entered or re-entered;
  - carry the eligible candidates from that snapshot into the task
    confirmation;
  - handle **Continue** and **Cancel — back to Tasks** without a second
    execution-time scan.
- `src/interactive.ts`
  - render the task confirmation, optional advisory candidate list, and the two
    choices without workflow-name branches.
- configuration, stage-menu, interactive-command, prompt, and task execution
  tests
  - cover the behavior listed under Verification.
- `README.md`
  - document Tasks, one-off execution, the advisory warning, possible pipeline
    invalidation, ad-hoc fallback, agent-run Commit, output residue, Git
    restrictions, and the no-test policy.
- `AGENTS.md`
  - describe Commit as an ordinary operator-invoked provider task rather than
    harness-owned Git automation.
- `docs/architecture/overview.md`
  - document reuse of the task engine and the advisory-only relationship
    between one-off tasks and pipeline state.

No changes are planned for:

- `src/manifest.ts`;
- `src/pipeline-state.ts`;
- `src/pipeline-stage-state.ts`;
- `src/next-step.ts`;
- `src/loops/binding-engine.ts`;
- task output contracts or artifact classification;
- interrupted-run, ownership, supervisor, process-group, or kill-gate modules;
- provider adapters; or
- pipeline state mutation, eligibility, continuation, or repair semantics.

If implementation requires changing those modules, stop and reopen planning
rather than expanding this batch silently.

## Verification

### Deterministic

1. The packaged manifest loads the new committer role, skill, and task.
2. Existing tasks load and execute unchanged.
3. The top-level action reads **Tasks** and retains ID `run-task`.
4. Tasks contains every configured task plus **Back to main menu** without
   starting a provider.
5. Tasks follow `manifestDeclarationOrder.tasks`; stale IDs are ignored and
   omitted configured tasks are appended once.
6. Entering Tasks performs one fresh global scan rather than reusing the main
   menu snapshot.
7. Cancelling confirmation returns to Tasks, causes one new menu-boundary scan,
   and makes no runner selection or provider call.
8. Continuing from confirmation does not perform another scan before runner
   selection or provider execution.
9. With no eligible pipeline candidate, confirmation shows no pipeline warning.
10. With one eligible candidate, confirmation shows its configured pipeline and
    predecessor/successor stage IDs and both Continue/Cancel choices.
11. With multiple eligible candidates, confirmation lists each once in stable
    existing candidate order.
12. The warning never disables the selected task and contains no literal
    workflow/task-name branch.
13. Missing-input task behavior remains unchanged.
14. Commit prompt composition resolves target, version, and exact output path.
15. A fake-provider Commit task executes end-to-end through
    `runTask → runBinding → executeLoopStep` and produces a valid normal
    completion artifact.
16. Commit-skill fixtures prove:
    - clear intended changes can produce `COMPLETED`;
    - no changes, conflicts, active Git operations, or ambiguous scope produce
      `BLOCKED`;
    - explicit-path staging preserves unrelated changes;
    - approval/review artifacts are not required;
    - no direct tests or forbidden Git commands are run; and
    - no AI attribution is added.
17. Existing plan, implement, review, continuation, second-opinion, task, and
    pipeline tests remain green.

### Manual smoke

Use a disposable temporary Git repository or clone:

1. create a committed baseline and one clear intended source change;
2. run Commit without pipeline artifacts and verify it is not blocked merely
   because approval evidence is absent;
3. verify exactly one local commit contains only intended paths;
4. verify no remote operation, destructive command, hook bypass, direct test,
   build, lint, formatting, or second evidence-only commit occurred;
5. verify the completion artifact records the commit and remains as expected
   uncommitted evidence;
6. create an eligible pipeline continuation, select a one-off task, verify the
   advisory names that continuation, then cancel and confirm no provider ran;
7. repeat and continue, verifying the task remains allowed;
8. after a Commit that changes the worktree fingerprint, verify project status
   explains the lost candidate as `target-fingerprint-drift` and Review remains
   runnable ad hoc; and
9. smoke an ambiguous/conflicted Git state and verify `BLOCKED` creates no
   commit and performs no cleanup.

## Release gate

Before Batch 5 is complete:

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm build`
4. focused configuration, menu-boundary scan, advisory-confirmation, prompt,
   task-artifact, and Git-safety tests pass;
5. disposable-repository successful, warning/cancel, warning/continue, and
   blocked smokes pass;
6. documentation clearly distinguishes agent-run Git from harness-owned Git and
   explicitly describes possible pipeline invalidation; and
7. implementation review reaches `APPROVED`.

## Completion criteria

Batch 5 is complete when:

- the top-level menu displays **Tasks**;
- configured tasks appear in manifest declaration order;
- entering or returning to Tasks performs one fresh scan;
- task confirmation shows any currently eligible pipeline continuation and
  warns that the one-off task may invalidate it;
- the operator can Continue or Cancel back to Tasks;
- no second pre-execution scan or pipeline-based task blocking exists;
- Commit runs through the ordinary provider task path at any pipeline position;
- Commit blocks only for genuine Git/task safety failures, not missing approval
  or pipeline position;
- the committer role and skill enforce explicit-path staging, one local commit,
  no direct verification commands, no remotes, no destructive Git operations,
  no hook bypass, and no AI attribution;
- the completion artifact truthfully records the result and remains expected
  uncommitted evidence;
- pipeline state is neither consumed nor repaired, and any resulting candidate
  drift is reported by existing project-state reconstruction; and
- all deterministic, build, smoke, documentation, and review gates pass.

## Implementation Closeout

### Phase checklist

- [x] Added the committer role, `50-simple-commit` skill, and configured
  `commit` task.
- [x] Renamed the top-level action to **Tasks** and preserved the `run-task`
  action ID.
- [x] Preserved manifest declaration order and missing-input presentation.
- [x] Added Tasks-boundary rescanning and advisory eligible-continuation
  confirmation without task blocking or pipeline mutation.
- [x] Added fake-provider task execution, prompt, menu, configuration, and
  Commit-safety coverage.
- [x] Synchronized `README.md`, `AGENTS.md`, and
  `docs/architecture/overview.md`.
- [x] Passed `pnpm typecheck`, `pnpm test`, `pnpm build`, and `git diff --check`.

### Change log

- 2026-07-28: Batch 5 implemented. Evidence is recorded in
  `docs/dev/impl-v2-codex.md`.
- 2026-07-28 deviation: no non-archived v1+ approved plans audit was present.
  The user supplied independent verification and explicitly authorized
  implementation; no approval artifact was fabricated. The real-provider
  disposable Git smoke remains an environment-gated operator check.
