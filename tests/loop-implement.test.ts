import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runTask } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { fakeAdapter } from '../src/adapters/fake.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';

describe('generic one-off task execution', () => {
  const tempWorkspace = resolve(process.cwd(), 'temp-loop-implement');
  const output = createMockOutput();

  beforeEach(() => {
    createTempDir('temp-loop-implement');
    mkdirSync(join(tempWorkspace, 'docs/dev'), { recursive: true });
    writeFileSync(join(tempWorkspace, 'docs/dev/plan.md'), '# Plan\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeTempDir(tempWorkspace);
  });

  function taskOptions(config: ReturnType<typeof loadConfig>) {
    return {
      maxIterations: 4,
      registry: createTestAdapterRegistry(),
      output,
      interactive: false,
      globalOverrides: { agent: 'fake', model: 'fake-model' },
    };
  }

  it('runs the configured task exactly once and stamps ad-hoc v1 provenance', async () => {
    const config = loadConfig(tempWorkspace);
    const task = config.manifest.tasks!.implement!;
    const result = await runTask(
      tempWorkspace,
      'implement',
      task,
      config,
      { '30-simple-implement': { agent: 'fake', model: 'fake-model' } },
      taskOptions(config),
    );

    expect(result.success).toBe(true);
    expect(result.outcome?.kind).toBe('completed');
    expect(result.lastAuditPath).toContain('impl-v1-fake.md');
    const artifact = readFileSync(result.lastAuditPath!, 'utf8');
    expect(artifact).toContain('kind: task');
    expect(artifact).toContain('step: task');
    expect(artifact).toContain('bindingKind: task');
    expect(artifact).toContain('pipelineId: null');
    expect(artifact).toContain('parentArtifactIdentity: null');
    expect(artifact).toContain('artifactIdentity:');
    expect(artifact).toContain('## Requirement Coverage');
  });

  it('does not advance when a required-artifact validator fails', async () => {
    const config = loadConfig(tempWorkspace);
    const task = config.manifest.tasks!.implement!;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      const match = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      if (match?.[1]) {
        const path = resolve(input.cwd, match[1].trim());
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        writeFileSync(path, '# incomplete ledger\n');
      }
      return { stdout: 'done', exitCode: 0 };
    });

    const result = await runTask(
      tempWorkspace,
      'implement',
      task,
      config,
      { '30-simple-implement': { agent: 'fake', model: 'fake-model' } },
      taskOptions(config),
    );

    expect(result.success).toBe(false);
    expect(result.outcome?.kind).toBe('unknown');
    expect(result.message).toContain('invalid');
    expect(readFileSync(join(tempWorkspace, 'docs/dev/impl-v1-fake.md'), 'utf8')).not.toContain('schemaVersion: 1');
  });

  it('returns unknown before provider execution when a declared project file is missing', async () => {
    const config = loadConfig(tempWorkspace);
    const task = config.manifest.tasks!.implement!;
    const run = vi.spyOn(fakeAdapter, 'run');
    const planPath = join(tempWorkspace, 'docs/dev/plan.md');
    // The task input is declared, so this is an executor-level input failure
    // for direct engine callers; smashAction performs the earlier preflight.
    writeFileSync(planPath, '');
    const result = await runTask(
      tempWorkspace,
      'implement',
      task,
      config,
      { '30-simple-implement': { agent: 'fake', model: 'fake-model' } },
      taskOptions(config),
    );
    expect(result.success).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
