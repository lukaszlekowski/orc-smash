import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop, runTask } from '../../src/loop.js';
import { loadConfig } from '../../src/config.js';
import { fakeAdapterState } from '../../src/adapters/fake.js';
import { createTestAdapterRegistry } from '../../src/adapters/testing.js';
import { createTempDir, removeTempDir } from '../helpers/fs.js';
import { createMockOutput } from '../helpers/mock-output.js';

describe('generic engine integration', () => {
  const project = resolve(process.cwd(), 'temp-e2e-workspace/project');
  const output = createMockOutput();

  beforeEach(() => {
    createTempDir('temp-e2e-workspace/project');
    mkdirSync(join(project, 'docs/dev'), { recursive: true });
    writeFileSync(join(project, 'docs/dev/plan.md'), '# Plan\n');
    fakeAdapterState.verdicts = [];
  });

  afterEach(() => removeTempDir(resolve(process.cwd(), 'temp-e2e-workspace')));

  const loopRunners = {
    'plan-audit': { agent: 'fake', model: 'fake-model' },
    'plan-follow-up': { agent: 'fake', model: 'fake-model' },
  };

  it('runs an immediate accepted evaluation and writes v1 provenance', async () => {
    const config = loadConfig(project);
    fakeAdapterState.verdicts = ['APPROVED'];
    const result = await runLoop(project, 'plan', config.manifest.loops.plan!, config, loopRunners, {
      maxIterations: 4,
      registry: createTestAdapterRegistry(),
      output,
      interactive: false,
    });
    expect(result.success).toBe(true);
    expect(result.outcome?.kind).toBe('completed');
    expect(readFileSync(result.lastAuditPath!, 'utf8')).toContain('kind: evaluate');
  });

  it('runs retry -> repair -> evaluation through the same engine', async () => {
    const config = loadConfig(project);
    fakeAdapterState.verdicts = ['REJECTED', 'APPROVED'];
    const result = await runLoop(project, 'plan', config.manifest.loops.plan!, config, loopRunners, {
      maxIterations: 4,
      registry: createTestAdapterRegistry(),
      output,
      interactive: false,
    });
    expect(result.success).toBe(true);
    expect(result.lastAuditPath).toContain('plan-audit-v2-fake.md');
    expect(readFileSync(join(project, 'docs/dev/plan-followup-v1-fake.md'), 'utf8')).toContain('## Outcome');
  });

  it('returns an explicit budget-exhausted outcome on a final retry', async () => {
    const config = loadConfig(project);
    fakeAdapterState.verdicts = ['REJECTED', 'REJECTED'];
    const result = await runLoop(project, 'plan', config.manifest.loops.plan!, config, loopRunners, {
      maxIterations: 2,
      registry: createTestAdapterRegistry(),
      output,
      interactive: false,
    });
    expect(result.success).toBe(false);
    expect(result.outcome?.kind).toBe('budget-exhausted');
    expect(result.verdict).toBe('retry');
  });

  it('runs the configured implementation task once', async () => {
    const config = loadConfig(project);
    const result = await runTask(project, 'implement', config.manifest.tasks!.implement!, config, {
      '30-simple-implement': { agent: 'fake', model: 'fake-model' },
    }, {
      maxIterations: 4,
      registry: createTestAdapterRegistry(),
      output,
      interactive: false,
    });
    expect(result.success).toBe(true);
    expect(result.outcome?.kind).toBe('completed');
    expect(result.lastAuditPath).toContain('impl-v1-fake.md');
  });
});
