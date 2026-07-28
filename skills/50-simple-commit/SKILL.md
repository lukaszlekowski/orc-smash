---
name: 50-simple-commit
description: Safely package a clear set of existing working-tree changes into one local commit.
---

## Purpose

Create exactly one local Git commit for the clear intended scope supplied by
the operator. This is a packaging task, not a verification or repair task.

## Required inspection

Before staging or committing:

1. Read the repository `AGENTS.md` and any directly applicable nested
   instructions.
2. Inspect `git status --short`, the staged diff, and the unstaged diff.
3. Check for conflicts or an active merge, rebase, cherry-pick, or revert.
4. Confirm that there are changes worth committing.
5. Determine that the intended commit scope is clear from the working tree,
   repository context, and this explicit operator invocation.

Do not require an approved plan or review artifact. Do not infer a
pipeline-safe execution window. Pipeline position is not a commit
authorization rule.

If unrelated staged changes or ambiguous files cannot be separated safely,
write `BLOCKED` rather than unstaging or rewriting operator state. A path with
both staged and unstaged changes is blocked unless it is clear that the
complete current file belongs in the commit.

## Commit behavior

When the scope is clear:

- stage explicit intended paths; never use `git add -A` or `git add .`;
- preserve unrelated staged, unstaged, and untracked changes;
- create exactly one local commit;
- allow configured Git hooks to run normally;
- use a concise commit message describing the changes;
- exclude AI-authorship and agent-attribution boilerplate;
- verify the commit with read-only Git commands;
- record the full commit ID and committed paths; and
- report remaining staged, modified, and untracked paths without changing
  them.

Never push, fetch, pull, amend, force-update, reset, clean, checkout, restore,
stash, rebase, merge, cherry-pick, bypass hooks, change Git configuration or
author identity, delete or rewrite unrelated files, expose credentials or
secrets, or create a second evidence-only commit.

Do not run tests, builds, typechecks, linters, formatters, or the orc-smash
application recursively. Git hooks remain enabled and may run their own
checks.

## Completion artifact

Write the completion artifact to the exact supplied `outputPath` after the
commit attempt. Record the inspected repository state, committed paths,
commit subject and full commit ID when successful, remaining staged/modified/
untracked paths, and the following direct-verification statement:

```text
Direct verification commands run by commit skill: none (by contract)
Git hooks: allowed; configured hooks may have run their own checks
```

On success, the artifact must contain exactly one outcome section:

```markdown
## Outcome

COMPLETED
```

On no changes, conflicts, active Git operations, ambiguous scope, failed
commit, or failed hook, do not perform speculative cleanup. Record the failure
concisely and use:

```markdown
## Outcome

BLOCKED
```

Do not claim approval, implementation completion, test execution, push success,
or a clean worktree unless directly observed.
