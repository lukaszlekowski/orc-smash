import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { smashAction } from '../src/commands/smash.js';
import { runTask } from '../src/loop.js';
import { createMockOutput } from './helpers/mock-output.js';
import type { RunEvent } from '../src/run-event.js';
import type { V1Manifest, TaskBinding } from '../src/manifest.js';
import { writeFileSync, mkdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import * as crypto from 'node:crypto';

vi.mock('../src/loop.js', () => {
  return {
    runTask: vi.fn(),
    runLoop: vi.fn(),
  };
});

interface MatrixCase {
  id: number;
  name: string;
  mockedValue?: any;
  expectedExit: number;
  expectedTerminal: string;
  expectedErrorKind?: string;
  expectedEvents: string[];
  expectedOwnership: 'finalized' | 'retained';
}

const matrixCases: MatrixCase[] = [
  {
    id: 1,
    name: 'Outcome 1: completed -> returns exitCode: 0, emits run.completed',
    mockedValue: {
      success: true,
      verdict: 'completed',
      message: 'task completed successfully',
      lastAuditPath: '/some/path',
      terminalEventEmitted: false,
      outcome: { kind: 'completed', message: 'task completed successfully', artifactPath: '/some/path' },
    },
    expectedExit: 0,
    expectedTerminal: 'run.completed',
    expectedEvents: [
      'run.started',
      'config.loaded',
      'binding.selected',
      'runner.resolved',
      'ownership.opened',
      'ownership.finalized',
      'run.completed'
    ],
    expectedOwnership: 'finalized'
  },
  {
    id: 2,
    name: 'Outcome 2: blocked -> returns exitCode: 1, emits run.failed',
    mockedValue: {
      success: false,
      verdict: 'blocked',
      message: 'task blocked by dependency',
      lastAuditPath: '/some/path',
      terminalEventEmitted: false,
      outcome: { kind: 'blocked', message: 'task blocked by dependency', artifactPath: '/some/path' },
    },
    expectedExit: 1,
    expectedTerminal: 'run.failed',
    expectedErrorKind: 'blocked',
    expectedEvents: [
      'run.started',
      'config.loaded',
      'binding.selected',
      'runner.resolved',
      'ownership.opened',
      'ownership.finalized',
      'run.failed'
    ],
    expectedOwnership: 'finalized'
  },
  {
    id: 3,
    name: 'Outcome 3: unknown -> returns exitCode: 1, emits run.failed',
    mockedValue: {
      success: false,
      verdict: 'unknown',
      message: 'malformed task output',
      lastAuditPath: '/some/path',
      terminalEventEmitted: false,
      outcome: { kind: 'unknown', message: 'malformed task output', artifactPath: '/some/path' },
    },
    expectedExit: 1,
    expectedTerminal: 'run.failed',
    expectedErrorKind: 'unknown',
    expectedEvents: [
      'run.started',
      'config.loaded',
      'binding.selected',
      'runner.resolved',
      'ownership.opened',
      'ownership.finalized',
      'run.failed'
    ],
    expectedOwnership: 'finalized'
  },
  {
    id: 4,
    name: 'Outcome 4: provider-failed -> returns exitCode: 1, emits run.failed',
    mockedValue: {
      success: false,
      verdict: 'unknown',
      message: 'provider exit 1',
      lastAuditPath: null,
      terminalEventEmitted: false,
      outcome: { kind: 'provider-failed', message: 'provider exit 1', errorKind: 'spawn', artifactPath: null },
    },
    expectedExit: 1,
    expectedTerminal: 'run.failed',
    expectedErrorKind: 'provider-failed',
    expectedEvents: [
      'run.started',
      'config.loaded',
      'binding.selected',
      'runner.resolved',
      'ownership.opened',
      'ownership.finalized',
      'run.failed'
    ],
    expectedOwnership: 'finalized'
  },
  {
    id: 5,
    name: 'Outcome 5: budget-exhausted -> returns exitCode: 1, emits run.failed',
    mockedValue: {
      success: false,
      verdict: 'unknown',
      message: 'budget limit hit',
      lastAuditPath: null,
      terminalEventEmitted: false,
      outcome: { kind: 'budget-exhausted', message: 'budget limit hit', artifactPath: null },
    },
    expectedExit: 1,
    expectedTerminal: 'run.failed',
    expectedErrorKind: 'budget-exhausted',
    expectedEvents: [
      'run.started',
      'config.loaded',
      'binding.selected',
      'runner.resolved',
      'ownership.opened',
      'ownership.finalized',
      'run.failed'
    ],
    expectedOwnership: 'finalized'
  },
  {
    id: 6,
    name: 'Outcome 6: ownership-lost -> returns exitCode: 2, emits run.failed',
    mockedValue: {
      success: false,
      verdict: 'ownership-lost',
      message: 'lease expired',
      lastAuditPath: null,
      terminalEventEmitted: false,
      outcome: { kind: 'ownership-lost', message: 'lease expired', artifactPath: null },
    },
    expectedExit: 2,
    expectedTerminal: 'run.failed',
    expectedErrorKind: 'ownership',
    expectedEvents: [
      'run.started',
      'config.loaded',
      'binding.selected',
      'runner.resolved',
      'ownership.opened',
      'ownership.finalized',
      'run.failed'
    ],
    expectedOwnership: 'finalized'
  }
];

describe('Task Smash Outcomes Matrix (M7 Verification)', () => {
  const testDir = join(process.cwd(), '.test-task-matrix-smash');
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

  describe.each(matrixCases)('$name', (c) => {
    it('asserts command-boundary event, terminal, ownership, and exit mappings', async () => {
      const { projectRoot } = setupTestProject();
      setupSupervisorOwnership(projectRoot);
      const events: RunEvent[] = [];
      const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

      vi.mocked(runTask).mockResolvedValue(c.mockedValue);

      const result = await smashAction({
        project: projectRoot,
        task: 'implement',
        output,
      });

      expect(result.exitCode).toBe(c.expectedExit);

      // 1. Verify ordered command-boundary event sequence
      const eventTypes = events.map(e => e.type);
      expect(eventTypes).toEqual(c.expectedEvents);

      // 2. Verify exactly one terminal event
      const terminals = eventTypes.filter(t => t === 'run.completed' || t === 'run.failed' || t === 'run.interrupted');
      expect(terminals).toEqual([c.expectedTerminal]);

      // Check the errorKind on the terminal event if applicable
      const terminalEvent = events.find(e => e.type === c.expectedTerminal) as any;
      if (c.expectedErrorKind !== undefined) {
        expect(terminalEvent.errorKind).toBe(c.expectedErrorKind);
      }

      // 3. Verify ownership disposition
      const activePath = join(projectRoot, '.orc-smash/active.json');
      if (c.expectedOwnership === 'finalized') {
        expect(existsSync(activePath)).toBe(false);
      } else {
        expect(existsSync(activePath)).toBe(true);
      }
    });
  });

  it('Outcome 8: real provider-failed -> runs through real executor, finalizes ownership as failed, and emits failed event sequence', async () => {
    const actualLoop = await vi.importActual<typeof import('../src/loop.js')>('../src/loop.js');
    vi.mocked(runTask).mockImplementation(actualLoop.runTask);

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
    expect(eventTypes).toEqual([
      'run.started',
      'config.loaded',
      'binding.selected',
      'runner.resolved',
      'ownership.opened',
      'provider.started',
      'provider.failed',
      'ownership.finalized',
      'run.failed'
    ]);

    const terminals = eventTypes.filter(t => t === 'run.completed' || t === 'run.failed' || t === 'run.interrupted');
    expect(terminals).toEqual(['run.failed']);

    const activePath = join(projectRoot, '.orc-smash/active.json');
    expect(existsSync(activePath)).toBe(false);
  });

  it('Outcome 9: real interrupted -> runs through real executor, trigger signal gate, writes marker, and exits with 130', async () => {
    const actualLoop = await vi.importActual<typeof import('../src/loop.js')>('../src/loop.js');
    vi.mocked(runTask).mockImplementation(actualLoop.runTask);

    const { projectRoot } = setupTestProject();
    setupSupervisorOwnership(projectRoot);
    const events: RunEvent[] = [];
    const output = createMockOutput({ emit: (e: RunEvent) => events.push(e) });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`EXIT:${code}`);
    });

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
    const interruptIndex = eventTypes.indexOf('run.interrupted');
    expect(interruptIndex).toBeGreaterThan(-1);

    const prefixEvents = eventTypes.slice(0, interruptIndex + 1);
    expect(prefixEvents).toEqual([
      'run.started',
      'config.loaded',
      'binding.selected',
      'runner.resolved',
      'ownership.opened',
      'provider.started',
      'run.interrupted'
    ]);

    const markerPath = join(projectRoot, '.orc-smash/interrupted.json');
    expect(existsSync(markerPath)).toBe(true);

    exitSpy.mockRestore();
  });
});
