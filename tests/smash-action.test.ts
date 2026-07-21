import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { smashAction } from '../src/commands/smash.js';
import type { AgentAdapter, RunInput, RunResult } from '../src/adapters/types.js';
import type { AgentRegistry } from '../src/adapters/registry.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';

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
});
