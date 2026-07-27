---
status: ready
confidence: 0.96
owners: harness-runtime
---

# Batch 5 — Configured Operator Tasks and Local Commit Action

## Goal and release boundary

Make the existing generic task surface clear and useful after an approval by:

1. presenting it as **Tasks** in manifest declaration order; and
2. adding one configured commit task that can create a verified local commit
   without hardcoding the textual task ID `commit`.

The operator remains in control. A commit task never pushes, amends, resets,
cleans, force-updates, or automatically starts a pipeline stage. After it
finishes, the interactive application returns to the action surface. An
eligible **Start suggested stage** action remains separate and unchanged.

This batch does not add a general shell-task language, background jobs,
automatic commits, commit-and-push, hunk selection, pipeline auto-advancement,
or a second execution engine.

## Architecture decision

### A typed action contract, not a special task name

Extend the task output schema with a discriminated `git-commit` action
contract. Dispatch is based on the declared contract, never on the binding ID
or skill ID. Renaming the configured task from `commit` to `checkpoint` must
preserve identical behavior.

The packaged manifest will declare a normal task binding and skill:

```yaml
skills:
  commit:
    file: skills/commit/SKILL.md
    role: implementer
    runnerProfile: implement

tasks:
  commit:
    skill: commit
    target: { path: ".", kind: worktree }
    artifacts:
      approval:
        bindingKind: loop
        phase: evaluate
        result: accepted
        select: latest
    inputs:
      - { source: approval }
      - { source: target }
    output:
      contract: git-commit
```

`git-commit` is a reusable action contract in the same sense that
`decision-artifact` and `required-artifact` are reusable output contracts. It
does not make `commit` a reserved task or workflow name.

### The Git commit is the durable result

A provider cannot create the final commit and then receive harness-added
provenance inside that same commit. Batch 5 therefore does not create a
repository artifact after the commit.

Instead:

- the skill returns a strict, bounded commit proposal;
- the harness validates and displays that proposal;
- the harness creates one local commit;
- the resulting Git commit ID is verified against `HEAD`; and
- compact `Orc-Smash-*` commit trailers preserve the action contract,
  binding, approved-artifact identity, input fingerprint, and proposal digest.

The verified Git commit object is the durable action result. No hidden runtime
database, shell-history inference, second evidence commit, Git note, or
post-commit repository artifact is introduced.

The commit subject/body remain concise and are proposed by the skill. The
machine trailers are provenance, not agent attribution, and must never contain
AI-authorship boilerplate.

### Two-phase execution

The action has two phases:

1. **Prepare** — the provider may inspect repository and approval state but may
   not modify the worktree, index, refs, or remotes. It returns a proposal.
2. **Finalize** — after validation and operator confirmation, the harness
   creates and verifies the local commit.

The normal provider adapter, ownership, interruption, timeout, session, and
runner-selection behavior remains in force during preparation. Git
finalization is local harness work and does not call a model.

## 1. Extend manifest-declared task inputs and output contracts

### Artifact input selectors

Add an optional `artifacts:` map to `TaskBinding`. Each key is a named input
source and declares a typed selector over the existing validated artifact
index:

- `bindingKind`: `loop | task`;
- optional `bindingId`;
- optional `phase`: `evaluate | repair | task`;
- `result`: a normalized result such as `accepted`, `completed`, or `valid`;
- `select`: `latest` for this release.

An artifact selector resolves only classified, contract-valid v1 artifacts.
The selected artifact path, identity, and content digest participate in prompt
composition and the task input fingerprint. An unresolved selector makes the
task unavailable; it never silently resolves to `none`.

The packaged commit task selects the latest valid accepted loop evaluation.
This makes it visible after a successful approval without embedding `plan`,
`review`, or `commit` in TypeScript.

Artifact selectors are task dependencies, not pipeline transitions. Selecting
one must not consume, replace, or mutate an eligible pipeline edge. The
selected approval identity is recorded in commit provenance, while the
approval artifact and pipeline run remain unchanged.

### Discriminated task output

Change `TaskOutputSchema` from one artifact-only shape to a discriminated
union:

- existing `completion-artifact` and `required-artifact` outputs retain
  `pattern` and optional `validator` exactly as today;
- `git-commit` has no repository output pattern or artifact validator.

Manifest validation must reject:

- `pattern` or `validator` on `git-commit`;
- unknown action contracts;
- artifact input keys that are unused by `inputs:`;
- input sources absent from built-ins, `files:`, or `artifacts:`;
- selectors that reference a missing binding or an impossible phase for that
  binding kind; and
