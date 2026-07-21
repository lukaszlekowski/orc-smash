import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { runBinding } from '../src/loops/binding-engine.js';
import { DEFAULT_REGISTRY, type Config } from '../src/config.js';
import { fakeAdapter } from '../src/adapters/fake.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { createMockOutput } from './helpers/mock-output.js';
import type { RunEvent } from '../src/run-event.js';
import type { V1Manifest, TaskBinding } from '../src/manifest.js';
import type { Runner } from '../src/loops/runtime.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

describe('Task Engine Outcomes Matrix (M6 Verification)', () => {
  const testDir = join(process.cwd(), '.test-task-matrix');

  beforeEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  function setupTestProject(): { manifest: V1Manifest; projectRoot: string; taskBinding: TaskBinding; config: Config } {
    mkdirSync(join(testDir, 'docs/dev'), { recursive: true });
    mkdirSync(join(testDir, 'skills'), { recursive: true });
    mkdirSync(join(testDir, 'roles'), { recursive: true });
    writeFileSync(join(testDir, 'skills/implementer.md'), '# Implementer Skill');
    writeFileSync(join(testDir, 'roles/implementer.md'), '# Implementer Role');

    const taskBinding: TaskBinding = {
      target: { path: '.', kind: 'worktree' },
      inputs: [],
      skill: 'implement',
      output: { pattern: 'docs/dev/task-v{version}-{provider}.md', contract: 'completion-artifact' },
    };

    const manifest: V1Manifest = {
      schemaVersion: 1,
      roles: { implementer: 'roles/implementer.md' },
      skills: {
        implement: { file: 'skills/implementer.md', role: 'implementer', runnerProfile: 'implement' },
      },
      loops: {},
      tasks: {
        implement: taskBinding,
      },
      pipelines: {},
    };

    const config: Config = {
      manifest,
      registry: DEFAULT_REGISTRY,
      projectRoot: testDir,
      manifestPath: join(testDir, 'manifest.yaml'),
      manifestRoot: testDir,
    };

    return { manifest, projectRoot: testDir, taskBinding, config };
  }

  const runners: Record<string, Runner> = {
    implement: { agent: 'fake', model: 'fake-model' },
  };

  it('handles outcome 1: COMPLETED on valid completed artifact', async () => {
    const { projectRoot, taskBinding, config } = setupTestProject();
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const path = resolve(input.cwd, `docs/dev/task-v${input.version}-fake.md`);
      mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
      writeFileSync(path, '# Task\n\n## Outcome\n\nCOMPLETED\n');
      return { stdout: 'done', exitCode: 0 };
    });

    const result = await runBinding(
      projectRoot,
      'implement',
      'task',
      taskBinding,
      config,
      runners,
      { registry: createTestAdapterRegistry(), output, maxIterations: 1 }
    );

    expect(result.success).toBe(true);
    expect(result.outcome?.kind).toBe('completed');
    expect(events.some((e: RunEvent) => e.type === 'stage.completed')).toBe(true);
  });

  it('handles outcome 2: BLOCKED on task artifact with BLOCKED status', async () => {
    const { projectRoot, taskBinding, config } = setupTestProject();
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const path = resolve(input.cwd, `docs/dev/task-v${input.version}-fake.md`);
      mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
      writeFileSync(path, '# Task\n\n## Outcome\n\nBLOCKED\n');
      return { stdout: 'blocked', exitCode: 0 };
    });

    const result = await runBinding(
      projectRoot,
      'implement',
      'task',
      taskBinding,
      config,
      runners,
      { registry: createTestAdapterRegistry(), output, maxIterations: 1 }
    );

    expect(result.success).toBe(false);
    expect(result.outcome?.kind).toBe('blocked');
    expect(events.some((e: RunEvent) => e.type === 'stage.blocked')).toBe(true);
  });

  it('handles outcome 3: UNKNOWN on invalid task artifact content', async () => {
    const { projectRoot, taskBinding, config } = setupTestProject();
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const path = resolve(input.cwd, `docs/dev/task-v${input.version}-fake.md`);
      mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
      writeFileSync(path, '# Task without valid outcome section\n');
      return { stdout: 'invalid', exitCode: 0 };
    });

    const result = await runBinding(
      projectRoot,
      'implement',
      'task',
      taskBinding,
      config,
      runners,
      { registry: createTestAdapterRegistry(), output, maxIterations: 1 }
    );

    expect(result.success).toBe(false);
    expect(result.outcome?.kind).toBe('unknown');
  });

  it('handles outcome 4: INPUT MISSING when a declared file input is absent', async () => {
    const { projectRoot, taskBinding, config } = setupTestProject();
    taskBinding.files = { missingInput: 'nonexistent.txt' };
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    const result = await runBinding(
      projectRoot,
      'implement',
      'task',
      taskBinding,
      config,
      runners,
      { registry: createTestAdapterRegistry(), output, maxIterations: 1 }
    );

    expect(result.success).toBe(false);
    expect(result.outcome?.kind).toBe('unknown');
    expect(result.message).toContain('does not exist');
  });
});
