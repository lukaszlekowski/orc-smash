import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { createProductionAdapterRegistry } from '../src/adapters/registry.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { buildFrontMatter } from '../src/provenance.js';
import { makeArtifactMeta } from './helpers/provenance.js';
import { fakeAdapterState } from '../src/adapters/fake.js';
import type { ProcessRunOptions, RawProcessResult } from '../src/adapters/utils.js';

const tempDir = join(process.cwd(), 'temp-loop-followup-runner');

let mockStageActionChoices: string[] = [];
let promptRunnersCalls = 0;
let promptRunnersSkillsCalled: string[][] = [];
let mockPromptRunnersChoice: Record<string, { agent: string; model: string }> = {};

vi.mock('../src/interactive.js', () => {
  return {
    promptStageAction: async (actions: any[], recommendedId: string) => {
      const choice = mockStageActionChoices.shift() ?? 'stop';
      const actionIds = actions.map(a => a.id);
      return actionIds.includes(choice) ? choice : recommendedId;
    },
    promptLoopSelect: async () => '',
    promptRunners: async (skills: string[]) => {
      promptRunnersCalls++;
      promptRunnersSkillsCalled.push(skills);
      const res: Record<string, any> = {};
      for (const s of skills) {
        res[s] = mockPromptRunnersChoice[s] || { agent: 'fake', model: 'fake' };
      }
      return res;
    },
    promptMaxIterations: async () => 5
  };
});

function codexStdout(sessionId: string, text: string) {
  return JSON.stringify({
    type: 'thread.started',
    thread_id: sessionId
  }) + '\n' + JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text }
  });
}