- pipeline stages using `git-commit` tasks. The first release keeps
  operator-action tasks explicitly ad hoc so a commit cannot become an
  automatic stage transition.

Existing manifests and artifact-producing tasks remain source-compatible.

### File impact

- `src/manifest.ts` — typed artifact selectors and discriminated task outputs.
- `src/patterns.ts` — validate named artifact sources alongside file sources.
- `src/prompt-composer.ts`, `src/binding-inputs.ts` — render selected artifact
  inputs and include their identity/digest in the input fingerprint.
- `src/project-snapshot-view.ts` and renderer tests — describe artifact inputs
  and action contracts without reading or printing source contents.
- `config/orc-smash.yaml` — declare the commit skill and task.

### Verification

- Existing task manifests load without changes.
- A renamed commit binding still resolves `git-commit`.
- Invalid/unused artifact selectors fail at manifest load.
- A missing accepted artifact affects task availability, not manifest
  validity.
- Declaration order remains the authoritative task presentation order.
- An action task cannot be placed in a pipeline in this release.

## 2. Resolve task availability from declared inputs and action preflight

Add one task-availability resolver that combines:

1. existing target/file input availability;
2. declared artifact selector availability; and
3. output-contract-owned preflight.

The `git-commit` preflight reports typed unavailable reasons:

- `missing approved artifact`;
- `clean worktree`;
- `merge conflict`;
- `Git repository unavailable`;
- `HEAD unavailable`;
- `another Git operation is active`; or
- `commit scope cannot be isolated`.

The renderer receives only the resolved availability state and reason. It must
not inspect Git or artifact files itself.

Rename the top-level label **Execute one-off task** to **Tasks**. Keep it
visible whenever tasks are configured. The task submenu continues to render
every configured task in manifest declaration order, including unavailable
items with their precise reason.

After an approval, the accepted artifact selector resolves and the commit task
becomes available when the Git preflight also finds committable changes.
**Start suggested stage** remains a separate action beside **Tasks**.

### File impact

- `src/task-availability.ts` — own generic declared-input resolution and action
  preflight composition.
- `src/git-commit-action.ts` — own Git-specific read-only preflight.
- `src/stage-menu.ts`, `src/interactive.ts`, `src/commands/smash.ts` — consume
  resolved task availability and present **Tasks**.
- `src/project-snapshot-view.ts`, `src/project-snapshot-renderer.ts` — report
  task availability and reasons consistently in project status.

### Verification

- **Tasks** is always derived from configured tasks, never from an accepted
  stage name.
- Clean, conflicted, and missing-approval states remain visible and disabled
  with the correct reason.
- Tasks with only file inputs behave exactly as before.
- Reordering tasks in YAML reorders the menu and status presentation.
- Renaming `commit` to `checkpoint` changes only the displayed binding name.

## 3. Add a read-only commit proposal skill

Create `config/skills/commit/SKILL.md`. The skill must:

- inspect branch, `HEAD`, staged, unstaged, untracked, and conflict state;
- read the declared accepted artifact supplied through prompt inputs;
- identify a coherent whole-file commit scope;
- exclude unrelated operator changes;
- propose a concise subject/body without AI attribution;
- never run `git add`, `git commit`, `git reset`, `git clean`, `git checkout`,
  `git restore`, `git push`, or another mutating Git command;
- never edit or create repository files; and
- return exactly one bounded `ORC_COMMIT_PROPOSAL_V1` JSON object.

The proposal schema is:

```json
{
  "message": "Concise imperative commit message",
  "paths": ["relative/path-a", "relative/path-b"]
}
```

The parser accepts no additional keys. Apply explicit size, path-count, and
message-length limits. Every path must:

- be project-relative and canonical;
- remain inside `projectRoot`;
- identify an existing changed or untracked path;
- not resolve inside `.git`;
- contain no NUL or pathspec magic; and
- represent a whole file. Partial-hunk selection is outside Batch 5.

Before provider execution, record a read-only baseline of `HEAD`, refs, index
state, remote configuration, and porcelain-v2 worktree status. After provider
execution, compare the same state. Any provider mutation fails the action
before confirmation. Do not automatically erase or reset an unexpected
provider change; report it for operator review.

Unknown/malformed output, empty paths, duplicate paths, a scope containing only
the action metadata, or a message containing attribution/signature boilerplate
fails closed without invoking Git commit.

### File impact

