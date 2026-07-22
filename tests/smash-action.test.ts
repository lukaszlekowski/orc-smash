import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import crypto from 'node:crypto';
import { smashAction } from '../src/commands/smash.js';
import type { AgentAdapter, RunInput, RunResult } from '../src/adapters/types.js';
import type { AgentRegistry } from '../src/adapters/registry.js';
import type { RunEvent } from '../src/run-event.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';
import { promptLoopSelect, promptMaxIterations, promptPostRunRecovery, promptTopLevelMenu, promptLoopSubmenu, promptPipelineLaunchContext, promptRunners, promptCandidateSelection, promptTaskMenu, promptTaskDetailConfirmation } from '../src/interactive.js';
import { terminateOwnedRuntimes } from '../src/owned-runtime-registry.js';
import { getProcessStartTime, getProcessCommand } from '../src/process-identity.js';

vi.mock('../src/interactive.js', () => {
  return {
    promptLoopSelect: vi.fn(),
    promptMaxIterations: vi.fn(),
    promptPostRunRecovery: vi.fn(),
    promptRunners: vi.fn(),
    promptTopLevelMenu: vi.fn(),
    promptLoopSubmenu: vi.fn(),
    promptPipelineLaunchContext: vi.fn(),
    promptCandidateSelection: vi.fn(),
    promptIterationExtension: vi.fn(),
    promptTaskMenu: vi.fn(),
    promptTaskDetailConfirmation: vi.fn(),
  };
});

vi.mock('../src/owned-runtime-registry.js', () => {
  return {
    terminateOwnedRuntimes: vi.fn(),
  };
});

const MODEL = 'opencode-go/deepseek-v4-flash';

function scriptedAdapter(decisions: string[] = ['APPROVED']): AgentAdapter {
  let evaluation = 0;
  return {
    name: 'opencode',
    capabilities: { resumeSession: true, effort: true },
    buildRun(input: RunInput) {
      return { command: 'scripted-opencode', args: [input.prompt] };
    },
    run: vi.fn(async (input: RunInput): Promise<RunResult> => {
      const match = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
      if (match?.[1]) {
        const outputPath = resolve(input.cwd, match[1].trim());
        mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
        if (input.kind === 'task') {
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
        } else if (input.kind === 'repair') {
          writeFileSync(outputPath, '# Repair\n\n## Outcome\n\nCOMPLETED\n');
        } else {
          writeFileSync(outputPath, '# Evaluation\n\n## Verdict\n\n' + (decisions[evaluation++] ?? 'APPROVED') + '\n');
        }
      }
      return { stdout: 'done', exitCode: 0, sessionId: 'scripted-session' };
    }),
  };
}

function registry(adapter: AgentAdapter): AgentRegistry {
  return { adapters: new Map([['opencode', adapter]]) };
}

