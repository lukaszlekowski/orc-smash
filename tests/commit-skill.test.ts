import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..');
const role = readFileSync(resolve(repoRoot, 'roles/committer.md'), 'utf8');
const skill = readFileSync(resolve(repoRoot, 'skills/50-simple-commit/SKILL.md'), 'utf8');
const normalizedRole = role.toLowerCase().replace(/\s+/g, ' ');
const normalizedSkill = skill.toLowerCase().replace(/\s+/g, ' ');

describe('50-simple-commit safety contract', () => {
  it('defines the committer role as packaging existing operator changes', () => {
    expect(role).toContain('one responsibility');
    expect(role).toContain('existing working-tree changes');
    expect(normalizedRole).toContain('preserve unrelated operator changes');
    expect(normalizedRole).toContain('blocked over guessing');
    expect(normalizedRole).toContain('ai-authorship');
  });

  it('covers the required clear-scope and blocked-state fixtures', () => {
    const fixtures = [
      ['clear intended changes', 'When the scope is clear:', 'COMPLETED'],
      ['no changes', 'Confirm that there are changes worth committing.', 'BLOCKED'],
      ['conflicts or active Git operations', 'conflicts or an active merge, rebase, cherry-pick, or revert', 'BLOCKED'],
      ['ambiguous scope', 'If unrelated staged changes or ambiguous files cannot be separated safely', 'BLOCKED'],
    ] as const;

    for (const [, instruction, outcome] of fixtures) {
      expect(normalizedSkill).toContain(instruction.toLowerCase());
      expect(normalizedSkill).toContain(outcome.toLowerCase());
    }
  });

  it('requires explicit-path staging and preserves unrelated state', () => {
    expect(normalizedSkill).toContain('stage explicit intended paths');
    expect(normalizedSkill).toContain('never use `git add -a` or `git add .`');
    expect(normalizedSkill).toContain('preserve unrelated staged, unstaged, and untracked changes');
    expect(normalizedSkill).toContain('a path with both staged and unstaged changes is blocked');
  });

  it('does not require approval artifacts and forbids direct verification or destructive Git work', () => {
    expect(normalizedSkill).toContain('do not require an approved plan or review artifact.');
    expect(normalizedSkill).toContain('do not run tests, builds, typechecks, linters, formatters');
    expect(normalizedSkill).toContain('never push, fetch, pull, amend, force-update, reset, clean');
    expect(normalizedSkill).toContain('allow configured git hooks to run normally');
    expect(normalizedSkill).toContain('direct verification commands run by commit skill: none (by contract)');
    expect(normalizedSkill).toContain('exact supplied `outputpath`');
  });

  it('requires truthful completion evidence without agent attribution', () => {
    expect(normalizedSkill).toContain('record the inspected repository state');
    expect(normalizedSkill).toContain('commit subject and full commit id');
    expect(normalizedSkill).toContain('remaining staged/modified/ untracked paths');
    expect(normalizedSkill).toContain('exclude ai-authorship and agent-attribution boilerplate');
    expect(normalizedSkill).toContain('do not claim approval, implementation completion, test execution, push success');
  });
});
