import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { smashAction } from '../src/commands/smash.js';
import type { AgentAdapter, RunInput, RunResult } from '../src/adapters/types.js';
import type { AgentRegistry } from '../src/adapters/registry.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';
import { promptLoopSelect, promptMaxIterations, promptPostRunRecovery } from '../src/interactive.js';

vi.mock('../src/interactive.js', () => {
  return {
    promptLoopSelect: vi.fn(),
    promptMaxIterations: vi.fn(),
    promptPostRunRecovery: vi.fn(),
    promptRunners: vi.fn(),
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
    async run(input: RunInput): Promise<RunResult> {
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
    },
  };
}

function registry(adapter: AgentAdapter): AgentRegistry {
  return { adapters: new Map([['opencode', adapter]]) };
}

describe('generic smash dispatch', () => {
  const project = resolve(process.cwd(), 'temp-smash-action');
  const output = createMockOutput();

  beforeEach(() => {
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

    it('Interactive mode: successful run followed by menu choice exit', async () => {
      vi.mocked(promptLoopSelect).mockResolvedValueOnce('plan');
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
      expect(promptLoopSelect).toHaveBeenCalledTimes(1);
      expect(promptMaxIterations).toHaveBeenCalledTimes(1);
      expect(promptPostRunRecovery).toHaveBeenCalledTimes(1);
    });

    it('Interactive mode: provider failure followed by menu choice menu then exit', async () => {
      vi.mocked(promptLoopSelect).mockResolvedValue('plan');
      vi.mocked(promptMaxIterations).mockResolvedValue(4);
      vi.mocked(promptPostRunRecovery)
        .mockResolvedValueOnce('menu') // Loops back
        .mockResolvedValueOnce('exit'); // Exits

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
      expect(promptLoopSelect).toHaveBeenCalledTimes(2);
      expect(promptMaxIterations).toHaveBeenCalledTimes(2);
      expect(promptPostRunRecovery).toHaveBeenCalledTimes(2);
    });

    it('Interactive mode: missing project input preflight and retry loop', async () => {
      vi.mocked(promptMaxIterations).mockResolvedValue(4);
      vi.mocked(promptPostRunRecovery).mockResolvedValue('exit');

      // Remove input file
      const planPath = join(project, 'docs/dev/plan.md');
      if (existsSync(planPath)) unlinkSync(planPath);

      // Create a mock that restores the file during the second call of the prompt/retry loop!
      vi.mocked(promptLoopSelect)
        .mockResolvedValueOnce('plan') // First call (preflight fails)
        .mockImplementationOnce(async () => {
          writeFileSync(planPath, '# Plan\n'); // Second call (preflight succeeds)
          return 'plan';
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
      // It should have failed the first resolution/validation, retry: true, and succeeded in the next iteration
      expect(promptLoopSelect).toHaveBeenCalledTimes(2);
    });

    it('Interactive mode: safety-critical ownership failure (exits directly without prompting recovery)', async () => {
      vi.mocked(promptLoopSelect).mockResolvedValue('plan');
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
  });
});
