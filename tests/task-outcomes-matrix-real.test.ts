import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { smashAction } from '../src/commands/smash.js';
import { createMockOutput } from './helpers/mock-output.js';
import type { RunEvent } from '../src/run-event.js';
import type { V1Manifest, TaskBinding } from '../src/manifest.js';
import { writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import * as crypto from 'node:crypto';

describe('Real Task outcomes matrix & ownership fence (M2)', () => {
  const testDir = join(process.cwd(), '.test-task-matrix-real');
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.restoreAllMocks();
    savedEnv = { ...process.env };
    delete process.env.ORC_RUN_ID;
    delete process.env.ORC_RUN_TOKEN;
    delete process.env.ORC_RUN_STATE_DIR;

    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, 'docs/dev'), { recursive: true });
    mkdirSync(join(testDir, 'skills'), { recursive: true });
    mkdirSync(join(testDir, 'roles'), { recursive: true });
    writeFileSync(join(testDir, 'skills/implementer.md'), '# Implementer Skill');
    writeFileSync(join(testDir, 'roles/implementer.md'), '# Implementer Role');
    writeFileSync(join(testDir, 'docs/dev/plan.md'), '# Plan\n');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.assign(process.env, savedEnv);
    rmSync(testDir, { recursive: true, force: true });
  });

  function setupTestProject(): { manifest: V1Manifest; projectRoot: string } {
    const taskBinding: TaskBinding = {
      target: { path: '.', kind: 'worktree' },
      inputs: [],
      skill: 'implement',
      output: { pattern: 'docs/dev/impl-v{version}-{provider}.md', contract: 'required-artifact', validator: 'implement-ledger' },
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

  function setupSupervisorOwnership(projectRoot: string): { runId: string; token: string; stateDir: string } {
    const runId = 'run-test-real';
    const token = 'secret-token-real';
    const stateDir = join(projectRoot, 'runstate');
    const runDir = join(stateDir, 'orc-smash', 'runs', runId);
    mkdirSync(runDir, { recursive: true });
    chmodSync(runDir, 0o700);

    const leaseIssuedMs = Date.now();
    const control = {
      schemaVersion: 1,
      runId,
      ownerTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
      projectRoot,
      hostInstanceId: 'host-1',
      leaseIssuedMs,
      leaseTtlMs: 60_000,
      leaseExpiresMs: leaseIssuedMs + 60_000,
      issuerRevision: 1
    };
    writeFileSync(join(runDir, 'control.json'), JSON.stringify(control), { mode: 0o600 });

    process.env['ORC_RUN_ID'] = runId;
    process.env['ORC_RUN_TOKEN'] = token;
    process.env['ORC_RUN_STATE_DIR'] = stateDir;

    return { runId, token, stateDir };
  }

  function createScriptedRegistry(adapterRunImpl: (input: any) => Promise<any>): any {
    const adapter = {
      name: 'opencode',
      capabilities: { resumeSession: true, effort: true },
      buildRun(input: any) {
        return { command: 'scripted-opencode', args: [input.prompt] };
      },
      run: adapterRunImpl
    };
    return {
      adapters: new Map([['opencode', adapter]])
    };
  }

  it('Outcome: completed -> runs through real executor, finalizes ownership as success, and emits complete event sequence', async () => {
    const { projectRoot } = setupTestProject();
    setupSupervisorOwnership(projectRoot);
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    const adapterRun = async (input: any) => {
      const outputPath = join(input.cwd, 'docs/dev/impl-v1-opencode.md');
      writeFileSync(outputPath,
        '# Implementation Evidence Ledger\n\n' +
        '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
        '| --- | --- | --- | --- | --- |\n' +
        '| Step 1 | src/x.ts | pnpm test | pass | none |\n\n' +
        '## Requirement Coverage\n\n' +
        '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
        '| --- | --- | --- | --- |\n' +
        '| Requirement | src/x.ts | pnpm test | pass |\n\n' +
        'State overall confidence: 1.00\n');
      return { stdout: 'done', exitCode: 0 };
    };

    const result = await smashAction({
      project: projectRoot,
      task: 'implement',
      agent: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      output,
      createAdapterRegistry: () => createScriptedRegistry(adapterRun),
    });

    if (result.exitCode !== 0) {
      console.log('Completed test failed result:', result);
      console.log('Events:', events);
    }

    expect(result.exitCode).toBe(0);

    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('run.started');
    expect(eventTypes).toContain('ownership.opened');
    expect(eventTypes).toContain('runner.resolved');
    expect(eventTypes).toContain('provider.started');
    expect(eventTypes).toContain('provider.completed');
    expect(eventTypes).toContain('ownership.finalized');
    expect(eventTypes).toContain('run.completed');

    const terminals = eventTypes.filter(t => t === 'run.completed' || t === 'run.failed' || t === 'run.interrupted');
    expect(terminals).toEqual(['run.completed']);

    const activePath = join(projectRoot, '.orc-smash/active.json');
    expect(existsSync(activePath)).toBe(false);
  });

  it('Outcome: provider-failed -> runs through real executor, finalizes ownership as failed, and emits failed event sequence', async () => {
    const { projectRoot } = setupTestProject();
    setupSupervisorOwnership(projectRoot);
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    const adapterRun = async () => {
      return { stdout: 'failed to run model', exitCode: 1 };
    };

    const result = await smashAction({
      project: projectRoot,
      task: 'implement',
      agent: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      output,
      createAdapterRegistry: () => createScriptedRegistry(adapterRun),
    });

    expect(result.exitCode).toBe(1);

    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('run.started');
    expect(eventTypes).toContain('ownership.opened');
    expect(eventTypes).toContain('runner.resolved');
    expect(eventTypes).toContain('provider.started');
    expect(eventTypes).toContain('provider.failed');
    expect(eventTypes).toContain('ownership.finalized');
    expect(eventTypes).toContain('run.failed');

    const terminals = eventTypes.filter(t => t === 'run.completed' || t === 'run.failed' || t === 'run.interrupted');
    expect(terminals).toEqual(['run.failed']);

    const activePath = join(projectRoot, '.orc-smash/active.json');
    expect(existsSync(activePath)).toBe(false);
  });

  it('Outcome: interrupted -> runs through real executor, trigger signal gate, writes marker, and exits with 130', async () => {
    const { projectRoot } = setupTestProject();
    setupSupervisorOwnership(projectRoot);
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const adapterRun = async () => {
      const { handleInterruptSignal } = await import('../src/interrupted-artifact.js');
      await handleInterruptSignal('SIGINT');
      return { stdout: 'interrupted', exitCode: 0 };
    };

    await smashAction({
      project: projectRoot,
      task: 'implement',
      agent: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      output,
      createAdapterRegistry: () => createScriptedRegistry(adapterRun),
    });

    expect(exitSpy).toHaveBeenCalledWith(130);

    const eventTypes = events.map(e => e.type);
    expect(eventTypes).toContain('run.started');
    expect(eventTypes).toContain('ownership.opened');
    expect(eventTypes).toContain('runner.resolved');
    expect(eventTypes).toContain('provider.started');
    expect(eventTypes).toContain('run.interrupted');

    const markerPath = join(projectRoot, '.orc-smash/interrupted.json');
    expect(existsSync(markerPath)).toBe(true);

    exitSpy.mockRestore();
  });
});
