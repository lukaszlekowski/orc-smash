import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { captureTargetSnapshot } from '../src/target-snapshot.js';
import type { V1Manifest } from '../src/manifest.js';

describe('Target Snapshot Worktree Regression (m1)', () => {
  const testDir = join(process.cwd(), '.test-target-snapshot-regression');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  const manifest: V1Manifest = {
    schemaVersion: 1,
    roles: { implementer: 'roles/implementer.md' },
    skills: {
      implement: { file: 'skills/implementer.md', role: 'implementer', runnerProfile: 'implement' },
    },
    loops: {},
    tasks: {
      implement: {
        target: { path: '.', kind: 'worktree' },
        inputs: [],
        skill: 'implement',
        output: { pattern: 'docs/dev/impl-v{version}-{provider}.md', contract: 'completion-artifact' },
      },
    },
    pipelines: {},
  };

  it('captures successive unstaged edits, staged/untracked changes, deletion, symlinks, and artifact exclusions', () => {
    // 1. Initialize git repo
    execSync('git init', { cwd: testDir });
    execSync('git config user.name "Test"', { cwd: testDir });
    execSync('git config user.email "test@example.com"', { cwd: testDir });

    // 2. Create and commit base file
    const stagedFile = join(testDir, 'staged.md');
    writeFileSync(stagedFile, 'staged base content');
    execSync('git add staged.md', { cwd: testDir });
    execSync('git commit -m "initial commit"', { cwd: testDir });

    // 3. Make unstaged edits
    writeFileSync(stagedFile, 'staged modified content');

    // 4. Create staged changes
    const newlyStagedFile = join(testDir, 'newly-staged.md');
    writeFileSync(newlyStagedFile, 'newly staged content');
    execSync('git add newly-staged.md', { cwd: testDir });

    // 5. Create untracked changes
    const untrackedFile = join(testDir, 'untracked.md');
    writeFileSync(untrackedFile, 'untracked content');

    // 6. Create symlink
    const symlinkFile = join(testDir, 'link.md');
    symlinkSync('staged.md', symlinkFile);

    // 7. Create artifact output file matching pattern (must be excluded)
    mkdirSync(join(testDir, 'docs/dev'), { recursive: true });
    const artifactFile = join(testDir, 'docs/dev/impl-v1-fake.md');
    writeFileSync(artifactFile, 'artifact file');

    // 8. Create file inside .orc-smash directory (must be excluded)
    mkdirSync(join(testDir, '.orc-smash'), { recursive: true });
    writeFileSync(join(testDir, '.orc-smash/active.json'), '{"pid": 123}');

    // 9. Run captureTargetSnapshot
    const snapshot = captureTargetSnapshot(testDir, { kind: 'worktree', path: '.' }, manifest);

    // Verify staged, unstaged, untracked, symlinks are present
    expect(snapshot).toContain('worktree:git');
    expect(snapshot).toContain('head:');
    expect(snapshot).toContain('staged:newly-staged.md:');
    expect(snapshot).toContain('unstaged:staged.md:');
    expect(snapshot).toContain('untracked:');
    expect(snapshot).toContain('untracked.md:');
    expect(snapshot).toContain('link.md:symlink:');

    // Verify artifact file and .orc-smash are excluded
    expect(snapshot).not.toContain('impl-v1-fake.md');
    expect(snapshot).not.toContain('.orc-smash');
    expect(snapshot).not.toContain('active.json');

    // 10. Test Deletion
    const deletedFile = join(testDir, 'deleted.md');
    writeFileSync(deletedFile, 'to be deleted');
    execSync('git add deleted.md', { cwd: testDir });
    execSync('git commit -m "add deleted file"', { cwd: testDir });
    unlinkSync(deletedFile);

    const snapshotAfterDelete = captureTargetSnapshot(testDir, { kind: 'worktree', path: '.' }, manifest);
    expect(snapshotAfterDelete).toContain('deleted.md');
  });
});