- `config/skills/commit/SKILL.md` — provider instructions and proposal
  contract.
- `src/commit-proposal.ts` — strict bounded parser and canonical path
  validation.
- `src/git-commit-action.ts` — capture and compare the read-only Git baseline.
- `tests/fixtures/` — deterministic valid and invalid proposal fixtures only;
  no repository-specific sensitive content.

### Verification

- All four real adapters can return the proposal through their existing final
  response contract; deterministic fake coverage gates harness logic.
- Provider mutation during preparation prevents finalization.
- Malformed JSON, code fences with extra prose, duplicate keys, path escapes,
  `.git` paths, pathspec magic, empty scope, and oversized output fail closed.
- A proposal cannot push or commit by placing commands in its message or paths.

## 4. Preview, confirm, and create exactly one local commit

### Operator preview

After proposal validation, render:

- current branch and abbreviated baseline `HEAD`;
- approved artifact identity;
- proposed commit message;
- exact selected paths with their staged/unstaged/untracked status; and
- unrelated dirty paths that will remain.

Interactive execution then asks **Create local commit** or **Back without
committing**. Declining performs no Git mutation and returns to the Tasks menu
or main action surface.

The existing initial task-detail confirmation remains useful for runner and
contract visibility, but it does not replace this scope preview.

For explicit non-interactive `--task` execution, mutating action contracts must
fail before provider execution with `interactive confirmation required`.
Batch 5 does not add a bypass flag.

### Scoped Git finalization

After confirmation:

1. re-run preflight and require the same `HEAD`, approval identity, and selected
   path states used for the preview;
2. snapshot the real Git index to an OS-managed temporary file;
3. use argv-based Git spawning—never shell interpolation;
4. make newly selected untracked paths known to Git with intent-to-add only;
5. invoke one normal `git commit --only` over exactly the selected whole-file
   paths, with the validated message and provenance trailers;
6. allow normal commit hooks to run;
7. if Git exits nonzero and `HEAD` is unchanged, atomically restore the exact
   pre-action index snapshot and leave worktree files untouched;
8. if Git succeeds, verify the new commit before reporting success; and
9. remove temporary index material on every terminal path.

The finalizer never runs `push`, `amend`, `reset`, `clean`, force operations,
or recursive repository cleanup.

Pre-existing staged changes outside the proposal must remain staged and
byte-identical. Unstaged and untracked paths outside the proposal remain
untouched. Selected paths are committed as whole working-tree files; ambiguous
or unisolatable index states fail before mutation.

If a hook fails, no successful result is reported. Hook-created worktree
changes are reported and preserved for manual review rather than silently
removed.

### Commit provenance and verification

Append machine trailers to the validated message:

- `Orc-Smash-Action: git-commit-v1`;
- `Orc-Smash-Binding: <configured task ID>`;
- `Orc-Smash-Approval: <accepted artifact identity>`;
- `Orc-Smash-Input: <input fingerprint>`; and
- `Orc-Smash-Proposal: <proposal digest>`.

After Git returns success, require:

- `HEAD` changed exactly once;
- the new commit has the baseline `HEAD` as its sole parent;
- `git rev-parse HEAD` equals the reported commit ID;
- the commit contains exactly the selected paths;
- all expected trailers match the prepared action;
- no remote was contacted;
- the accepted artifact content/identity is unchanged; and
- unrelated dirty paths retain their pre-action state.

Only then emit task completion. Report the full commit ID and remaining dirty
paths. A verification mismatch is a terminal blocked/unknown action result and
must never be described as success.

### File impact

- `src/task-actions.ts` — dispatch typed action contracts independently of task
  IDs and keep the binding engine thin.
- `src/git-commit-action.ts` — proposal preflight, preview model, scoped commit,
  index transaction, and post-commit verification.
- `src/interactive.ts` — action preview and final confirmation.
- `src/commands/smash.ts` — route action tasks and return to the existing
  interactive action loop.
- `src/run-event.ts`, plain/rich renderers — additive prepared, declined,
  committed, and failed action events with no raw proposal payloads.

### Verification

- Selecting the task and confirming produces exactly one local commit.
- Declining after preview produces no commit and no Git/index mutation.
- Hooks run normally; a failing hook produces no false success.
- Conflicts and concurrent `HEAD`/index drift stop before commit.
- Unrelated staged, unstaged, and untracked changes remain unchanged.
- Selected tracked and untracked whole files can be committed together.
- Shell metacharacters in paths/messages are data, never executable syntax.
- The verified commit ID equals `HEAD` and is printed in rich and plain modes.
- The worktree is not dirty solely because orc-smash recorded action evidence.

