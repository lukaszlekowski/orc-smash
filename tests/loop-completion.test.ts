import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { runLoop as baseRunLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { fakeAdapter } from '../src/adapters/fake.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { createMockOutput } from './helpers/mock-output.js';

const testRegistry = createTestAdapterRegistry();
const mockOutput = createMockOutput();
const runLoop = (
  projectRoot: string,
  loopName: string,
  loopSpec: any,
  config: any,
  runners: any,
  options: any
): any => {
  return baseRunLoop(projectRoot, loopName, loopSpec, config, runners, {
    ...options,
    registry: testRegistry,
    output: mockOutput
  });
};

describe('loop execution-completeness handling (consumes normalized completion field)', () => {
  const tempWorkspace = resolve(process.cwd(), 'temp-loop-completion');

  beforeEach(() => {
    createTempDir('temp-loop-completion');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    removeTempDir(tempWorkspace);
  });

  function setupProject() {
    const root = join(tempWorkspace, 'project');
    mkdirSync(join(root, 'docs/dev'), { recursive: true });
    writeFileSync(join(root, 'docs/dev/plan.md'), `# My Plan\nInitial content.\n`);
    return root;
  }

  const runners = {
    'plan-audit': { agent: 'fake', model: 'fake-model' },
    'plan-follow-up': { agent: 'fake', model: 'fake-model' }
  };

  // Injecting completion via the 'fake' adapter (agent !== 'opencode') proves the
  // loop branches ONLY on the normalized `completion` field, never on the agent
  // identity — no real opencode binary is involved.

  it('audit truncated completion => terminal unknown, before artifact parsing', async () => {
    const root = setupProject();
    const config = loadConfig(root);
    vi.spyOn(fakeAdapter, 'run').mockResolvedValue({
      stdout: '',
      exitCode: 0,
      completion: 'truncated',
      stopReason: 'length'
    });

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, runners, {
      maxIterations: 3,
      startPoint: 'fresh',
      interactive: false
    });

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('unknown');
    expect(result.message).toContain('Agent execution truncated or interrupted');
    expect(result.message).toContain('length');
    // Returned before artifact inspection: no audit file was written/parsed.
    expect(existsSync(join(root, 'docs/dev/plan-audit-v1-fake.md'))).toBe(false);
  });

  it('audit interrupted completion => terminal unknown, before artifact parsing', async () => {
    const root = setupProject();
    const config = loadConfig(root);
    vi.spyOn(fakeAdapter, 'run').mockResolvedValue({
      stdout: '',
      exitCode: 0,
      completion: 'interrupted',
      stopReason: null
    });

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, runners, {
      maxIterations: 3,
      startPoint: 'fresh',
      interactive: false
    });

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('unknown');
    expect(result.message).toContain('Agent execution truncated or interrupted');
    expect(existsSync(join(root, 'docs/dev/plan-audit-v1-fake.md'))).toBe(false);
  });

  it('requires an audit artifact even when a clean provider reports APPROVED on stdout', async () => {
    const root = setupProject();
    const config = loadConfig(root);
    const stepSucceeded: any[] = [];
    const stepFailed: any[] = [];
    vi.spyOn(fakeAdapter, 'run').mockResolvedValue({
      stdout: '## Verdict\n\nAPPROVED',
      exitCode: 0
    });

    const result = await baseRunLoop(root, 'plan', config.manifest.loops['plan']!, config, runners, {
      maxIterations: 3,
      interactive: false,
      registry: testRegistry,
      output: { ...mockOutput, stepSucceeded: (event: any) => stepSucceeded.push(event), stepFailed: (event: any) => stepFailed.push(event) }
    });

    expect(result).toMatchObject({ success: false, verdict: 'unknown' });
    expect(result.message).toContain('fake exited cleanly but produced no audit artifact at docs/dev/plan-audit-v1-fake.md');
    expect(existsSync(join(root, 'docs/dev/plan-audit-v1-fake.md'))).toBe(false);
    expect(stepSucceeded).toEqual([]);
    expect(stepFailed).toContainEqual(expect.objectContaining({ kind: 'audit', errorKind: 'missing_output' }));
  });

  it('requires a follow-up artifact before recording a patched step or starting the next audit', async () => {
    const root = setupProject();
    const config = loadConfig(root);
    const stepSucceeded: any[] = [];
    const stepFailed: any[] = [];
    writeFileSync(join(root, 'docs/dev/plan-audit-v1-fake.md'), '# Plan Audit\n\n## Verdict\n\nREJECTED\n');
    vi.spyOn(fakeAdapter, 'run').mockResolvedValue({ stdout: 'patched', exitCode: 0 });

    const result = await baseRunLoop(root, 'plan', config.manifest.loops['plan']!, config, runners, {
      maxIterations: 3,
      interactive: false,
      registry: testRegistry,
      output: { ...mockOutput, stepSucceeded: (event: any) => stepSucceeded.push(event), stepFailed: (event: any) => stepFailed.push(event) }
    });

    expect(result).toMatchObject({ success: false, verdict: 'unknown' });
    expect(result.message).toContain('fake exited cleanly but produced no follow-up artifact at docs/dev/plan-followup-v1-fake.md');
    expect(existsSync(join(root, 'docs/dev/plan-followup-v1-fake.md'))).toBe(false);
    expect(existsSync(join(root, 'docs/dev/plan-audit-v2-fake.md'))).toBe(false);
    expect(stepSucceeded).toEqual([]);
    expect(stepFailed).toContainEqual(expect.objectContaining({ kind: 'follow-up', errorKind: 'missing_output' }));
  });
});
