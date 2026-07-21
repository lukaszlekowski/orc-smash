import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { fakeAdapter } from '../src/adapters/fake.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { scanGlobalSnapshot } from '../src/state.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';

describe('generic per-step continuity', () => {
  const workspace = resolve(process.cwd(), 'temp-loop-continuity-test');
  const output = createMockOutput();

  beforeEach(() => {
    createTempDir('temp-loop-continuity-test');
    mkdirSync(join(workspace, 'docs/dev'), { recursive: true });
    writeFileSync(join(workspace, 'docs/dev/plan.md'), '# Plan\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeTempDir(workspace);
  });

  it('resumes only when the predecessor runner tuple and adapter capability match', async () => {
    const config = loadConfig(workspace);
    const calls: Array<{ kind?: string; continuity?: { mode: string; sessionId?: string } }> = [];
    let evaluation = 0;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      calls.push({ kind: input.kind, continuity: input.continuity });
      const outputMatch = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      const outputPath = outputMatch?.[1]?.trim();
      if (outputPath) {
        const absolute = resolve(input.cwd, outputPath);
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        if (input.kind === 'repair') {
          writeFileSync(absolute, '# Repair\n\n## Outcome\n\nCOMPLETED\n');
        } else {
          const token = evaluation++ === 0 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absolute, '# Evaluation\n\n## Verdict\n\n' + token + '\n');
        }
      }
      return { stdout: 'done', exitCode: 0, sessionId: 'session-a' };
    });

    const result = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan!,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model', effort: 'medium' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model', effort: 'medium' },
      },
      { maxIterations: 3, registry: createTestAdapterRegistry(), output, interactive: false },
    );

    expect(result.success).toBe(true);
    expect(calls.map(call => call.continuity?.mode)).toEqual(['fresh', 'fresh', 'fresh']);
    const snapshot = scanGlobalSnapshot(workspace, config.manifest);
    const steps = snapshot.byBinding.get('plan')!.filter(step => !step.unclassified);
    expect(steps).toHaveLength(3);
    expect(steps[1]!.parentArtifactIdentity).toBe(steps[0]!.artifactIdentity);
    expect(steps[2]!.parentArtifactIdentity).toBe(steps[1]!.artifactIdentity);
    expect(steps.every(step => step.sessionMode === 'fresh')).toBe(true);
  });

  it('resumes when the skill matches and strategy is resume-per-skill', async () => {
    const config = loadConfig(workspace);
    config.manifest.loops.plan!.repair.skill = 'plan-audit';

    const calls: Array<{ kind?: string; continuity?: { mode: string; sessionId?: string } }> = [];
    let evaluation = 0;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      calls.push({ kind: input.kind, continuity: input.continuity });
      const outputMatch = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      const outputPath = outputMatch?.[1]?.trim();
      if (outputPath) {
        const absolute = resolve(input.cwd, outputPath);
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        if (input.kind === 'repair') {
          writeFileSync(absolute, '# Repair\n\n## Outcome\n\nCOMPLETED\n');
        } else {
          const token = evaluation++ === 0 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absolute, '# Evaluation\n\n## Verdict\n\n' + token + '\n');
        }
      }
      return { stdout: 'done', exitCode: 0, sessionId: 'session-b' };
    });

    const result = await runLoop(
      workspace,
      'plan',
      config.manifest.loops.plan!,
      config,
      {
        'plan-audit': { agent: 'fake', model: 'fake-model', effort: 'medium' },
      },
      { maxIterations: 3, registry: createTestAdapterRegistry(), output, interactive: false, globalOverrides: { sessionStrategy: 'resume-per-skill' } },
    );

    expect(result.success).toBe(true);
    expect(calls.map(call => call.continuity?.mode)).toEqual(['fresh', 'resumed', 'resumed']);
  });

  it('falls back to a fresh session when the adapter does not advertise resume support', async () => {
    const config = loadConfig(workspace);
    const calls: string[] = [];
    const original = fakeAdapter.capabilities.resumeSession;
    fakeAdapter.capabilities.resumeSession = false;
    vi.spyOn(fakeAdapter, 'run').mockImplementation(async (input) => {
      calls.push(input.continuity?.mode ?? 'missing');
      const outputMatch = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      if (outputMatch?.[1]) {
        const absolute = resolve(input.cwd, outputMatch[1].trim());
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        if (input.kind === 'repair') writeFileSync(absolute, '## Outcome\n\nCOMPLETED\n');
        else writeFileSync(absolute, '## Verdict\n\nAPPROVED\n');
      }
      return { stdout: 'done', exitCode: 0, sessionId: 'session-a' };
    });

    try {
      const result = await runLoop(
        workspace,
        'plan',
        config.manifest.loops.plan!,
        config,
        {
          'plan-audit': { agent: 'fake', model: 'fake-model' },
          'plan-follow-up': { agent: 'fake', model: 'fake-model' },
        },
        { maxIterations: 2, registry: createTestAdapterRegistry(), output, interactive: false },
      );
      expect(result.success).toBe(true);
      expect(calls).toEqual(['fresh']);
    } finally {
      fakeAdapter.capabilities.resumeSession = original;
    }
  });
});