## 5. Preserve pipeline and stateless harness behavior

The commit action is deliberately outside pipeline progression:

- it does not mint a pipeline run;
- it does not create or consume a stage-continuation edge;
- it does not modify an accepted artifact;
- it does not change the accepted target fingerprint;
- it does not start implementation or review; and
- it returns to the action surface after completion.

The previously eligible pipeline candidate must remain eligible when the
commit does not alter that candidate's target. In the packaged plan pipeline,
committing an approved `docs/dev/plan.md` and its audit evidence therefore does
not invalidate the plan-to-implementation suggestion.

The Git commit and its trailers are sufficient durable evidence for this
operator action. Artifact indexing and approval/pipeline state reconstruction
continue to use workflow artifacts exactly as before. Batch 5 does not add
Git-log-derived pipeline state.

Interruption rules:

- interruption during provider preparation uses the existing provider
  interruption/ownership path and cannot commit;
- interruption before final confirmation cannot commit;
- once `git commit` starts, wait for its process result and verify `HEAD`;
- on restart, the repository's actual `HEAD` is authoritative—never retry a
  commit automatically.

### Verification

- Plan-to-implementation eligibility is identical before and after a commit
  when `docs/dev/plan.md` content is unchanged.
- Commit execution never creates a downstream stage or second-opinion chain.
- Restart does not repeat or resume the commit action.
- Existing approval loops, ordinary tasks, second opinions, and stage
  continuations remain unchanged.

## 6. Tests, documentation, and release gates

### Deterministic coverage

Add deterministic temporary-repository tests for:

- manifest parsing and invalid action declarations;
- named accepted-artifact selection and missing-input availability;
- manifest-order Tasks presentation;
- clean/conflict/active-operation/unavailable reasons;
- strict proposal parsing and path containment;
- provider read-only baseline enforcement;
- preview decline with zero mutation;
- tracked, staged, unstaged, and untracked whole-file commits;
- preservation of unrelated staged/unstaged/untracked changes;
- hook failure and index restoration;
- concurrent `HEAD` or index drift;
- commit ID, parent, diff scope, and trailer verification;
- dirty-state reporting after success;
- no `push`, `amend`, `reset`, `clean`, or shell execution;
- renamed task ID behavior;
- no post-commit evidence dirtiness; and
- unchanged pipeline candidate eligibility.

Use isolated temporary Git repositories with local hooks. No test may modify
the developer's real repository, global Git configuration, remotes, or
credentials.

### Real-provider boundary

The commit mutation itself is deterministic harness behavior and does not need
four providers to create real commits. Env-gated provider tests only need to
prove that each selected real provider can inspect an isolated repository and
return a valid read-only proposal without mutating it. The fake adapter gates
proposal/finalizer logic.

Retain the existing real-provider policy:

- Codex and Claude through authenticated env-gated contracts;
- OpenCode through its existing env-gated contract; and
- AGY through deterministic seam coverage plus manual authenticated
  verification.

### Documentation

Update:

- `AGENTS.md` — typed operator-action contract, commit safety boundary, and
  Git commit as durable result;
- `README.md` — **Tasks** flow, availability, confirmation, local-only
  behavior, and CLI limitation;
- `docs/architecture/overview.md` — artifact selectors, action dispatch, and
  separation from pipelines; and
- packaged manifest/skill documentation.

### Release gate

Before Batch 5 is complete:

1. `pnpm typecheck`
2. `pnpm test`
3. `pnpm build`
4. deterministic temporary-repository commit matrix passes;
5. env-gated read-only proposal probes pass where authenticated;
6. manual interactive smoke:
   approval → Tasks → commit preview → confirm → local commit → return to menu;
7. verify no push occurred and unrelated changes remain;
8. verify **Start suggested stage** remains eligible; and
9. run the implementation review loop to `APPROVED`.

## Completion criteria

Batch 5 is complete only when:

- configured tasks are presented as **Tasks** in manifest order;
- the configured commit task is available from declared approval and Git
  state, without task-ID branching;
- the operator sees exact scope before mutation;
- confirmation creates one verified local commit and never pushes;
- decline, conflicts, hooks, malformed proposals, or drift fail safely;
- unrelated changes remain untouched and reported;
- no post-commit evidence change dirties the repository;
- pipeline identity and candidate eligibility remain unchanged; and
- all deterministic, build, provider-boundary, smoke, and review gates pass.
