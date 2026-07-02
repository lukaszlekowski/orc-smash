import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { createProductionAdapterRegistry } from '../src/adapters/registry.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { scan } from '../src/state.js';
import type { RawProcessResult, ProcessRunOptions } from '../src/adapters/utils.js';

let mockSecondOpinionChoice = 'stop';
let mockSecondOpinionRunner = { agent: 'codex', model: 'gpt-5.5' };

vi.mock('../src/interactive.js', () => {
  return {
    promptSecondOpinionDecision: async () => {
      const choice = mockSecondOpinionChoice;
      mockSecondOpinionChoice = 'stop';
      return choice;
    },
    promptSecondOpinionRunner: async () => mockSecondOpinionRunner,
    promptLoopSelect: async () => '',
    promptStartPoint: async () => '',
    promptRunners: async () => ({}),
    promptMaxIterations: async () => 5
  };
});

describe('Loop Continuity Orchestration', () => {
  const tempWorkspace = resolve(process.cwd(), 'temp-loop-continuity-test');
  
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
    createTempDir('temp-loop-continuity-test');
  });

  afterEach(() => {
    removeTempDir(tempWorkspace);
  });

  function setupProject() {
    const root = join(tempWorkspace, 'project');
    const devDir = join(root, 'docs/dev');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(root, 'docs/dev/plan.md'), `# My Plan\nInitial content.\n`);
    writeFileSync(
      join(root, 'orc.config.yaml'),
      'providers:\n  codex:\n    - gpt-5.5\n  opencode:\n    - opencode-go/deepseek-v4-flash\ndefaults:\n  agent: codex\n  model: gpt-5.5\n'
    );
    return root;
  }

  it('runs first audit as fresh, follow-up as none, second audit as resumed, and verifies session IDs', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    // We will simulate 2 audits. The first returns REJECTED, the second APPROVED.
    const codexResponses = [
      // First audit response (fresh)
      '{"type":"thread.started","thread_id":"sess_abc123"}\n' +
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"## Verdict\\nREJECTED\\n"}}',
      // Second audit response (resumed)
      '{"type":"thread.started","thread_id":"sess_abc123"}\n' +
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"## Verdict\\nAPPROVED\\n"}}'
    ];

    let codexRunIndex = 0;
    const capturedArgs: string[][] = [];

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      capturedArgs.push(options.args);
      const isJson = options.args.includes('--json');
      if (isJson) {
        const stdout = codexResponses[codexRunIndex++] || '';
        const prompt = options.args[options.args.length - 1] || '';
        const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
        if (outputPathMatch?.[1]) {
          const absOut = resolve(root, outputPathMatch[1]);
          mkdirSync(join(root, 'docs/dev'), { recursive: true });
          const verdict = stdout.includes('APPROVED') ? 'APPROVED' : 'REJECTED';
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n\n${verdict}\n`);
        }
        return {
          stdout,
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      } else {
        // Follow-up step: plain text.
        // We write the mock follow-up outcome file to simulate success.
        const prompt = options.args[options.args.length - 1] || '';
        const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
        if (outputPathMatch?.[1]) {
          const absOut = resolve(root, outputPathMatch[1]);
          mkdirSync(join(root, 'docs/dev'), { recursive: true });
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        }
        return {
          stdout: 'Follow-up patched.',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      }
    };

    const registry = createProductionAdapterRegistry(config.registry, { codexProcessRunner });

    // Use codex for both to route all process spawns through our mocked codexProcessRunner.
    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      startPoint: 'fresh',
      registry,
      output: mockOutput,
      interactive: false,
      auditContinuity: 'codex-resume'
    });

    expect(result.success).toBe(true);
    expect(result.verdict).toBe('APPROVED');

    // Verify args: first run is fresh (exec --json), second is resumed (exec resume sess_abc123 --json)
    expect(capturedArgs).toHaveLength(3); // audit1, followUp1, audit2
    expect(capturedArgs[0]).toContain('exec');
    expect(capturedArgs[0]).toContain('--json');
    expect(capturedArgs[0]).not.toContain('resume');

    expect(capturedArgs[1]).toContain('exec');
    expect(capturedArgs[1]).not.toContain('--json'); // follow-up is not JSON

    expect(capturedArgs[2]).toContain('exec');
    expect(capturedArgs[2]).toContain('resume');
    expect(capturedArgs[2]).toContain('sess_abc123');
    expect(capturedArgs[2]).toContain('--json');

    // Verify timeline metadata
    const scanResult = scan(root, {
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    });

    // 2 audits + 1 follow-up = 3 timeline steps
    expect(scanResult.timeline).toHaveLength(3);
    
    // v1 audit: fresh, sessionId sess_abc123
    const step1 = scanResult.timeline[0]!;
    expect(step1.kind).toBe('audit');
    expect(step1.sessionMode).toBe('fresh');
    expect(step1.sessionId).toBe('sess_abc123');

    // v1 follow-up: none, sessionId none
    const step2 = scanResult.timeline[1]!;
    expect(step2.kind).toBe('follow-up');
    expect(step2.sessionMode).toBe('none');
    expect(step2.sessionId).toBe('none');

    // v2 audit: resumed, sessionId sess_abc123
    const step3 = scanResult.timeline[2]!;
    expect(step3.kind).toBe('audit');
    expect(step3.sessionMode).toBe('resumed');
    expect(step3.sessionId).toBe('sess_abc123');
  });

  it('fails loudly when resuming but returned thread_id does not match the resumed session id', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    const codexResponses = [
      // First audit response (fresh)
      '{"type":"thread.started","thread_id":"sess_abc123"}\n' +
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"## Verdict\\nREJECTED\\n"}}',
      // Second audit response (resumed) - returns wrong thread_id!
      '{"type":"thread.started","thread_id":"sess_WRONG"}\n' +
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"## Verdict\\nAPPROVED\\n"}}'
    ];

    let codexRunIndex = 0;
    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      const isJson = options.args.includes('--json');
      if (isJson) {
        const stdout = codexResponses[codexRunIndex++] || '';
        const prompt = options.args[options.args.length - 1] || '';
        const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
        if (outputPathMatch?.[1]) {
          const absOut = resolve(root, outputPathMatch[1]);
          mkdirSync(join(root, 'docs/dev'), { recursive: true });
          const verdict = stdout.includes('APPROVED') ? 'APPROVED' : 'REJECTED';
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n\n${verdict}\n`);
        }
        return {
          stdout,
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      } else {
        const prompt = options.args[options.args.length - 1] || '';
        const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
        if (outputPathMatch?.[1]) {
          const absOut = resolve(root, outputPathMatch[1]);
          mkdirSync(join(root, 'docs/dev'), { recursive: true });
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        }
        return {
          stdout: 'Follow-up patched.',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      }
    };

    const registry = createProductionAdapterRegistry(config.registry, { codexProcessRunner });

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      startPoint: 'fresh',
      registry,
      output: mockOutput,
      interactive: false,
      auditContinuity: 'codex-resume'
    });

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('unknown');
    expect(result.message).toContain('Resumed thread ID mismatch: expected sess_abc123, got sess_WRONG');
  });

  it('fails loudly when continuity is enabled but no prior session id was found in history', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    // Seed history manually with a prior audit that has no session ID (e.g. run without continuity)
    const devDir = join(root, 'docs/dev');
    const priorMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 1, agent: 'codex', model: 'gpt-5.5', target: 'docs/dev/plan.md',
      priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z',
      sessionMode: 'none' as const, sessionId: 'none'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-codex.md'),
      JSON.stringify(priorMeta) + `\n## Verdict\nREJECTED\n`
    );

    const registry = createProductionAdapterRegistry(config.registry, {
      codexProcessRunner: async () => ({
        stdout: '', stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 0
      })
    });

    // Try to run with resume startpoint, continuity enabled
    await expect(runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      startPoint: 'resume',
      registry,
      output: mockOutput,
      interactive: false,
      auditContinuity: 'codex-resume'
    })).rejects.toThrow('no prior Codex session ID was found');
  });

  it('second-opinion Codex audits bypass continuity entirely and stamp sessionMode: none, sessionId: none', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    const codexResponses = [
      '{"type":"thread.started","thread_id":"sess_primary123"}\n' +
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"## Verdict\\nAPPROVED\\n"}}',
      '{"type":"thread.started","thread_id":"sess_second_opinion"}\n' +
      '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"## Verdict\\nAPPROVED\\n"}}'
    ];

    let codexRunIndex = 0;
    const capturedArgs: string[][] = [];

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      capturedArgs.push(options.args);
      const isJson = options.args.includes('--json');
      if (isJson) {
        const stdout = codexResponses[codexRunIndex++] || '';
        const prompt = options.args[options.args.length - 1] || '';
        const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
        if (outputPathMatch?.[1]) {
          const absOut = resolve(root, outputPathMatch[1]);
          mkdirSync(join(root, 'docs/dev'), { recursive: true });
          const verdict = stdout.includes('APPROVED') ? 'APPROVED' : 'REJECTED';
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n\n${verdict}\n`);
        }
        return {
          stdout,
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      } else {
        const prompt = options.args[options.args.length - 1] || '';
        const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
        if (outputPathMatch?.[1]) {
          const absOut = resolve(root, outputPathMatch[1]);
          mkdirSync(join(root, 'docs/dev'), { recursive: true });
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`);
        }
        return {
          stdout: '## Verdict\nAPPROVED\n',
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      }
    };

    const registry = createProductionAdapterRegistry(config.registry, { codexProcessRunner });

    mockSecondOpinionChoice = 'run-second-opinion';

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      startPoint: 'fresh',
      registry,
      output: mockOutput,
      interactive: true,
      auditContinuity: 'codex-resume'
    });

    expect(result.success).toBe(true);
    expect(result.verdict).toBe('APPROVED');

    expect(capturedArgs).toHaveLength(2);
    expect(capturedArgs[0]).toContain('exec');
    expect(capturedArgs[0]).toContain('--json');
    expect(capturedArgs[0]).not.toContain('resume');

    expect(capturedArgs[1]).toContain('exec');
    expect(capturedArgs[1]).not.toContain('--json');
    expect(capturedArgs[1]).not.toContain('resume');

    const scanResult = scan(root, {
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    });

    expect(scanResult.timeline).toHaveLength(2);
    
    const step1 = scanResult.timeline[0]!;
    expect(step1.sessionMode).toBe('fresh');
    expect(step1.sessionId).toBe('sess_primary123');

    const step2 = scanResult.timeline[1]!;
    expect(step2.sessionMode).toBe('none');
    expect(step2.sessionId).toBe('none');
  });
});
