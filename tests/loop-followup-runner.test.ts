import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { createProductionAdapterRegistry } from '../src/adapters/registry.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';
import { buildFrontMatter } from '../src/provenance.js';
import { makeArtifactMeta } from './helpers/provenance.js';
import { fakeAdapterState, fakeAdapter } from '../src/adapters/fake.js';
import type { ProcessRunOptions, RawProcessResult } from '../src/adapters/utils.js';

const tempDir = join(process.cwd(), 'temp-loop-followup-runner');

let mockStageActionChoices: string[] = [];
let promptStageActionCalls = 0;
let promptRunnersCalls = 0;
let promptRunnersSkillsCalled: string[][] = [];
let promptRunnersOptsCalled: any[] = [];
let mockPromptRunnersChoice: Record<string, { agent: string; model: string }> = {};
let mockSessionPolicyOverride: any = null;
let mockOutputWarnings: string[] = [];

vi.mock('../src/interactive.js', () => {
  return {
    promptStageAction: async (actions: any[], recommendedId: string) => {
      promptStageActionCalls++;
      const choice = mockStageActionChoices.shift() ?? 'stop';
      const found = actions.find(a => a.id === choice);
      if (found && found.id === 'continue' && mockSessionPolicyOverride) {
        found.sessionPolicy = mockSessionPolicyOverride;
      }
      const actionIds = actions.map(a => a.id);
      return actionIds.includes(choice) ? choice : recommendedId;
    },
    promptLoopSelect: async () => '',
    promptRunners: async (skills: string[], _config?: any, _registry?: any, _overrides?: any, opts?: any) => {
      promptRunnersCalls++;
      promptRunnersSkillsCalled.push(skills);
      promptRunnersOptsCalled.push(opts);
      const res: Record<string, any> = {};
      for (const s of skills) {
        res[s] = mockPromptRunnersChoice[s] || { agent: 'fake', model: 'fake' };
      }
      return res;
    },
    promptMaxIterations: async () => 5
  };
});

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  const { createTestConfig } = await import('./helpers/test-config.js');
  return {
    ...actual,
    loadConfig: (projectRoot?: string) => createTestConfig({
      projectRoot,
      fakeModels: ['fake-model', 'fake-model-other']
    })
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
  const mockOutput = createMockOutput({
    warn: (msg: string) => { mockOutputWarnings.push(msg); },
    error: (msg: string) => { console.error('ERROR:', msg); },
    stepFailed: (ctx: any) => { console.error('STEP FAILED:', ctx); },
    finalSummary: (ctx: any) => { console.log('FINAL SUMMARY:', ctx); }
  });

  beforeEach(() => {
    createTempDir('temp-loop-followup-runner');
    fakeAdapterState.verdicts = [];
    fakeAdapterState.exitCode = 0;
    fakeAdapterState.stdout = '';
    fakeAdapterState.writeVerdictFile = true;
    mockStageActionChoices = [];
    promptStageActionCalls = 0;
    promptRunnersCalls = 0;
    promptRunnersSkillsCalled = [];
    promptRunnersOptsCalled = [];
    mockPromptRunnersChoice = {};
    mockSessionPolicyOverride = null;
    mockOutputWarnings = [];

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

  it('(a) Fresh START NEW: prompts both up front; rejected audit auto-chains into follow-up with no menu re-prompt', async () => {
    mockStageActionChoices = ['start-new-new-session', 'stop'];
    mockPromptRunnersChoice = {
      'plan-audit': { agent: 'fake', model: 'fake-model-other' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['REJECTED', 'APPROVED'];

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
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-audit', 'plan-follow-up']);
    // Startup menu prompt + post-approval menu prompt only — no re-prompt after
    // the rejected audit v1, which auto-chains into follow-up v1 then audit v2.
    expect(promptStageActionCalls).toBe(2);

    const auditV2File = join(tempDir, 'docs/dev/plan-audit-v2-fake.md');
    expect(existsSync(auditV2File)).toBe(true);
    const content = readFileSync(auditV2File, 'utf-8');
    expect(content).toContain('model: fake-model-other');
  });

  it('(b) Rejected-chain CONTINUE: prompts [follow-up, audit] up front and reuses them', async () => {
    writePlanAudit(1, 'REJECTED', 'fake', 'fake-model');

    mockStageActionChoices = ['continue', 'stop'];
    mockPromptRunnersChoice = {
      'plan-follow-up': { agent: 'fake', model: 'fake-model-other' },
      'plan-audit': { agent: 'fake', model: 'fake-model-other' }
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
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-follow-up', 'plan-audit']);

    const auditV2File = join(tempDir, 'docs/dev/plan-audit-v2-fake.md');
    expect(existsSync(auditV2File)).toBe(true);
    const content = readFileSync(auditV2File, 'utf-8');
    expect(content).toContain('model: fake-model-other');
  });

  it('(c) Same-session inheritance case: inherits only the resumable kind and prompts the other', async () => {
    writePlanAudit(1, 'REJECTED', 'codex', 'gpt-5.5');
    writePlanFollowUp(1, 'patched', 'codex', 'gpt-5.5', 'sess_abc123');
    writePlanAudit(2, 'REJECTED', 'codex', 'gpt-5.5'); // now we need follow-up v2

    mockStageActionChoices = ['continue', 'stop'];
    mockPromptRunnersChoice = {
      'plan-audit': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['APPROVED'];

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_new';
      
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      if (outputPathMatch?.[1]) {
        const absOut = resolve(tempDir, outputPathMatch[1]);
        mkdirSync(dirname(absOut), { recursive: true });
        writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
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
    registry.adapters.set('fake', fakeAdapter);

    // Set plan-follow-up default to codex (has resumable session), and plan-audit to fake
    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    };

    const result = await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: true
    });

    console.log('TEST C RESULT:', result);
    expect(result.success).toBe(true);
    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-audit']); // Only plan-audit prompted

    // Verify the follow-up v2 used codex/sess_abc123
    const followupFile = join(tempDir, 'docs/dev/plan-followup-v2-codex.md');
    expect(existsSync(followupFile)).toBe(true);
    const followupContent = readFileSync(followupFile, 'utf-8');
    expect(followupContent).toContain('sessionId: sess_abc123');

    // Verify the audit v3 used the prompted fake-model-other
    const auditFile = join(tempDir, 'docs/dev/plan-audit-v3-fake.md');
    expect(existsSync(auditFile)).toBe(true);
    const auditContent = readFileSync(auditFile, 'utf-8');
    expect(auditContent).toContain('model: fake-model-other');
  });

  it('(d) run-one-step-followup / run-one-step-audit prompts exactly once for the one-off step', async () => {
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
      maxIterations: 1,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(promptRunnersCalls).toBe(2);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-follow-up']);
    expect(promptRunnersSkillsCalled[1]).toEqual(['plan-audit']);
  });

  it('(e) Audit APPROVES: prompts both up-front but unused follow-up causes no extra prompt or drift', async () => {
    mockStageActionChoices = ['start-new-new-session', 'stop'];
    mockPromptRunnersChoice = {
      'plan-audit': { agent: 'fake', model: 'fake-model-other' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model-other' }
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
    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-audit', 'plan-follow-up']);
  });

  it('(f) Non-interactive: does not prompt; resumed session variant inherits prior session provider/model', async () => {
    writePlanAudit(1, 'REJECTED', 'codex', 'gpt-5.5');
    writePlanFollowUp(1, 'patched', 'codex', 'gpt-5.5', 'sess_abc123');
    writePlanAudit(2, 'REJECTED', 'codex', 'gpt-5.5'); // now we need follow-up v2

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_new';
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      if (outputPathMatch?.[1]) {
        const absOut = resolve(tempDir, outputPathMatch[1]);
        mkdirSync(dirname(absOut), { recursive: true });
        if (outputPathMatch[1].replace(/\\/g, '/').split('/').pop()?.includes('followup')) {
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
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    };

    const result = await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: false
    });

    console.log('TEST F RESULT:', result);
    expect(result.success).toBe(true);
    expect(promptRunnersCalls).toBe(0);

    const followupFile = join(tempDir, 'docs/dev/plan-followup-v2-codex.md');
    expect(existsSync(followupFile)).toBe(true);
    const content = readFileSync(followupFile, 'utf-8');
    expect(content).toContain('agent: codex');
    expect(content).toContain('model: gpt-5.5');
    expect(content).toContain('sessionId: sess_abc123');
  });

  it('(g) Review-loop parity: prompts on implement->review transition and uses chosen runner in review audit v1', async () => {
    // Pre-seed approved plan audit so implementation can start
    writePlanAudit(1, 'APPROVED', 'fake', 'fake-model');
    // Pre-seed implementation ledger and closeout checklist
    writeFileSync(join(tempDir, 'docs/dev/plan.md'), '---\nstatus: done\nconfidence: 0.96\nowners: harness-runtime\n---\n\n# Plan\n');
    writeFileSync(join(tempDir, 'docs/dev/plan-implement-v1-fake.md'), '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n|---|---|---|---|---|\n| 1 | src/loop.ts | npm test | ✅ | none |');

    mockStageActionChoices = ['start-new-new-session', 'stop'];
    mockPromptRunnersChoice = {
      'review': { agent: 'fake', model: 'fake-model-other' },
      'review-follow-up': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['APPROVED'];

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-implement': { agent: 'fake', model: 'fake-model' }
    };

    const result = await runLoop(tempDir, 'implement', implementSpec, config, runners, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(result.success).toBe(true);
    expect(promptRunnersCalls).toBe(2);
    expect(promptRunnersSkillsCalled[0]).toEqual(['30-simple-implement']);
    expect(promptRunnersSkillsCalled[1]).toEqual(['review', 'review-follow-up']);

    const reviewFile = join(tempDir, 'docs/dev/review-v1-fake.md');
    expect(existsSync(reviewFile)).toBe(true);
    const reviewContent = readFileSync(reviewFile, 'utf-8');
    expect(reviewContent).toContain('model: fake-model-other');
  });

  it('(h) Sequential chains in one interactive session: second START NEW resets and prompts again', async () => {
    mockStageActionChoices = [
      'start-new-new-session', // Chain 1 starts
      'start-new-new-session', // Chain 2 starts
      'stop'                   // Chain 2 stops
    ];
    mockPromptRunnersChoice = {
      'plan-audit': { agent: 'fake', model: 'fake-model-other' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['APPROVED', 'APPROVED'];

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
    expect(promptRunnersCalls).toBe(2);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-audit', 'plan-follow-up']);
    expect(promptRunnersSkillsCalled[1]).toEqual(['plan-audit', 'plan-follow-up']);
  });

  it('(b2) Approved-phase CONTINUE with no resumable sessions: re-audit REJECTS -> prompts [plan-audit, plan-follow-up]; uses new runners; segment completes', async () => {
    // 1. Seed plan-audit-v1 as APPROVED
    writePlanAudit(1, 'APPROVED', 'fake', 'fake-model');

    mockStageActionChoices = ['continue', 'stop'];
    mockPromptRunnersChoice = {
      'plan-audit': { agent: 'fake', model: 'fake-model-other' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['REJECTED', 'APPROVED']; // v2 audit REJECTS, v3 audit APPROVES

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
    // promptRunners should be called exactly once up front for the segment
    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-audit', 'plan-follow-up']);

    // Check that both steps used the prompted runner ('fake-model-other')
    const auditV2File = join(tempDir, 'docs/dev/plan-audit-v2-fake.md');
    expect(existsSync(auditV2File)).toBe(true);
    expect(readFileSync(auditV2File, 'utf-8')).toContain('model: fake-model-other');

    const followupV2File = join(tempDir, 'docs/dev/plan-followup-v2-fake.md');
    expect(existsSync(followupV2File)).toBe(true);
    expect(readFileSync(followupV2File, 'utf-8')).toContain('model: fake-model-other');
  });

  it('(b3) Approved-phase CONTINUE with mixed inheritance: re-audit REJECTS -> audit inherits, follow-up prompted up front', async () => {
    // 1. Seed plan-audit-v1 as APPROVED with codex
    const meta = makeArtifactMeta({ version: 1, loop: 'plan', skill: 'plan-audit', kind: 'audit', agent: 'codex', model: 'gpt-5.5', sessionId: 'sess_approved_audit', sessionMode: 'fresh' });
    writeFileSync(
      join(tempDir, `docs/dev/plan-audit-v1-codex.md`),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );

    mockStageActionChoices = ['continue', 'stop'];
    mockPromptRunnersChoice = {
      'plan-follow-up': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['APPROVED']; // subsequent audit v3 will approve

    // Set up codex process runner to mock the audit v2 execution (which will reject)
    let auditCallCount = 0;
    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_new';
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      if (outputPathMatch?.[1]) {
        const absOut = resolve(tempDir, outputPathMatch[1]);
        mkdirSync(dirname(absOut), { recursive: true });
        auditCallCount++;
        const verdict = auditCallCount === 1 ? 'REJECTED' : 'APPROVED';
        writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n${verdict}\n`);
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
    registry.adapters.set('fake', fakeAdapter);

    const runners = {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
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
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-follow-up']); // only follow-up prompted, audit inherited

    // Check that audit v2 used the inherited codex session
    const auditV2File = join(tempDir, 'docs/dev/plan-audit-v2-codex.md');
    expect(existsSync(auditV2File)).toBe(true);
    expect(readFileSync(auditV2File, 'utf-8')).toContain('sessionId: sess_approved_audit');

    // Check that follow-up v2 used the prompted fake-model-other
    const followupV2File = join(tempDir, 'docs/dev/plan-followup-v2-fake.md');
    expect(existsSync(followupV2File)).toBe(true);
    expect(readFileSync(followupV2File, 'utf-8')).toContain('model: fake-model-other');
  });

  it('(b4) Approved-phase CONTINUE with both resumable sessions: both inherit, promptRunners not called', async () => {
    // 1. Seed plan-audit-v1 as APPROVED, plan-followup-v1 as patched, plan-audit-v2 as APPROVED
    // This gives both audit and follow-up a resumable session.
    const metaAudit1 = makeArtifactMeta({ version: 1, loop: 'plan', skill: 'plan-audit', kind: 'audit', agent: 'codex', model: 'gpt-5.5', sessionId: 'sess_123', sessionMode: 'fresh' });
    writeFileSync(
      join(tempDir, `docs/dev/plan-audit-v1-codex.md`),
      buildFrontMatter(metaAudit1) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );

    const metaFollowup1 = makeArtifactMeta({ version: 1, loop: 'plan', skill: 'plan-follow-up', kind: 'follow-up', agent: 'codex', model: 'gpt-5.5', sessionId: 'sess_123', sessionMode: 'resumed' });
    writeFileSync(
      join(tempDir, `docs/dev/plan-followup-v1-codex.md`),
      buildFrontMatter(metaFollowup1) + `# Follow-up\n\n## Outcome\n\npatched\n`
    );

    const metaAudit2 = makeArtifactMeta({ version: 2, loop: 'plan', skill: 'plan-audit', kind: 'audit', agent: 'codex', model: 'gpt-5.5', sessionId: 'sess_123', sessionMode: 'resumed' });
    writeFileSync(
      join(tempDir, `docs/dev/plan-audit-v2-codex.md`),
      buildFrontMatter(metaAudit2) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );

    mockStageActionChoices = ['continue', 'stop'];
    fakeAdapterState.verdicts = ['APPROVED']; // subsequent audit v3 will approve

    let auditCallCount = 0;
    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_new';
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      if (outputPathMatch?.[1]) {
        const absOut = resolve(tempDir, outputPathMatch[1]);
        mkdirSync(dirname(absOut), { recursive: true });
        if (outputPathMatch[1].replace(/\\/g, '/').split('/').pop()?.includes('followup')) {
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        } else {
          auditCallCount++;
          const verdict = auditCallCount === 1 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n${verdict}\n`);
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
    registry.adapters.set('fake', fakeAdapter);

    const runners = {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    };

    const result = await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(result.success).toBe(true);
    expect(promptRunnersCalls).toBe(0); // Both steps inherited, no prompts at all!

    // Check that audit v3 used the inherited codex session
    const auditV3File = join(tempDir, 'docs/dev/plan-audit-v3-codex.md');
    expect(existsSync(auditV3File)).toBe(true);
    expect(readFileSync(auditV3File, 'utf-8')).toContain('sessionId: sess_123');
  });

  it('(b5) Approved-phase CONTINUE avoids a spurious resumed warning for follow-up: follow-up runs fresh on up-front pick, no warning emitted', async () => {
    // 1. Seed plan-audit-v1 as APPROVED with codex
    const meta = makeArtifactMeta({ version: 1, loop: 'plan', skill: 'plan-audit', kind: 'audit', agent: 'codex', model: 'gpt-5.5', sessionId: 'sess_approved_audit', sessionMode: 'fresh' });
    writeFileSync(
      join(tempDir, `docs/dev/plan-audit-v1-codex.md`),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );

    mockStageActionChoices = ['continue', 'stop'];
    mockPromptRunnersChoice = {
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' } // select codex for follow-up
    };
    fakeAdapterState.verdicts = ['APPROVED']; // subsequent audit v3 will approve

    // Set up codex process runner to mock both audit v2 and follow-up v2
    let auditCallCount = 0;
    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_new';
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      if (outputPathMatch?.[1]) {
        const absOut = resolve(tempDir, outputPathMatch[1]);
        mkdirSync(dirname(absOut), { recursive: true });
        if (outputPathMatch[1].replace(/\\/g, '/').split('/').pop()?.includes('followup')) {
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        } else {
          auditCallCount++;
          const verdict = auditCallCount === 1 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n${verdict}\n`);
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
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    };

    const result = await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(result.success).toBe(true);
    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-follow-up']); // prompted since no follow-up session exists to resume

    // Check that follow-up v2 runs fresh and does not emit a warning
    expect(mockOutputWarnings.some(w => w.includes('resumed requested for follow-up'))).toBe(false);
  });

  it('(b6) Approved-phase CONTINUE with a provider that lacks resumable-session capability: prompts fresh, no warning emitted', async () => {
    // 1. Seed plan-audit-v1 as APPROVED with codex
    const meta = makeArtifactMeta({ version: 1, loop: 'plan', skill: 'plan-audit', kind: 'audit', agent: 'codex', model: 'gpt-5.5', sessionId: 'sess_approved_audit', sessionMode: 'fresh' });
    writeFileSync(
      join(tempDir, `docs/dev/plan-audit-v1-codex.md`),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`
    );

    mockStageActionChoices = ['continue', 'stop'];
    mockPromptRunnersChoice = {
      'plan-follow-up': { agent: 'fake', model: 'fake-model' } // select fake (no continuity capability) for follow-up
    };
    fakeAdapterState.verdicts = ['APPROVED']; // subsequent audit v3 will approve

    // Set up codex process runner to mock the audit v2 execution
    let auditCallCount = 0;
    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_new';
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      if (outputPathMatch?.[1]) {
        const absOut = resolve(tempDir, outputPathMatch[1]);
        mkdirSync(dirname(absOut), { recursive: true });
        auditCallCount++;
        const verdict = auditCallCount === 1 ? 'REJECTED' : 'APPROVED';
        writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n${verdict}\n`);
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
    registry.adapters.set('fake', fakeAdapter);

    const runners = {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
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
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-follow-up']); // prompted since fake agent lacks continuity capability

    // Check that no warning is emitted for the fallback
    expect(mockOutputWarnings.some(w => w.includes('resumed requested for follow-up'))).toBe(false);
  });

  it('(i) START NEW repeated rejection: cycles audit -> follow-up -> audit with a single action-menu prompt', async () => {
    // Only the startup prompt is queued; chain mode must keep cycling on rejection
    // without re-prompting the menu until maxIterations is hit.
    mockStageActionChoices = ['start-new-new-session'];
    mockPromptRunnersChoice = {
      'plan-audit': { agent: 'fake', model: 'fake-model-other' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['REJECTED', 'REJECTED', 'REJECTED'];

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const result = await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 3,
      registry,
      output: mockOutput,
      interactive: true
    });

    // One startup menu prompt only — no re-prompt after any rejected audit.
    expect(promptStageActionCalls).toBe(1);
    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-audit', 'plan-follow-up']);

    // The chain cycled: audit v1 -> follow-up v1 -> audit v2 -> follow-up v2 -> audit v3.
    expect(existsSync(join(tempDir, 'docs/dev/plan-audit-v1-fake.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'docs/dev/plan-followup-v1-fake.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'docs/dev/plan-audit-v2-fake.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'docs/dev/plan-followup-v2-fake.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'docs/dev/plan-audit-v3-fake.md'))).toBe(true);
    // No follow-up v3: the third rejection exits at maxIterations before running it.
    expect(existsSync(join(tempDir, 'docs/dev/plan-followup-v3-fake.md'))).toBe(false);

    // Hit max iterations on a rejection — run ends unsuccessful with REJECTED.
    expect(result.success).toBe(false);
    expect(result.verdict).toBe('REJECTED');
  });

  it('(j) Rejected-no-followup CONTINUE repeated rejection: cycles follow-up -> audit -> follow-up with a single menu prompt', async () => {
    writePlanAudit(1, 'REJECTED', 'fake', 'fake-model');

    mockStageActionChoices = ['continue'];
    mockPromptRunnersChoice = {
      'plan-follow-up': { agent: 'fake', model: 'fake-model-other' },
      'plan-audit': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['REJECTED', 'REJECTED', 'REJECTED'];

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    const result = await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 3,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(promptStageActionCalls).toBe(1);
    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-follow-up', 'plan-audit']);

    // CONTINUE runs follow-up v1 first, then the chain cycles through v2 and v3.
    expect(existsSync(join(tempDir, 'docs/dev/plan-followup-v1-fake.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'docs/dev/plan-audit-v2-fake.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'docs/dev/plan-followup-v2-fake.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'docs/dev/plan-audit-v3-fake.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'docs/dev/plan-followup-v3-fake.md'))).toBe(true);
    expect(existsSync(join(tempDir, 'docs/dev/plan-audit-v4-fake.md'))).toBe(true);

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('REJECTED');
  });

  it('(k) run-one-step-audit stays one-off: a rejected one-off audit re-prompts the menu instead of auto-chaining', async () => {
    mockStageActionChoices = ['run-one-step-audit', 'stop'];
    mockPromptRunnersChoice = {
      'plan-audit': { agent: 'fake', model: 'fake-model-other' }
    };
    fakeAdapterState.verdicts = ['REJECTED'];

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 1,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(promptStageActionCalls).toBe(2);
    expect(promptRunnersSkillsCalled[0]).toEqual(['plan-audit']);
  });

  it('(l) forceSelect: true is passed to promptRunners only for continue group', async () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(tempDir, 'docs/dev/plan.md'), `# My Plan\n`);
    const priorMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 1, agent: 'fake', model: 'fake-model', target: 'docs/dev/plan.md',
      priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z',
      sessionMode: 'none' as const, sessionId: 'none'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-fake.md'),
      buildFrontMatter(priorMeta) + `\n## Verdict\nREJECTED\n`
    );

    mockStageActionChoices = ['continue', 'stop'];
    mockPromptRunnersChoice = {
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };
    fakeAdapterState.verdicts = ['APPROVED'];

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 2,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersOptsCalled[0]?.forceSelect).toBe(true);
  });

  it('(l2) forceSelect is false or undefined when start-new group is chosen', async () => {
    mockStageActionChoices = ['start-new-new-session', 'stop'];
    mockPromptRunnersChoice = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };
    fakeAdapterState.verdicts = ['APPROVED'];

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 2,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersOptsCalled[0]?.forceSelect).toBeFalsy();
  });

  it('(l3) forceSelect is false or undefined when run-one-step group is chosen', async () => {
    mockStageActionChoices = ['run-one-step-audit', 'stop'];
    mockPromptRunnersChoice = {
      'plan-audit': { agent: 'fake', model: 'fake-model' }
    };
    fakeAdapterState.verdicts = ['APPROVED'];

    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;
    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    };

    await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 2,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(promptRunnersCalls).toBe(1);
    expect(promptRunnersOptsCalled[0]?.forceSelect).toBeFalsy();
  });

  it('(m) interactive multi-iteration continue chain preserves follow-up sessionId', async () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(tempDir, 'docs/dev/plan.md'), `# My Plan\n`);
    
    const priorMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 1, agent: 'codex', model: 'gpt-5.5', target: 'docs/dev/plan.md',
      priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z',
      sessionMode: 'fresh' as const, sessionId: 'sess_audit_prior'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-codex.md'),
      buildFrontMatter(priorMeta) + `\n## Verdict\nREJECTED\n`
    );

    mockStageActionChoices = ['continue', 'stop'];
    mockPromptRunnersChoice = {
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    };

    const capturedArgs: string[][] = [];
    let auditCallCount = 0;
    let followupCallCount = 0;

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      capturedArgs.push(options.args);
      
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      const isFollowUp = outputPathMatch?.[1]?.replace(/\\/g, '/').split('/').pop()?.includes('followup');
      
      if (outputPathMatch?.[1]) {
        const absOut = resolve(tempDir, outputPathMatch[1]);
        mkdirSync(dirname(absOut), { recursive: true });
        
        if (isFollowUp) {
          followupCallCount++;
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\n\npatched\n\nFiles patched: docs/dev/plan.md\n`);
        } else {
          auditCallCount++;
          const verdict = auditCallCount === 1 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n${verdict}\n`);
        }
      }
      
      const isResumed = options.args.includes('resume');
      let sessionId = 'sess_default';
      if (isResumed) {
        sessionId = options.args[options.args.indexOf('resume') + 1]!;
      } else {
        sessionId = isFollowUp ? 'sess_followup_abc' : 'sess_audit_new';
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
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    };

    await runLoop(tempDir, 'plan', planSpec, config, runners, {
      maxIterations: 4,
      registry,
      output: mockOutput,
      interactive: true
    });

    const fileContent1 = readFileSync(join(devDir, 'plan-followup-v1-codex.md'), 'utf8');
    const fileContent2 = readFileSync(join(devDir, 'plan-followup-v2-codex.md'), 'utf8');

    const match1 = fileContent1.match(/sessionId:\s*([^\s\r\n]+)/);
    const match2 = fileContent2.match(/sessionId:\s*([^\s\r\n]+)/);

    expect(match1).not.toBeNull();
    expect(match2).not.toBeNull();
    expect(match1![1]).toBe('sess_followup_abc');
    expect(match2![1]).toBe('sess_followup_abc');

    expect(capturedArgs[0].includes('resume')).toBe(false);
    expect(capturedArgs[1].includes('resume')).toBe(true);
    expect(capturedArgs[1][capturedArgs[1].indexOf('resume') + 1]).toBe('sess_audit_prior');
    
    expect(capturedArgs[2].includes('resume')).toBe(true);
    expect(capturedArgs[2][capturedArgs[2].indexOf('resume') + 1]).toBe('sess_followup_abc');
  });

  it('(n) review loop multi-iteration continue chain preserves review-follow-up sessionId', async () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(tempDir, 'docs/dev/plan.md'), `# My Plan\n`);

    // Seed a prior review audit (v1) REJECTED so the review loop starts in a
    // rejected-no-followup state and CONTINUE runs the follow-up -> audit segment.
    const priorMeta = {
      loop: 'review', skill: 'review', kind: 'audit' as const, role: 'reviewer',
      version: 1, agent: 'codex', model: 'gpt-5.5', target: '.',
      priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z',
      sessionMode: 'fresh' as const, sessionId: 'sess_review_audit_prior'
    };
    writeFileSync(
      join(devDir, 'review-v1-codex.md'),
      buildFrontMatter(priorMeta) + `\n## Verdict\nREJECTED\n`
    );

    mockStageActionChoices = ['continue', 'stop'];
    mockPromptRunnersChoice = {
      'review-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    };

    const capturedArgs: string[][] = [];
    let auditCallCount = 0;

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      capturedArgs.push(options.args);

      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      const isFollowUp = outputPathMatch?.[1]?.replace(/\\/g, '/').split('/').pop()?.includes('followup');

      if (outputPathMatch?.[1]) {
        const absOut = resolve(tempDir, outputPathMatch[1]);
        mkdirSync(dirname(absOut), { recursive: true });

        if (isFollowUp) {
          writeFileSync(absOut, `# Review Follow-up\n\n## Follow-up Outcome\n\npatched\n`);
        } else {
          auditCallCount++;
          const verdict = auditCallCount === 1 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absOut, `# Review\n\n## Verdict\n${verdict}\n`);
        }
      }

      const isResumed = options.args.includes('resume');
      let sessionId = 'sess_default';
      if (isResumed) {
        sessionId = options.args[options.args.indexOf('resume') + 1]!;
      } else {
        sessionId = isFollowUp ? 'sess_review_followup_abc' : 'sess_review_audit_new';
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
    const reviewSpec = config.manifest.loops['review']!;
    const registry = createProductionAdapterRegistry(config.registry, { codexProcessRunner });

    const runners = {
      'review': { agent: 'codex', model: 'gpt-5.5' },
      'review-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    };

    await runLoop(tempDir, 'review', reviewSpec, config, runners, {
      maxIterations: 4,
      registry,
      output: mockOutput,
      interactive: true
    });

    // Decisive assertion: review-follow-up v2 must resume v1's session id
    // (the shared-code #43 fix, now proven on the review path).
    const fileContent1 = readFileSync(join(devDir, 'review-followup-v1-codex.md'), 'utf8');
    const fileContent2 = readFileSync(join(devDir, 'review-followup-v2-codex.md'), 'utf8');

    const match1 = fileContent1.match(/sessionId:\s*([^\s\r\n]+)/);
    const match2 = fileContent2.match(/sessionId:\s*([^\s\r\n]+)/);

    expect(match1).not.toBeNull();
    expect(match2).not.toBeNull();
    expect(match1![1]).toBe('sess_review_followup_abc');
    expect(match2![1]).toBe('sess_review_followup_abc');

    // [0] review-followup v1 (fresh); [1] review v2 (resumes seeded audit);
    // [2] review-followup v2 (resumes v1 follow-up — the property under test).
    expect(capturedArgs[0].includes('resume')).toBe(false);
    expect(capturedArgs[1].includes('resume')).toBe(true);
    expect(capturedArgs[1][capturedArgs[1].indexOf('resume') + 1]).toBe('sess_review_audit_prior');
    expect(capturedArgs[2].includes('resume')).toBe(true);
    expect(capturedArgs[2][capturedArgs[2].indexOf('resume') + 1]).toBe('sess_review_followup_abc');
  });
});
