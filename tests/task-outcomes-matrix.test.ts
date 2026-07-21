import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { smashAction } from '../src/commands/smash.js';
import { runTask } from '../src/loop.js';
import { createMockOutput } from './helpers/mock-output.js';
import type { RunEvent } from '../src/run-event.js';
import type { V1Manifest, TaskBinding } from '../src/manifest.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

vi.mock('../src/loop.js', () => {
  return {
    runTask: vi.fn(),
    runLoop: vi.fn(),
  };
});

describe('Task Smash Outcomes Matrix (M7 Verification)', () => {
  const testDir = join(process.cwd(), '.test-task-matrix-smash');

  beforeEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, 'docs/dev'), { recursive: true });
    mkdirSync(join(testDir, 'skills'), { recursive: true });
    mkdirSync(join(testDir, 'roles'), { recursive: true });
    writeFileSync(join(testDir, 'skills/implementer.md'), '# Implementer Skill');
    writeFileSync(join(testDir, 'roles/implementer.md'), '# Implementer Role');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(testDir, { recursive: true, force: true });
  });

  function setupTestProject(): { manifest: V1Manifest; projectRoot: string } {
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

    writeFileSync(join(testDir, '.orc-smash.yaml'), YAML.stringify(manifest));

    return { manifest, projectRoot: testDir };
  }

  it('Outcome 1: completed -> returns exitCode: 0, emits run.completed', async () => {
    const { projectRoot } = setupTestProject();
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    vi.mocked(runTask).mockResolvedValue({
      success: true,
      verdict: 'completed',
      message: 'task completed successfully',
      lastAuditPath: '/some/path',
      terminalEventEmitted: false,
      outcome: { kind: 'completed', message: 'task completed successfully', artifactPath: '/some/path' },
    });

    const result = await smashAction({
      project: projectRoot,
      task: 'implement',
      output,
    });

    expect(result.exitCode).toBe(0);
    expect(events.some(e => e.type === 'run.completed' && e.result === 'completed')).toBe(true);
  });

  it('Outcome 2: blocked -> returns exitCode: 1, emits run.failed', async () => {
    const { projectRoot } = setupTestProject();
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    vi.mocked(runTask).mockResolvedValue({
      success: false,
      verdict: 'blocked',
      message: 'task blocked by dependency',
      lastAuditPath: '/some/path',
      terminalEventEmitted: false,
      outcome: { kind: 'blocked', message: 'task blocked by dependency', artifactPath: '/some/path' },
    });

    const result = await smashAction({
      project: projectRoot,
      task: 'implement',
      output,
    });

    expect(result.exitCode).toBe(1);
    expect(events.some(e => e.type === 'run.failed' && e.errorKind === 'blocked')).toBe(true);
  });

  it('Outcome 3: unknown -> returns exitCode: 1, emits run.failed', async () => {
    const { projectRoot } = setupTestProject();
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    vi.mocked(runTask).mockResolvedValue({
      success: false,
      verdict: 'unknown',
      message: 'malformed task output',
      lastAuditPath: '/some/path',
      terminalEventEmitted: false,
      outcome: { kind: 'unknown', message: 'malformed task output', artifactPath: '/some/path' },
    });

    const result = await smashAction({
      project: projectRoot,
      task: 'implement',
      output,
    });

    expect(result.exitCode).toBe(1);
    expect(events.some(e => e.type === 'run.failed' && e.errorKind === 'unknown')).toBe(true);
  });

  it('Outcome 4: provider-failed -> returns exitCode: 1, emits run.failed', async () => {
    const { projectRoot } = setupTestProject();
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    vi.mocked(runTask).mockResolvedValue({
      success: false,
      verdict: 'unknown',
      message: 'provider exit 1',
      lastAuditPath: null,
      terminalEventEmitted: false,
      outcome: { kind: 'provider-failed', message: 'provider exit 1', errorKind: 'spawn', artifactPath: null },
    });

    const result = await smashAction({
      project: projectRoot,
      task: 'implement',
      output,
    });

    expect(result.exitCode).toBe(1);
    expect(events.some(e => e.type === 'run.failed' && e.errorKind === 'provider-failed')).toBe(true);
  });

  it('Outcome 5: budget-exhausted -> returns exitCode: 1, emits run.failed', async () => {
    const { projectRoot } = setupTestProject();
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    vi.mocked(runTask).mockResolvedValue({
      success: false,
      verdict: 'unknown',
      message: 'budget limit hit',
      lastAuditPath: null,
      terminalEventEmitted: false,
      outcome: { kind: 'budget-exhausted', message: 'budget limit hit', artifactPath: null },
    });

    const result = await smashAction({
      project: projectRoot,
      task: 'implement',
      output,
    });

    expect(result.exitCode).toBe(1);
    expect(events.some(e => e.type === 'run.failed' && e.errorKind === 'budget-exhausted')).toBe(true);
  });

  it('Outcome 6: ownership-lost -> returns exitCode: 2, emits run.failed', async () => {
    const { projectRoot } = setupTestProject();
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    vi.mocked(runTask).mockResolvedValue({
      success: false,
      verdict: 'ownership-lost',
      message: 'lease expired',
      lastAuditPath: null,
      terminalEventEmitted: false,
      outcome: { kind: 'ownership-lost', message: 'lease expired', artifactPath: null },
    });

    const result = await smashAction({
      project: projectRoot,
      task: 'implement',
      output,
    });

    expect(result.exitCode).toBe(2);
    expect(events.some(e => e.type === 'run.failed' && e.errorKind === 'ownership')).toBe(true);
  });

  it('Outcome 7: interrupted -> returns exitCode: 130, emits run.failed', async () => {
    const { projectRoot } = setupTestProject();
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    vi.mocked(runTask).mockResolvedValue({
      success: false,
      verdict: 'interrupted',
      message: 'SIGINT received',
      lastAuditPath: null,
      terminalEventEmitted: false,
      outcome: { kind: 'interrupted', message: 'SIGINT received', artifactPath: null },
    });

    const result = await smashAction({
      project: projectRoot,
      task: 'implement',
      output,
    });

    expect(result.exitCode).toBe(130);
    expect(events.some(e => e.type === 'run.failed' && e.errorKind === 'interrupted')).toBe(true);
  });
});