describe('generic smash dispatch', () => {
  const project = resolve(process.cwd(), 'temp-smash-action');
  const output = createMockOutput();

  beforeEach(() => {
    vi.mocked(terminateOwnedRuntimes).mockResolvedValue([]);
    createTempDir('temp-smash-action');
    mkdirSync(join(project, 'docs/dev'), { recursive: true });
    writeFileSync(join(project, 'docs/dev/plan.md'), '# Plan\n');
  });

  afterEach(() => removeTempDir(project));

  function run(options: Record<string, unknown> = {}) {
    const adapter = scriptedAdapter();
    return smashAction({
      project,
      agent: 'opencode',
      model: MODEL,
      output,
      createAdapterRegistry: () => registry(adapter),
      ...options,
    } as any);
  }

  it('runs a direct approval loop as an ad-hoc chain', async () => {
    const result = await run({ loop: 'plan' });
    expect(result.exitCode).toBe(0);
    const artifact = readFileSync(join(project, 'docs/dev/plan-audit-v1-opencode.md'), 'utf8');
    expect(artifact).toContain('chainMode: ad-hoc');
    expect(artifact).toContain('pipelineId: null');
    expect(artifact).toContain('stageId: null');
    expect(artifact).toContain('parentArtifactIdentity: null');
  });

  it('dispatches a task binding exactly once', async () => {
    const result = await run({ task: 'implement' });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(join(project, 'docs/dev/impl-v1-opencode.md'), 'utf8')).toContain('bindingKind: task');
  });

  it('starts a pipeline with pipeline and stage identity', async () => {
    const result = await run({ pipeline: 'default' });
    expect(result.exitCode).toBe(0);
    const artifact = readFileSync(join(project, 'docs/dev/plan-audit-v1-opencode.md'), 'utf8');
    expect(artifact).toContain('pipelineId: default');
    expect(artifact).toContain('stageId: plan');
    expect(artifact).toMatch(/pipelineRunId: [^\n]+/);
  });

  it('rejects a runner override outside the selected task before provider spawn', async () => {
    const result = await run({
      task: 'implement',
      runner: ['plan-audit=opencode'],
    });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('not a valid skill in the selected loop');
  });

  it('fails input preflight before runner resolution when a declared file is missing', async () => {
    unlinkSync(join(project, 'docs/dev/plan.md'));
    const result = await run({ task: 'implement' });
    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('planPath=docs/dev/plan.md');
  });

  describe('F11 Interactive vs Non-interactive Recovery Matrix', () => {
    let savedEnv: NodeJS.ProcessEnv;

    beforeEach(() => {
      vi.clearAllMocks();
      savedEnv = { ...process.env };
      delete process.env.ORC_RUN_ID;
      delete process.env.ORC_RUN_TOKEN;
      delete process.env.ORC_RUN_STATE_DIR;
    });

    afterEach(() => {
      Object.assign(process.env, savedEnv);
    });

    function mockInteractiveStartup(loopId = 'plan'): void {
      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('start-loop');
      vi.mocked(promptLoopSelect).mockResolvedValueOnce(loopId);
      vi.mocked(promptLoopSubmenu).mockResolvedValueOnce('start-fresh-loop');
      vi.mocked(promptPipelineLaunchContext).mockResolvedValueOnce({ kind: 'ad-hoc' } as any);
    }

    it('Interactive mode: successful run followed by menu choice exit', async () => {
      mockInteractiveStartup();
      vi.mocked(promptMaxIterations).mockResolvedValueOnce(4);
      vi.mocked(promptPostRunRecovery).mockResolvedValueOnce('exit');

      const adapter = scriptedAdapter();
      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(0);
      expect(promptTopLevelMenu).toHaveBeenCalledTimes(1);
      expect(promptLoopSubmenu).toHaveBeenCalledTimes(1);
      expect(promptMaxIterations).toHaveBeenCalledTimes(1);
      expect(promptPostRunRecovery).toHaveBeenCalledTimes(1);
    });

    it('Interactive mode: task detail Back returns to task chooser menu without re-rendering startup snapshot', async () => {
      // 1. Top menu -> run-task
      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('run-task');
      // 2. Task menu -> implement
      vi.mocked(promptTaskMenu).mockResolvedValueOnce('implement' as any);
      // 3. Task detail -> back
      vi.mocked(promptTaskDetailConfirmation).mockResolvedValueOnce('back');
      // 4. Task menu again -> back to top menu
      vi.mocked(promptTaskMenu).mockResolvedValueOnce('back' as any);
      // 5. Top menu -> stop
      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('stop');

      const adapter = scriptedAdapter();
      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(0);
      expect(promptTaskMenu).toHaveBeenCalledTimes(2);
      expect(promptTaskDetailConfirmation).toHaveBeenCalledTimes(1);
    });

    it('Interactive mode: provider failure followed by menu choice menu then exit', async () => {
      // First run
      mockInteractiveStartup();
      vi.mocked(promptMaxIterations).mockResolvedValueOnce(4);
      vi.mocked(promptPostRunRecovery).mockResolvedValueOnce('menu');
      // Second run
      mockInteractiveStartup();
      vi.mocked(promptMaxIterations).mockResolvedValueOnce(4);
      vi.mocked(promptPostRunRecovery).mockResolvedValueOnce('exit');

      // Mock failure adapter
      const adapter: AgentAdapter = {
        name: 'opencode',
        capabilities: { resumeSession: true, effort: true },
        buildRun: () => ({ command: 'scripted-opencode', args: [] }),
        run: async () => ({ stdout: 'failed model run', exitCode: 1 }),
      };

      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(1);
      expect(promptTopLevelMenu).toHaveBeenCalledTimes(2);
      expect(promptLoopSubmenu).toHaveBeenCalledTimes(2);
      expect(promptMaxIterations).toHaveBeenCalledTimes(2);
      expect(promptPostRunRecovery).toHaveBeenCalledTimes(2);
    });

    it('Interactive mode: missing project input preflight and retry loop', async () => {
      vi.mocked(promptMaxIterations).mockResolvedValue(4);
      vi.mocked(promptPostRunRecovery).mockResolvedValue('exit');

      // Remove input file
      const planPath = join(project, 'docs/dev/plan.md');
      if (existsSync(planPath)) unlinkSync(planPath);

      // First call (preflight fails)
      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('start-loop');
      vi.mocked(promptLoopSelect).mockResolvedValueOnce('plan');
      vi.mocked(promptLoopSubmenu).mockResolvedValueOnce('start-fresh-loop');
      vi.mocked(promptPipelineLaunchContext).mockResolvedValueOnce({ kind: 'ad-hoc' } as any);

      // Create a mock that restores the file during the second call
      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('start-loop');
      vi.mocked(promptLoopSelect).mockImplementationOnce(async () => {
        writeFileSync(planPath, '# Plan\n');
        return 'plan';
      });
      vi.mocked(promptLoopSubmenu).mockResolvedValueOnce('start-fresh-loop');
      vi.mocked(promptPipelineLaunchContext).mockResolvedValueOnce({ kind: 'ad-hoc' } as any);

      const adapter = scriptedAdapter();
      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(0);
      expect(promptTopLevelMenu).toHaveBeenCalledTimes(2);
      expect(promptLoopSelect).toHaveBeenCalledTimes(2);
      expect(promptLoopSubmenu).toHaveBeenCalledTimes(2);
    });

    it('Interactive mode: safety-critical ownership failure (exits directly without prompting recovery)', async () => {
      mockInteractiveStartup();
      vi.mocked(promptMaxIterations).mockResolvedValue(4);

      // Trigger safety critical ownership mismatch (ambiguous mode)
      process.env['ORC_RUN_ID'] = 'run-id-mismatch';

      const adapter = scriptedAdapter();
      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(2);
      expect(promptPostRunRecovery).not.toHaveBeenCalled();
    });

    it('Non-interactive mode: provider failure does NOT prompt recovery', async () => {
      const adapter: AgentAdapter = {
        name: 'opencode',
        capabilities: { resumeSession: true, effort: true },
        buildRun: () => ({ command: 'scripted-opencode', args: [] }),
        run: async () => ({ stdout: 'failed model run', exitCode: 1 }),
      };

      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        task: 'implement',
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(1);
      expect(promptPostRunRecovery).not.toHaveBeenCalled();
    });

    it('Non-interactive mode: missing project input preflight does NOT prompt recovery', async () => {
      const planPath = join(project, 'docs/dev/plan.md');
      if (existsSync(planPath)) unlinkSync(planPath);

      const adapter = scriptedAdapter();
      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        task: 'implement',
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(1);
      expect(promptPostRunRecovery).not.toHaveBeenCalled();
    });

    it('Blocked finalization: blocked ownership loss retains admission fail-closed', async () => {
      vi.mocked(promptLoopSelect).mockResolvedValue('plan');
      vi.mocked(promptMaxIterations).mockResolvedValue(4);

      // Setup supervisor ownership
      const runId = 'run-test-blocked';
      const token = 'secret-token';
      const stateDir = join(project, 'runstate');
      const runDir = join(stateDir, 'orc-smash', 'runs', runId);
      mkdirSync(runDir, { recursive: true });
      chmodSync(runDir, 0o700);

      const leaseIssuedMs = Date.now();
      const control = {
        schemaVersion: 1,
        runId,
        ownerTokenHash: crypto.createHash('sha256').update(token).digest('hex'),
        projectRoot: project,
        hostInstanceId: 'host-1',
        leaseIssuedMs,
        leaseTtlMs: 60_000,
        leaseExpiresMs: leaseIssuedMs + 60_000,
        issuerRevision: 1
      };
      writeFileSync(join(runDir, 'control.json'), JSON.stringify(control), { mode: 0o600 });
      writeFileSync(join(runDir, 'active.json'), JSON.stringify({
        schemaVersion: 1,
        cliIdentity: {
          pid: process.pid,
          startMs: getProcessStartTime(process.pid),
          command: getProcessCommand(process.pid)
        },
        groups: [{
          pgid: 12345,
          leaderPid: 12346,
          sessionId: 12347,
          leaderStartMs: Date.now(),
          command: 'node'
        }],
        state: 'running',
        cliRevision: 1
      }), { mode: 0o600 });

      const projectHash = crypto.createHash('sha256').update(resolve(project)).digest('hex');
      const actualLockPath = join(stateDir, 'orc-smash', 'projects', projectHash, 'project.lock');

      process.env['ORC_RUN_ID'] = runId;
      process.env['ORC_RUN_TOKEN'] = token;
      process.env['ORC_RUN_STATE_DIR'] = stateDir;

      // Mock terminateOwnedRuntimes to return a rejected termination (blocked process group)
      vi.mocked(terminateOwnedRuntimes).mockResolvedValueOnce([
        {
          capability: { pgid: 12345, leaderPid: 12346 } as any,
          result: {
            outcome: 'rejected',
            sent: false,
            signal: 'SIGTERM',
            target: { pgid: 12345, leaderPid: 12346, source: 'fresh' },
            decision: { outcome: 'rejected', kind: 'leader-gone', reason: 'unkillable leader' },
            reason: 'unkillable leader',
          },
          retired: false
        }
      ]);

      const events: RunEvent[] = [];
      const eventOutput = createMockOutput({ emit: (e: RunEvent) => events.push(e) });
      const adapter = scriptedAdapter();
      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output: eventOutput,
        task: 'implement',
        createAdapterRegistry: () => registry(adapter),
      } as any);

      // 1. Returns exit code 2 (representing ownership/finalization failure)
      expect(result.exitCode).toBe(2);

      // 2. ownership.finalized is emitted with success: false (blocked
      //    finalization cannot be converted to a clean release)
      const finalizedEvents = events.filter(e => e.type === 'ownership.finalized');
      expect(finalizedEvents).toHaveLength(1);
      expect((finalizedEvents[0] as any).success).toBe(false);

      // 3. Admission is retained (fail-closed, i.e., project.lock is NOT removed)
      expect(existsSync(actualLockPath)).toBe(true);

      // 4. active.json is updated to state 'failed' with reason
      const active = JSON.parse(readFileSync(join(runDir, 'active.json'), 'utf-8'));
      expect(active.state).toBe('failed');
      expect(active.reason).toContain('terminal ownership-failure');
    });

    it('Non-interactive mode: output flush failure overrides exit code to 1 and does not prompt recovery', async () => {
      const adapter = scriptedAdapter();

      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output: createMockOutput({
          emit: () => {},
          flush: async () => { throw new Error('writer broken'); },
        }),
        task: 'implement',
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('Output flush failed');
      expect(promptPostRunRecovery).not.toHaveBeenCalled();
    });
  });

  describe('F7 Continue wiring', () => {
    const continueProject = resolve(process.cwd(), 'temp-smash-continue');
    const output = createMockOutput();

    beforeEach(() => {
      delete process.env.ORC_RUN_ID;
      delete process.env.ORC_RUN_TOKEN;
      delete process.env.ORC_RUN_STATE_DIR;
      createTempDir('temp-smash-continue');
      mkdirSync(join(continueProject, 'docs/dev'), { recursive: true });
      writeFileSync(join(continueProject, 'docs/dev/plan.md'), '# Plan\n');
      writeFileSync(join(continueProject, '.orc-smash.yaml'), JSON.stringify({
        schemaVersion: 1,
        roles: { testRole: 'roles/testRole.md' },
        skills: {
          evaluate: { file: 'skills/evaluate.md', role: 'testRole', runnerProfile: 'audit' },
          repair: { file: 'skills/repair.md', role: 'testRole', runnerProfile: 'repairProfile' },
        },
        loops: {
          test: {
            type: 'approval-loop',
            target: { path: 'docs/dev/plan.md', kind: 'file' },
            inputs: [{ source: 'target' }, { source: 'version' }, { source: 'outputPath' }],
            evaluate: {
              skill: 'evaluate',
              output: { pattern: 'docs/dev/audit-v{version}-{provider}.md', contract: 'decision-artifact', decision: { heading: 'Verdict', accepted: 'YES', retry: 'NO' } },
            },
            repair: {
              skill: 'repair',
              output: { pattern: 'docs/dev/repair-v{version}-{provider}.md', contract: 'completion-artifact' },
            },
          },
        },
        tasks: {},
        pipelines: {},
      }));
      mkdirSync(join(continueProject, 'roles'), { recursive: true });
      mkdirSync(join(continueProject, 'skills'), { recursive: true });
      writeFileSync(join(continueProject, 'roles/testRole.md'), '# Role\n');
      writeFileSync(join(continueProject, 'skills/evaluate.md'), '# Evaluate\n');
      writeFileSync(join(continueProject, 'skills/repair.md'), '# Repair\n');
    });

    afterEach(async () => {
      removeTempDir(continueProject);
      const { DEFAULT_REGISTRY } = await import('../src/config.js');
      delete DEFAULT_REGISTRY.profiles['repairProfile'];
    });

    it('Continue label shows the distinct repair runner tuple which matches execution', async () => {
      const { loadConfig, DEFAULT_REGISTRY } = await import('../src/config.js');
      const { runLoop } = await import('../src/loop.js');

      // Inject BEFORE first loadConfig so the profile is available to both
      // the test config and the smashAction config.
      DEFAULT_REGISTRY.profiles['repairProfile'] = { provider: 'codex', model: 'codex-model' };
      const config = loadConfig(continueProject);
      let evalCalls = 0;
      const evalAdapter: AgentAdapter = {
        name: 'opencode', capabilities: { resumeSession: true, effort: true },
        buildRun: () => ({ command: 'eval', args: [] }),
        run: async (input) => {
          if (input.kind === 'repair') return { stdout: 'done', exitCode: 0, sessionId: 's' };
          const m = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
          if (!m?.[1]) return { stdout: 'done', exitCode: 0, sessionId: 's' };
          mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
          evalCalls++;
          writeFileSync(resolve(input.cwd, m[1].trim()),
            evalCalls <= 1 ? '# Evaluation\n\n## Verdict\n\nNO\n' : '# Evaluation\n\n## Verdict\n\nYES\n');
          return { stdout: 'done', exitCode: 0, sessionId: 's' };
        },
      };
      const repairAdapter: AgentAdapter = {
        name: 'codex', capabilities: { resumeSession: true, effort: true },
        buildRun: () => ({ command: 'repair', args: [] }),
        run: async (input) => {
          const m = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
          if (!m?.[1]) return { stdout: 'done', exitCode: 0, sessionId: 's' };
          mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
          writeFileSync(resolve(input.cwd, m[1].trim()), '# Repair\n\n## Outcome\n\nCOMPLETED\n');
          return { stdout: 'done', exitCode: 0, sessionId: 'codex-repair' };
        },
      };
      const dualReg: AgentRegistry = {
        adapters: new Map([['opencode', evalAdapter], ['codex', repairAdapter]]),
      };

      // Phase 1: retry-pending evaluate via opencode with codex configured for repair
      await runLoop(
        continueProject, 'test', config.manifest.loops.test!, config,
        { evaluate: { agent: 'opencode', model: MODEL }, repair: { agent: 'codex', model: 'codex-model' } },
        { maxIterations: 1, registry: dualReg, output, interactive: false },
      );

      // Phase 2: mock Continue via smashAction
      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('start-loop');
      vi.mocked(promptMaxIterations).mockResolvedValueOnce(4);
      vi.mocked(promptLoopSubmenu).mockResolvedValueOnce('continue-current-loop');
      vi.mocked(promptPipelineLaunchContext).mockResolvedValueOnce({ kind: 'ad-hoc' } as any);
      vi.mocked(promptPostRunRecovery).mockResolvedValueOnce('exit');

      // Verify the profile is in a fresh loadConfig (as smashAction would do)
      // Don't pass agent/model globally — that would override the repair
      // profile via resolveWithGlobalOverrides.  Leave runner resolution to
      // profiles (mock promptRunners so the interactive flow can complete).
      vi.mocked(promptRunners).mockResolvedValueOnce({
        evaluate: { agent: 'opencode', model: MODEL },
        repair: { agent: 'codex', model: 'codex-model' },
      });

      const result = await smashAction({
        project: continueProject,
        output, createAdapterRegistry: () => dualReg,
      } as any);

      expect(result.exitCode).toBe(0);

      // Assert the Continue label names the repair skill AND the distinct
      // codex/codex-model runner tuple (not the evaluate's opencode/MODEL).
      const afterCalls = vi.mocked(promptLoopSubmenu).mock.calls;
      expect(afterCalls.length).toBeGreaterThanOrEqual(1);
      const items: any[] = afterCalls[0]![0] ?? [];
      const continueItem = items.find((c: any) => c.id === 'continue-current-loop');
      expect(continueItem).toBeTruthy();
      expect(continueItem.label).toContain('repair');
      expect(continueItem.label).toContain('codex/codex-model');

      // Verify the repair step was executed with the distinct tuple
      const { scanGlobalSnapshot: snap } = await import('../src/state.js');
      const ss = snap(continueProject, config.manifest);
      const repairStep = ss.steps.find(s => s.kind === 'repair' && !s.unclassified);
      expect(repairStep).toBeTruthy();
      expect(repairStep!.agent).toBe('codex');
      expect(repairStep!.model).toBe('codex-model');
    });

    it('Start suggested stage binds the correct run identity and pipelineId', async () => {
      const { writeArtifactWithMeta } = await import('../src/provenance.js');
      const { makeV1ArtifactMeta } = await import('./helpers/v1-artifact.js');

      const { captureTargetFingerprint } = await import('../src/target-snapshot.js');
      const { loadConfig } = await import('../src/config.js');
      const config = loadConfig(project);

      // Write plan.md and its matching fingerprint to avoid staleness
      const planPath = join(project, 'docs/dev/plan.md');
      writeFileSync(planPath, '# Plan\n');
      const fingerprint = captureTargetFingerprint(project, config.manifest.loops.plan!.target, config.manifest);

      const predecessorMeta = makeV1ArtifactMeta({
        version: 1,
        agent: 'opencode',
        provider: 'opencode',
        bindingId: 'plan',
        bindingKind: 'loop',
        kind: 'evaluate',
        pipelineId: 'default',
        pipelineRunId: 'test-run-123-uuid',
        stageId: 'plan',
        chainId: 'c1',
        chainMode: 'pipeline-start',
        resultFingerprint: fingerprint,
      });

      // Create a completed plan-audit stage artifact
      writeArtifactWithMeta(
        join(project, 'docs/dev/plan-audit-v1-opencode.md'),
        '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
        predecessorMeta,
      );

      // Mock interactive choices to pick the suggested stage
      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('start-suggested-stage');
      vi.mocked(promptCandidateSelection).mockImplementationOnce((candidates) => {
        return Promise.resolve(candidates[0]); // Returns the 'default' -> 'implement' candidate
      });
      vi.mocked(promptRunners).mockResolvedValueOnce({
        implement: { agent: 'opencode', model: MODEL },
      });
      vi.mocked(promptMaxIterations).mockResolvedValueOnce(4);
      vi.mocked(promptPostRunRecovery).mockResolvedValueOnce('exit');

      const adapter = scriptedAdapter();
      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(0);

      // Verify the generated artifact at docs/dev/impl-v1-opencode.md
      const implArtifact = readFileSync(join(project, 'docs/dev/impl-v1-opencode.md'), 'utf8');
      expect(implArtifact).toContain('pipelineId: default'); // MUST be default, not test-run
      expect(implArtifact).toContain('pipelineRunId: test-run-123-uuid');
      expect(implArtifact).toContain('stageId: implement');
      expect(implArtifact).toContain('parentArtifactIdentity: ' + predecessorMeta.artifactIdentity);
    });

    it('only eligible (non-stale) candidates are selectable in Start suggested stage', async () => {
      const { writeArtifactWithMeta } = await import('../src/provenance.js');
      const { makeV1ArtifactMeta } = await import('./helpers/v1-artifact.js');
      const { loadConfig } = await import('../src/config.js');
      const config = loadConfig(project);

      const planPath = join(project, 'docs/dev/plan.md');
      writeFileSync(planPath, '# Plan\n');

      const staleMeta = makeV1ArtifactMeta({
        version: 1,
        agent: 'opencode',
        provider: 'opencode',
        bindingId: 'plan',
        bindingKind: 'loop',
        kind: 'evaluate',
        pipelineId: 'default',
        pipelineRunId: 'stale-run-uuid',
        stageId: 'plan',
        chainId: 'c1',
        chainMode: 'pipeline-start',
        resultFingerprint: 'some-stale-hash',
      });
      writeArtifactWithMeta(
        join(project, 'docs/dev/plan-audit-v1-opencode.md'),
        '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
        staleMeta,
      );

      const { captureTargetFingerprint } = await import('../src/target-snapshot.js');
      const freshFingerprint = captureTargetFingerprint(project, config.manifest.loops.plan!.target, config.manifest);
      const freshMeta = makeV1ArtifactMeta({
        version: 2,
        agent: 'opencode',
        provider: 'opencode',
        bindingId: 'plan',
        bindingKind: 'loop',
        kind: 'evaluate',
        pipelineId: 'default',
        pipelineRunId: 'fresh-run-uuid',
        stageId: 'plan',
        chainId: 'c2',
        chainMode: 'pipeline-start',
        resultFingerprint: freshFingerprint,
      });
      writeArtifactWithMeta(
        join(project, 'docs/dev/plan-audit-v2-opencode.md'),
        '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
        freshMeta,
      );

      let offeredCandidates: any[] = [];
      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('start-suggested-stage');
      vi.mocked(promptCandidateSelection).mockImplementationOnce((candidates) => {
        offeredCandidates = candidates;
        return Promise.resolve(candidates[0] || null);
      });
      vi.mocked(promptRunners).mockResolvedValueOnce({
        implement: { agent: 'opencode', model: MODEL },
      });
      vi.mocked(promptMaxIterations).mockResolvedValueOnce(4);
      vi.mocked(promptPostRunRecovery).mockResolvedValueOnce('exit');

      const adapter = scriptedAdapter();
      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(offeredCandidates.length).toBe(1);
      expect(offeredCandidates[0]!.pipelineRunId).toBe('fresh-run-uuid');
      expect(result.exitCode).toBe(0);
    });

    it('Start suggested stage is aborted immediately and does not run provider if no eligible candidates exist', async () => {
      const { writeArtifactWithMeta } = await import('../src/provenance.js');
      const { makeV1ArtifactMeta } = await import('./helpers/v1-artifact.js');

      const planPath = join(project, 'docs/dev/plan.md');
      writeFileSync(planPath, '# Plan\n');

      const staleMeta = makeV1ArtifactMeta({
        version: 1,
        agent: 'opencode',
        provider: 'opencode',
        bindingId: 'plan',
        bindingKind: 'loop',
        kind: 'evaluate',
        pipelineId: 'default',
        pipelineRunId: 'stale-run-uuid',
        stageId: 'plan',
        chainId: 'c1',
        chainMode: 'pipeline-start',
        resultFingerprint: 'some-stale-hash',
      });
      writeArtifactWithMeta(
        join(project, 'docs/dev/plan-audit-v1-opencode.md'),
        '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
        staleMeta,
      );

      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('start-suggested-stage');
      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('stop');

      const adapter = scriptedAdapter();
      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(0);
      expect(vi.mocked(promptCandidateSelection)).not.toHaveBeenCalled();
      expect(adapter.run).not.toHaveBeenCalled();
    });

    it('rejects execution safely if the predecessor target changes after menu rendering but before confirmation', async () => {
      const { writeArtifactWithMeta } = await import('../src/provenance.js');
      const { makeV1ArtifactMeta } = await import('./helpers/v1-artifact.js');
      const { loadConfig } = await import('../src/config.js');
      const config = loadConfig(project);

      const planPath = join(project, 'docs/dev/plan.md');
      writeFileSync(planPath, '# Plan\n');
      const { captureTargetFingerprint } = await import('../src/target-snapshot.js');
      const fingerprint = captureTargetFingerprint(project, config.manifest.loops.plan!.target, config.manifest);

      const meta = makeV1ArtifactMeta({
        version: 1,
        agent: 'opencode',
        provider: 'opencode',
        bindingId: 'plan',
        bindingKind: 'loop',
        kind: 'evaluate',
        pipelineId: 'default',
        pipelineRunId: 'fresh-run-uuid',
        stageId: 'plan',
        chainId: 'c1',
        chainMode: 'pipeline-start',
        resultFingerprint: fingerprint,
      });

      writeArtifactWithMeta(
        join(project, 'docs/dev/plan-audit-v1-opencode.md'),
        '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
        meta,
      );

      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('start-suggested-stage');
      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('stop');
      vi.mocked(promptCandidateSelection).mockImplementationOnce(async (candidates) => {
        writeFileSync(planPath, '# Plan - Modified!\n');
        return candidates[0] || null;
      });

      const adapter = scriptedAdapter();
      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(0);
      expect(adapter.run).not.toHaveBeenCalled();
    });

    it('resolves successor bindings scoped to pipelineId and executes only the correct one', async () => {
      writeFileSync(join(continueProject, '.orc-smash.yaml'), JSON.stringify({
        schemaVersion: 1,
        roles: { implementer: 'roles/testRole.md' },
        skills: {
          evaluate: { file: 'skills/evaluate.md', role: 'implementer', runnerProfile: 'default' },
          task1: { file: 'skills/evaluate.md', role: 'implementer', runnerProfile: 'default' },
          task2: { file: 'skills/repair.md', role: 'implementer', runnerProfile: 'default' },
        },
        loops: {
          plan: {
            type: 'approval-loop',
            target: { path: 'docs/dev/plan.md', kind: 'file' },
            inputs: [],
            evaluate: {
              skill: 'evaluate',
              output: { pattern: 'docs/dev/plan-audit-v{version}-{provider}.md', contract: 'decision-artifact', decision: { heading: 'Verdict', accepted: 'YES', retry: 'NO' } },
            },
            repair: {
              skill: 'evaluate',
              output: { pattern: 'docs/dev/repair-v{version}-{provider}.md', contract: 'completion-artifact' },
            },
          },
        },
        tasks: {
          t1: {
            skill: 'task1',
            target: { path: 'docs/dev/t1.md', kind: 'file' },
            output: { pattern: 'docs/dev/t1-v{version}-{provider}.md', contract: 'completion-artifact' },
            inputs: [{ source: 'outputPath' }],
          },
          t2: {
            skill: 'task2',
            target: { path: 'docs/dev/t2.md', kind: 'file' },
            output: { pattern: 'docs/dev/t2-v{version}-{provider}.md', contract: 'completion-artifact' },
            inputs: [{ source: 'outputPath' }],
          },
        },
        pipelines: {
          pipe1: {
            stages: [
              { stageId: 'plan', loop: 'plan' },
              { stageId: 'shared-successor', task: 't1' },
            ],
          },
          pipe2: {
            stages: [
              { stageId: 'plan', loop: 'plan' },
              { stageId: 'shared-successor', task: 't2' },
            ],
          },
        },
      }));

      const { writeArtifactWithMeta } = await import('../src/provenance.js');
      const { makeV1ArtifactMeta } = await import('./helpers/v1-artifact.js');
      const { loadConfig } = await import('../src/config.js');
      const config = loadConfig(continueProject);

      const { captureTargetFingerprint } = await import('../src/target-snapshot.js');
      const targetFingerprint = captureTargetFingerprint(continueProject, config.manifest.loops.plan!.target, config.manifest);

      const meta = makeV1ArtifactMeta({
        version: 1,
        agent: 'opencode',
        provider: 'opencode',
        bindingId: 'plan',
        bindingKind: 'loop',
        kind: 'evaluate',
        pipelineId: 'pipe2',
        pipelineRunId: 'run-pipe2-uuid',
        stageId: 'plan',
        chainId: 'c1',
        chainMode: 'pipeline-start',
        resultFingerprint: targetFingerprint,
      });

      mkdirSync(join(continueProject, 'docs/dev'), { recursive: true });
      writeFileSync(join(continueProject, 'docs/dev/plan.md'), '# Plan\n');
      writeFileSync(join(continueProject, 'docs/dev/t2.md'), '# Target\n');

      writeArtifactWithMeta(
        join(continueProject, 'docs/dev/plan-audit-v1-opencode.md'),
        '# Evaluation\n\n## Verdict\n\nYES\n',
        meta,
      );



      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('start-suggested-stage');
      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('stop');
      vi.mocked(promptCandidateSelection).mockImplementationOnce((candidates) => {
        return Promise.resolve(candidates[0] || null);
      });
      vi.mocked(promptRunners).mockResolvedValueOnce({
        task2: { agent: 'opencode', model: MODEL },
      });
      vi.mocked(promptMaxIterations).mockResolvedValueOnce(4);
      vi.mocked(promptPostRunRecovery).mockResolvedValueOnce('exit');

      let executedSkill: string | null = null;
      const t2Adapter: AgentAdapter = {
        name: 'opencode',
        capabilities: { resumeSession: true, effort: true },
        buildRun: () => ({ command: 't2-command', args: [] }),
        run: async (input) => {
          executedSkill = input.skillId ?? null;
          const match = input.prompt.match(/Output path:\s*([^\r\n]+)/i);
          if (match?.[1]) {
            const outputPath = resolve(input.cwd, match[1].trim());
            mkdirSync(join(input.cwd, 'docs/dev'), { recursive: true });
            writeFileSync(outputPath, '# Task outcome\n\n## Outcome\n\nCOMPLETED\n');
          }
          return { stdout: 'done', exitCode: 0, sessionId: 's' };
        },
      };

      const customReg: AgentRegistry = {
        adapters: new Map([['opencode', t2Adapter]]),
      };

      const result = await smashAction({
        project: continueProject,
        output,
        createAdapterRegistry: () => customReg,
      } as any);

      if (result.exitCode !== 0) {
        console.log('TEST FAILURE ERROR:', result.message);
      }
      expect(result.exitCode).toBe(0);
      expect(executedSkill).toBe('task2');
    });

    it('distinguishes and binds the correct candidate when multiple candidates exist in the same pipeline run', async () => {
      const { writeArtifactWithMeta } = await import('../src/provenance.js');
      const { makeV1ArtifactMeta } = await import('./helpers/v1-artifact.js');

      const planPath = join(project, 'docs/dev/plan.md');
      writeFileSync(planPath, '# Plan\n');
      const { captureTargetFingerprint } = await import('../src/target-snapshot.js');
      const { loadConfig } = await import('../src/config.js');
      const config = loadConfig(project);
      const fingerprint = captureTargetFingerprint(project, config.manifest.loops.plan!.target, config.manifest);

      const meta1 = makeV1ArtifactMeta({
        version: 1,
        agent: 'fake',
        provider: 'fake',
        bindingId: 'plan',
        bindingKind: 'loop',
        kind: 'evaluate',
        pipelineId: 'default',
        pipelineRunId: 'shared-run-id',
        stageId: 'plan',
        chainId: 'c1',
        chainMode: 'pipeline-start',
        resultFingerprint: fingerprint,
      });
      writeArtifactWithMeta(
        join(project, 'docs/dev/plan-audit-v1-fake.md'),
        '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
        meta1,
      );

      const meta2 = makeV1ArtifactMeta({
        version: 1,
        agent: 'opencode',
        provider: 'opencode',
        bindingId: 'plan',
        bindingKind: 'loop',
        kind: 'evaluate',
        pipelineId: 'default',
        pipelineRunId: 'shared-run-id',
        stageId: 'plan',
        chainId: 'c2',
        chainMode: 'pipeline-start',
        resultFingerprint: fingerprint,
      });
      writeArtifactWithMeta(
        join(project, 'docs/dev/plan-audit-v1-opencode.md'),
        '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
        meta2,
      );

      vi.mocked(promptTopLevelMenu).mockResolvedValueOnce('start-suggested-stage');
      vi.mocked(promptCandidateSelection).mockImplementationOnce((candidates) => {
        return Promise.resolve(candidates.find(c => c.predecessorArtifactIdentity === meta2.artifactIdentity) || null);
      });
      vi.mocked(promptRunners).mockResolvedValueOnce({
        implement: { agent: 'opencode', model: MODEL },
      });
      vi.mocked(promptMaxIterations).mockResolvedValueOnce(4);
      vi.mocked(promptPostRunRecovery).mockResolvedValueOnce('exit');

      const adapter = scriptedAdapter();
      const result = await smashAction({
        project,
        agent: 'opencode',
        model: MODEL,
        output,
        createAdapterRegistry: () => registry(adapter),
      } as any);

      expect(result.exitCode).toBe(0);

      const implArtifact = readFileSync(join(project, 'docs/dev/impl-v1-opencode.md'), 'utf8');
      expect(implArtifact).toContain('parentArtifactIdentity: ' + meta2.artifactIdentity);
      expect(implArtifact).not.toContain('parentArtifactIdentity: ' + meta1.artifactIdentity);
    });
  });
});