describe('Follow-up Runner interactive resolution & inheritance', () => {
  const mockOutput = {
    note: () => {},
    warn: () => {},
    error: () => {},
    iterationStarted: () => {},
    stepStarted: () => {},
    stepSucceeded: () => {},
    stepFailed: () => {},
    renderPanel: () => {},
    finalSummary: () => {}
  };

  beforeEach(() => {
    createTempDir('temp-loop-followup-runner');
    fakeAdapterState.verdicts = [];
    fakeAdapterState.exitCode = 0;
    fakeAdapterState.stdout = '';
    fakeAdapterState.writeVerdictFile = true;
    mockStageActionChoices = [];
    promptRunnersCalls = 0;
    promptRunnersSkillsCalled = [];
    mockPromptRunnersChoice = {};

    // Write project-local orc.config.yaml with fake and codex providers
    writeFileSync(
      join(tempDir, 'orc.config.yaml'),
      `
providers:
  fake:
    - fake-model
    - fake-model-other
  codex:
    - gpt-5.5
  opencode:
    - opencode-go/deepseek-v4-flash
defaults:
  agent: fake
  model: fake-model
`
    );

    // Pre-seed plan.md with ready status
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(
      join(tempDir, 'docs/dev/plan.md'),
      '---\nstatus: active\nconfidence: 0.96\nowners: harness-runtime\n---\n\n# Plan\n'
    );
  });

  afterEach(() => {
    removeTempDir(tempDir);
    vi.restoreAllMocks();
  });

  function writePlanAudit(version: number, verdict: 'APPROVED' | 'REJECTED', agent = 'fake', model = 'fake-model') {
    const meta = makeArtifactMeta({ version, loop: 'plan', skill: 'plan-audit', kind: 'audit', agent, model });
    writeFileSync(
      join(tempDir, `docs/dev/plan-audit-v${version}-${agent}.md`),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\n${verdict}\n`
    );
  }

  function writePlanFollowUp(version: number, outcome: 'patched' | 'none', agent = 'fake', model = 'fake-model', sessionId = 'sess_123') {
    const meta = makeArtifactMeta({
      version,
      loop: 'plan',
      skill: 'plan-follow-up',
      kind: 'follow-up',
      agent,
      model,
      sessionId,
      sessionMode: 'resumed'
    });
    writeFileSync(
      join(tempDir, `docs/dev/plan-followup-v${version}-${agent}.md`),
      buildFrontMatter(meta) + `# Follow-up\n\n## Outcome\n\n${outcome}\n`
    );
  }

  function writeReviewAudit(version: number, verdict: 'APPROVED' | 'REJECTED', agent = 'fake', model = 'fake-model') {
    const meta = makeArtifactMeta({ version, loop: 'review', skill: 'review-audit', kind: 'audit', agent, model });
    writeFileSync(
      join(tempDir, `docs/dev/review-v${version}-${agent}.md`),
      buildFrontMatter(meta) + `# Review\n\n## Verdict\n\n${verdict}\n`
    );
  }

  it('(a) Fresh chain, CONTINUE, no prior follow-up session prompts for follow-up runner and uses it', async () => {
    writePlanAudit(1, 'REJECTED', 'fake', 'fake-model');

    mockStageActionChoices = ['continue', 'stop'];
    mockPromptRunnersChoice = {
      'plan-follow-up': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['APPROVED']; // subsequent audit v2

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const result = await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(result.success).toBe(true);
    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-follow-up']);

    const followupFile = join(tempDir, 'docs/dev/plan-followup-v1-fake.md');
    expect(existsSync(followupFile)).toBe(true);

    const content = readFileSync(followupFile, 'utf-8');
    expect(content).toContain('model: fake-model-other');
  });

  it('(b) Prior follow-up session exists: inherits the earlier runner and does not prompt', async () => {
    writePlanAudit(1, 'REJECTED', 'codex', 'gpt-5.5');
    writePlanFollowUp(1, 'patched', 'codex', 'gpt-5.5', 'sess_abc123');
    writePlanAudit(2, 'REJECTED', 'codex', 'gpt-5.5'); // now we need to run follow-up v2

    mockStageActionChoices = ['continue', 'stop'];
    const capturedArgs: string[][] = [];

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      capturedArgs.push(options.args);
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_new';
      
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      
      if (outputPathMatch?.[1]) {
        const absOut = resolve(tempDir, outputPathMatch[1]);
        mkdirSync(dirname(absOut), { recursive: true });
        if (outputPathMatch[1].includes('followup')) {
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        } else {
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\nAPPROVED\n`);
        }
      }

      return {
        stdout: codexStdout(sessionId, 'Completed.'),
        stderr: '',
        exitCode: 0,
        timedOut: false,
        signal: null,
        durationMs: 50
      };
    };

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createProductionAdapterRegistry(config.registry, { codexProcessRunner });

    const runners = {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' } // default
    };

    const result = await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(result.success).toBe(true);
    expect(promptRunnersCalls).toBe(0); // inherited

    const followupFile = join(tempDir, 'docs/dev/plan-followup-v2-codex.md');
    expect(existsSync(followupFile)).toBe(true);

    const content = readFileSync(followupFile, 'utf-8');
    expect(content).toContain('agent: codex');
    expect(content).toContain('model: gpt-5.5');
    expect(content).toContain('sessionId: sess_abc123');
  });

  it('(c) run-one-step-followup prompts exactly once and avoids double prompt in execution block', async () => {
    writePlanAudit(1, 'REJECTED', 'fake', 'fake-model');

    mockStageActionChoices = ['run-one-step-followup', 'stop'];
    mockPromptRunnersChoice = {
      'plan-follow-up': { agent: 'fake', model: 'fake-model-other' }
    };

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: true
    });

    // Fired exactly once during stage action selection, and not again during follow-up execution
    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-follow-up']);

    const followupFile = join(tempDir, 'docs/dev/plan-followup-v1-fake.md');
    expect(existsSync(followupFile)).toBe(true);
    const content = readFileSync(followupFile, 'utf-8');
    expect(content).toContain('model: fake-model-other');
  });

  it('(d) Audit APPROVES -> no follow-up prompt', async () => {
    mockStageActionChoices = ['start-new-new-session', 'stop'];
    mockPromptRunnersChoice = {
      'plan-audit': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['APPROVED'];

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const result = await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(result.success).toBe(true);
    // Only audit is prompted at startup, no follow-up runner prompt
    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-audit']);
  });

  it('(e) Non-interactive (interactive: false) does not prompt and uses manifest default', async () => {
    writePlanAudit(1, 'REJECTED', 'fake', 'fake-model');
    fakeAdapterState.verdicts = ['APPROVED']; // subsequent audit v2

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const result = await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: false
    });

    expect(result.success).toBe(true);
    expect(promptRunnersCalls).toBe(0);

    const followupFile = join(tempDir, 'docs/dev/plan-followup-v1-fake.md');
    expect(existsSync(followupFile)).toBe(true);
    const content = readFileSync(followupFile, 'utf-8');
    expect(content).toContain('model: fake-model'); // manifest/default runner used
  });

  it('(f) Review-loop parity prompts on CONTINUE and uses chosen runner', async () => {
    writeReviewAudit(1, 'REJECTED', 'fake', 'fake-model');

    mockStageActionChoices = ['continue', 'stop'];
    mockPromptRunnersChoice = {
      'review-follow-up': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['APPROVED']; // subsequent review v2

    const config = loadConfig(tempDir);
    const reviewSpec = config.manifest.loops['review']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'review': { agent: 'fake', model: 'fake-model' },
      'review-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const result = await runLoop(tempDir, 'review', reviewSpec, config, runners, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(result.success).toBe(true);
    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersSkillsCalled[0]).toEqual(['review-follow-up']);

    const followupFile = join(tempDir, 'docs/dev/review-followup-v1-fake.md');
    expect(existsSync(followupFile)).toBe(true);

    const content = readFileSync(followupFile, 'utf-8');
    expect(content).toContain('model: fake-model-other');
  });

  it('prompts again for follow-up runner on a new chain in the same session after approval', async () => {
    writePlanAudit(1, 'REJECTED', 'fake', 'fake-model');

    mockStageActionChoices = ['continue', 'start-new-new-session', 'continue', 'stop'];
    mockPromptRunnersChoice = {
      'plan-follow-up': { agent: 'fake', model: 'fake-model-other' },
      'plan-audit': { agent: 'fake', model: 'fake-model' }
    };
    fakeAdapterState.verdicts = ['APPROVED', 'REJECTED', 'APPROVED'];

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const result = await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 10,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(result.success).toBe(true);
    expect(promptRunnersCalls).toBe(3);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-follow-up']);
    expect(promptRunnersSkillsCalled[1]).toEqual(['plan-audit']);
    expect(promptRunnersSkillsCalled[2]).toEqual(['plan-follow-up']);
  });
});
