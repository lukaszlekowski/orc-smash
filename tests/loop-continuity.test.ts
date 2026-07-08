import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { createProductionAdapterRegistry } from '../src/adapters/registry.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { scan } from '../src/state.js';
import type { RawProcessResult, ProcessRunOptions } from '../src/adapters/utils.js';
import type { RunInput } from '../src/adapters/types.js';
import { buildFrontMatter } from '../src/provenance.js';

let mockStageActionChoices: string[] = [];
let mockSecondOpinionRunner = { agent: 'codex', model: 'gpt-5.5' };

function codexStdout(sessionId: string, text: string) {
  return JSON.stringify({
    type: 'thread.started',
    thread_id: sessionId
  }) + '\n' + JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text }
  });
}

vi.mock('../src/interactive.js', () => {
  return {
    promptStageAction: async () => {
      const choice = mockStageActionChoices.shift() ?? 'stop';
      return choice;
    },
    promptLoopSelect: async () => '',
    promptRunners: async (skills: string[]) => {
      const res: Record<string, any> = {};
      for (const s of skills) {
        res[s] = mockSecondOpinionRunner || { agent: 'fake', model: 'fake' };
      }
      return res;
    },
    promptMaxIterations: async () => 5
  };
});

describe('Loop Continuity Orchestration', () => {
  const tempWorkspace = resolve(process.cwd(), 'temp-loop-continuity-test');
  
  const mockOutput = {
    note: () => {},
    warn: vi.fn(),
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
    mockOutput.warn.mockClear();
    mockStageActionChoices = [];
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
      'providers:\n  codex:\n    - gpt-5.5\n  opencode:\n    - opencode-go/deepseek-v4-flash\n  claude:\n    - glm-4.7\ndefaults:\n  agent: codex\n  model: gpt-5.5\n'
    );
    return root;
  }

  it('runs first audit as fresh, follow-up as none, second audit as resumed, and verifies session IDs', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    let codexRunIndex = 0;
    const capturedArgs: string[][] = [];

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      capturedArgs.push(options.args);
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_abc123';
      
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      
      let isFollowUp = false;
      if (outputPathMatch?.[1]) {
        const absOut = resolve(root, outputPathMatch[1]);
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        isFollowUp = outputPathMatch[1].includes('followup');
        
        if (isFollowUp) {
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        } else {
          const verdict = codexRunIndex === 0 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n${verdict}\n`);
          codexRunIndex++;
        }
      }

      if (isFollowUp) {
        return {
          stdout: codexStdout(sessionId, 'Follow-up patched.'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      } else {
        const text = codexRunIndex === 1 ? 'REJECTED' : 'APPROVED';
        return {
          stdout: codexStdout(sessionId, text),
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
      registry,
      output: mockOutput,
      interactive: false
    });

    expect(result.success).toBe(true);
    expect(result.verdict).toBe('APPROVED');

    expect(capturedArgs).toHaveLength(3);
    expect(capturedArgs[0]).toContain('exec');
    expect(capturedArgs[0]).not.toContain('resume');
    
    expect(capturedArgs[2]).toContain('resume');
    expect(capturedArgs[2][capturedArgs[2].indexOf('resume') + 1]).toBe('sess_abc123');

    const scanResult = scan(root, {
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    });

    expect(scanResult.timeline).toHaveLength(3);
    expect(scanResult.timeline[0]!.sessionMode).toBe('fresh');
    expect(scanResult.timeline[0]!.sessionId).toBe('sess_abc123');
    expect(scanResult.timeline[1]!.sessionMode).toBe('fresh');
    expect(scanResult.timeline[1]!.sessionId).toBe('sess_abc123');
    expect(scanResult.timeline[2]!.sessionMode).toBe('resumed');
    expect(scanResult.timeline[2]!.sessionId).toBe('sess_abc123');
  });

  it('fails loudly on thread ID mismatch', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    let codexRunIndex = 0;
    const capturedArgs: string[][] = [];

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      capturedArgs.push(options.args);
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? 'sess_WRONG' : 'sess_abc123';
      
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      
      let isFollowUp = false;
      if (outputPathMatch?.[1]) {
        const absOut = resolve(root, outputPathMatch[1]);
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        isFollowUp = outputPathMatch[1].includes('followup');
        
        if (isFollowUp) {
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        } else {
          const verdict = codexRunIndex === 0 ? 'REJECTED' : 'APPROVED';
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n${verdict}\n`);
          codexRunIndex++;
        }
      }

      if (isFollowUp) {
        return {
          stdout: codexStdout(sessionId, 'Follow-up patched.'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      } else {
        const text = codexRunIndex === 1 ? 'REJECTED' : 'APPROVED';
        return {
          stdout: codexStdout(sessionId, text),
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
      registry,
      output: mockOutput,
      interactive: false
    });

    expect(result.success).toBe(false);
    expect(result.verdict).toBe('unknown');
    expect(result.message).toContain('Resumed thread ID mismatch: expected sess_abc123, got sess_WRONG');
  });

  it('warns and runs fresh when continuity is requested but no prior session id was found in history', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    const devDir = join(root, 'docs/dev');
    const priorMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 1, agent: 'codex', model: 'gpt-5.5', target: 'docs/dev/plan.md',
      priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z',
      sessionMode: 'none' as const, sessionId: 'none'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-codex.md'),
      buildFrontMatter(priorMeta) + `\n## Verdict\nREJECTED\n`
    );

    const registry = createProductionAdapterRegistry(config.registry, {
      codexProcessRunner: async (options) => {
        const prompt = options.args[options.args.length - 1] || '';
        const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
        let isFollowUp = false;
        if (outputPathMatch?.[1]) {
          const absOut = resolve(root, outputPathMatch[1]);
          mkdirSync(join(root, 'docs/dev'), { recursive: true });
          isFollowUp = outputPathMatch[1].includes('followup');
          if (isFollowUp) {
            writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
          } else {
            writeFileSync(absOut, `# Plan Audit\n\n## Verdict\nAPPROVED\n`);
          }
        }

        return {
          stdout: codexStdout('sess_codex_fresh', isFollowUp ? 'patched' : 'APPROVED'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      }
    });

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: false
    });

    expect(result.success).toBe(true);

    const warnings = mockOutput.warn.mock.calls.map(c => c[0]);
    expect(warnings.some(w => w.includes('resumed requested for follow-up but no prior codex/gpt-5.5 session found; starting fresh.'))).toBe(true);
    expect(warnings.some(w => w.includes('resumed requested for audit but no prior codex/gpt-5.5 session found; starting fresh.'))).toBe(true);
  });

  it('second-opinion audit starts a fresh continuity chain with its own session id; a later audit resumes it', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    let codexRunIndex = 0;
    const capturedArgs: string[][] = [];

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      capturedArgs.push(options.args);
      const isResumed = options.args.includes('resume');
      
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);

      let sessId = 'none';
      if (!isResumed) {
        sessId = codexRunIndex === 0 ? 'sess_primary' : 'sess_second_opinion';
      } else {
        sessId = options.args[options.args.indexOf('resume') + 1]!;
      }

      let isFollowUp = false;
      if (outputPathMatch?.[1]) {
        const absOut = resolve(root, outputPathMatch[1]);
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        isFollowUp = outputPathMatch[1].includes('followup');
        
        if (isFollowUp) {
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        } else {
          const verdict = codexRunIndex === 0 ? 'APPROVED' : (codexRunIndex === 1 ? 'REJECTED' : 'APPROVED');
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n${verdict}\n`);
          codexRunIndex++;
        }
      }

      if (isFollowUp) {
        return {
          stdout: codexStdout(sessId, 'Follow-up patched.'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      } else {
        const text = codexRunIndex === 1 ? 'APPROVED' : (codexRunIndex === 2 ? 'REJECTED' : 'APPROVED');
        return {
          stdout: codexStdout(sessId, text),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      }
    };

    const registry = createProductionAdapterRegistry(config.registry, { codexProcessRunner });

    mockSecondOpinionRunner = { agent: 'codex', model: 'gpt-5.5' };
    mockStageActionChoices = ['start-new-new-session', 'run-one-step-audit', 'continue', 'stop'];

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(result.success).toBe(true);
    expect(result.verdict).toBe('APPROVED');

    expect(capturedArgs).toHaveLength(4);

    expect(capturedArgs[0]).toContain('exec');
    expect(capturedArgs[0]).not.toContain('resume');

    expect(capturedArgs[1]).toContain('exec');
    expect(capturedArgs[1]).not.toContain('resume');

    expect(capturedArgs[2]).toContain('--json'); // follow-up is run under codex with continuity

    expect(capturedArgs[3]).toContain('resume');
    expect(capturedArgs[3][capturedArgs[3].indexOf('resume') + 1]).toBe('sess_second_opinion');

    const scanResult = scan(root, {
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    });

    expect(scanResult.timeline[0]!.version).toBe(1);
    expect(scanResult.timeline[0]!.sessionId).toBe('sess_primary');

    expect(scanResult.timeline[1]!.version).toBe(2);
    expect(scanResult.timeline[1]!.sessionId).toBe('sess_second_opinion');
    expect(scanResult.timeline[1]!.sessionMode).toBe('fresh');

    expect(scanResult.timeline[3]!.version).toBe(3);
    expect(scanResult.timeline[3]!.sessionId).toBe('sess_second_opinion');
    expect(scanResult.timeline[3]!.sessionMode).toBe('resumed');
  });

  it('opencode continuity: fresh first audit, resumed later audit, stable session id', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    let opencodeRunIndex = 0;
    const capturedArgs: string[][] = [];

    const opencodeSpawn = async (input: RunInput, args: string[]) => {
      capturedArgs.push(args);
      const prompt = args[args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      
      const isResumed = args.includes('-c');
      const sessionId = isResumed ? args[args.indexOf('-c') + 1] : 'ses_opencode123';

      if (outputPathMatch?.[1]) {
        const absOut = resolve(root, outputPathMatch[1]);
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        const verdict = opencodeRunIndex === 0 ? 'REJECTED' : 'APPROVED';
        writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n${verdict}\n`);
        opencodeRunIndex++;
      }

      return {
        stdout: '{"type":"step_start","timestamp":1783011546031,"sessionID":"' + sessionId + '"}\n' +
                '{"type":"text","part":{"text":"Done."}}\n' +
                '{"type":"step_finish","part":{"reason":"stop"}}',
        stderr: '',
        exitCode: 0,
        toolCalls: [],
        stopReason: 'stop',
        completion: 'complete' as const,
        sessionId
      };
    };

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_codex_fresh';

      let isFollowUp = false;
      if (outputPathMatch?.[1]) {
        const absOut = resolve(root, outputPathMatch[1]);
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        isFollowUp = outputPathMatch[1].includes('followup');
        if (isFollowUp) {
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        }
      }
      return {
        stdout: codexStdout(sessionId, isFollowUp ? 'patched' : 'APPROVED'),
        stderr: '',
        exitCode: 0,
        timedOut: false,
        signal: null,
        durationMs: 50
      };
    };

    const registry = createProductionAdapterRegistry(config.registry, { opencodeSpawn, codexProcessRunner });

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: false
    });

    expect(result.success).toBe(true);
    expect(result.verdict).toBe('APPROVED');

    expect(capturedArgs).toHaveLength(2);
    expect(capturedArgs[0]).not.toContain('-c');
    expect(capturedArgs[1]).toContain('-c');
    expect(capturedArgs[1][capturedArgs[1].indexOf('-c') + 1]).toBe('ses_opencode123');

    const scanResult = scan(root, {
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    });

    expect(scanResult.timeline[0]!.sessionMode).toBe('fresh');
    expect(scanResult.timeline[0]!.sessionId).toBe('ses_opencode123');
    expect(scanResult.timeline[2]!.sessionMode).toBe('resumed');
    expect(scanResult.timeline[2]!.sessionId).toBe('ses_opencode123');
  });

  it('claude continuity: fresh first audit, resumed later audit, stable session id', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    let claudeRunIndex = 0;
    const capturedArgs: string[][] = [];

    const claudeProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      capturedArgs.push(options.args);
      const isResumed = options.args.includes('--resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('--resume') + 1] : 'ses_claude123';
      const promptIndex = options.args.indexOf('-p');
      const prompt = promptIndex !== -1 ? options.args[promptIndex + 1] || '' : '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      if (outputPathMatch?.[1]) {
        const absOut = resolve(root, outputPathMatch[1]);
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        const verdict = claudeRunIndex === 0 ? 'REJECTED' : 'APPROVED';
        writeFileSync(absOut, `# Plan Audit\n\n## Verdict\n${verdict}\n`);
      }
      claudeRunIndex++;

      const stdout = JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'Done.',
        session_id: sessionId
      });
      return {
        stdout,
        stderr: '',
        exitCode: 0,
        timedOut: false,
        signal: null,
        durationMs: 50
      };
    };

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_codex_fresh';

      let isFollowUp = false;
      if (outputPathMatch?.[1]) {
        const absOut = resolve(root, outputPathMatch[1]);
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        isFollowUp = outputPathMatch[1].includes('followup');
        if (isFollowUp) {
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        }
      }
      return {
        stdout: codexStdout(sessionId, isFollowUp ? 'patched' : 'APPROVED'),
        stderr: '',
        exitCode: 0,
        timedOut: false,
        signal: null,
        durationMs: 50
      };
    };

    const registry = createProductionAdapterRegistry(config.registry, { claudeProcessRunner, codexProcessRunner });

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'claude', model: 'glm-4.7' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: false
    });

    expect(result.success).toBe(true);
    expect(result.verdict).toBe('APPROVED');

    expect(capturedArgs).toHaveLength(2);
    expect(capturedArgs[0]).not.toContain('--resume');
    expect(capturedArgs[1]).toContain('--resume');
    expect(capturedArgs[1][capturedArgs[1].indexOf('--resume') + 1]).toBe('ses_claude123');

    const scanResult = scan(root, {
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    });

    expect(scanResult.timeline[0]!.sessionMode).toBe('fresh');
    expect(scanResult.timeline[0]!.sessionId).toBe('ses_claude123');
    expect(scanResult.timeline[2]!.sessionMode).toBe('resumed');
    expect(scanResult.timeline[2]!.sessionId).toBe('ses_claude123');
  });

  it('provider mismatch never reuses another provider session id, even when other provider audit is latest', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    const devDir = join(root, 'docs/dev');
    const v1Meta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 1, agent: 'codex', model: 'gpt-5.5', target: 'docs/dev/plan.md',
      priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z',
      sessionMode: 'fresh' as const, sessionId: 'sess_A'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-codex.md'),
      buildFrontMatter(v1Meta) + `\n## Verdict\nREJECTED\n`
    );

    writeFileSync(
      join(devDir, 'plan-followup-v1-codex.md'),
      `# patched`
    );

    const v2Meta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 2, agent: 'opencode', model: 'deepseek-v4-flash', target: 'docs/dev/plan.md',
      priorAudit: 'docs/dev/plan-audit-v1-codex.md', timestamp: '2026-06-26T20:05:00.000Z',
      sessionMode: 'fresh' as const, sessionId: 'sess_B'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v2-opencode.md'),
      buildFrontMatter(v2Meta) + `\n## Verdict\nREJECTED\n`
    );

    writeFileSync(
      join(devDir, 'plan-followup-v2-codex.md'),
      `# patched`
    );

    const capturedArgs: string[][] = [];
    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      capturedArgs.push(options.args);
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_A';

      let isFollowUp = false;
      if (outputPathMatch?.[1]) {
        const absOut = resolve(root, outputPathMatch[1]);
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        isFollowUp = outputPathMatch[1].includes('followup');
        if (isFollowUp) {
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        } else {
          writeFileSync(absOut, `# Plan Audit\n\n## Verdict\nAPPROVED\n`);
        }
      }
      return {
        stdout: codexStdout(sessionId, isFollowUp ? 'patched' : 'APPROVED'),
        stderr: '',
        exitCode: 0,
        timedOut: false,
        signal: null,
        durationMs: 50
      };
    };

    const registry = createProductionAdapterRegistry(config.registry, { codexProcessRunner });

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: false
    });

    expect(result.success).toBe(true);
    expect(capturedArgs[0]).toContain('sess_A');
    expect(capturedArgs[0]).not.toContain('sess_B');

    const scanResult = scan(root, {
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    });
    expect(scanResult.timeline[4]!.sessionMode).toBe('resumed');
    expect(scanResult.timeline[4]!.sessionId).toBe('sess_A');
  });

  it('warns and runs fresh when in-chain same-provider session is missing', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    const devDir = join(root, 'docs/dev');
    const priorMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 1, agent: 'opencode', model: 'deepseek-v4-flash', target: 'docs/dev/plan.md',
      priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z',
      sessionMode: 'fresh' as const, sessionId: 'ses_opencode123'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-opencode.md'),
      buildFrontMatter(priorMeta) + `\n## Verdict\nREJECTED\n`
    );

    const registry = createProductionAdapterRegistry(config.registry, {
      codexProcessRunner: async (options) => {
        const prompt = options.args[options.args.length - 1] || '';
        const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
        let isFollowUp = false;
        if (outputPathMatch?.[1]) {
          const absOut = resolve(root, outputPathMatch[1]);
          mkdirSync(join(root, 'docs/dev'), { recursive: true });
          isFollowUp = outputPathMatch[1].includes('followup');
          if (isFollowUp) {
            writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
          } else {
            writeFileSync(absOut, `# Plan Audit\n\n## Verdict\nAPPROVED\n`);
          }
        }
        return {
          stdout: codexStdout('ses_codex_fresh', isFollowUp ? 'patched' : 'APPROVED'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      }
    });

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: false
    });

    expect(result.success).toBe(true);

    const warnings = mockOutput.warn.mock.calls.map(c => c[0]);
    expect(warnings.some(w => w.includes('resumed requested for follow-up but no prior codex/gpt-5.5 session found; starting fresh.'))).toBe(true);
    expect(warnings.some(w => w.includes('resumed requested for audit but no prior codex/gpt-5.5 session found; starting fresh.'))).toBe(true);
  });

  it('approved-boundary proof: stops backward scan at APPROVED boundary and warns/runs fresh', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    const devDir = join(root, 'docs/dev');
    
    const v1Meta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 1, agent: 'codex', model: 'gpt-5.5', target: 'docs/dev/plan.md',
      priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z',
      sessionMode: 'fresh' as const, sessionId: 'sess_A'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-codex.md'),
      buildFrontMatter(v1Meta) + `\n## Verdict\nREJECTED\n`
    );

    const v2Meta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 2, agent: 'codex', model: 'gpt-5.5', target: 'docs/dev/plan.md',
      priorAudit: 'docs/dev/plan-audit-v1-codex.md', timestamp: '2026-06-26T20:05:00.000Z',
      sessionMode: 'fresh' as const, sessionId: 'sess_B'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v2-codex.md'),
      buildFrontMatter(v2Meta) + `\n## Verdict\nAPPROVED\n`
    );

    const v3Meta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 3, agent: 'codex', model: 'gpt-5.5', target: 'docs/dev/plan.md',
      priorAudit: 'docs/dev/plan-audit-v2-codex.md', timestamp: '2026-06-26T20:10:00.000Z',
      sessionMode: 'none' as const, sessionId: 'none'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v3-codex.md'),
      buildFrontMatter(v3Meta) + `\n## Verdict\nREJECTED\n`
    );

    const registry = createProductionAdapterRegistry(config.registry, {
      codexProcessRunner: async (options) => {
        const prompt = options.args[options.args.length - 1] || '';
        const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
        let isFollowUp = false;
        if (outputPathMatch?.[1]) {
          const absOut = resolve(root, outputPathMatch[1]);
          mkdirSync(join(root, 'docs/dev'), { recursive: true });
          isFollowUp = outputPathMatch[1].includes('followup');
          if (isFollowUp) {
            writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
          } else {
            writeFileSync(absOut, `# Plan Audit\n\n## Verdict\nAPPROVED\n`);
          }
        }
        return {
          stdout: codexStdout('ses_codex_fresh_new', isFollowUp ? 'patched' : 'APPROVED'),
          stderr: '',
          exitCode: 0,
          timedOut: false,
          signal: null,
          durationMs: 50
        };
      }
    });

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: false
    });

    expect(result.success).toBe(true);

    const warnings = mockOutput.warn.mock.calls.map(c => c[0]);
    expect(warnings.some(w => w.includes('resumed requested for follow-up but no prior codex/gpt-5.5 session found; starting fresh.'))).toBe(true);
    expect(warnings.some(w => w.includes('resumed requested for audit but no prior codex/gpt-5.5 session found; starting fresh.'))).toBe(true);
  });

  it('new-round-boundary proof: approved audit state forces fresh audit even with prior session in history', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    const devDir = join(root, 'docs/dev');

    const v1Meta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 1, agent: 'codex', model: 'gpt-5.5', target: 'docs/dev/plan.md',
      priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z',
      sessionMode: 'fresh' as const, sessionId: 'sess_A'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-codex.md'),
      buildFrontMatter(v1Meta) + `\n## Verdict\nAPPROVED\n`
    );

    const capturedArgs: string[][] = [];
    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      capturedArgs.push(options.args);
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      if (outputPathMatch?.[1]) {
        const absOut = resolve(root, outputPathMatch[1]);
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        writeFileSync(absOut, `# Plan Audit\n\n## Verdict\nAPPROVED\n`);
      }
      return {
        stdout: '{"type":"thread.started","thread_id":"sess_new_round"}\n' +
                '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"APPROVED"}}',
        stderr: '',
        exitCode: 0,
        timedOut: false,
        signal: null,
        durationMs: 50
      };
    };

    const registry = createProductionAdapterRegistry(config.registry, { codexProcessRunner });

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: false
    });

    expect(result.success).toBe(true);
    expect(capturedArgs[0]).not.toContain('resume');
    expect(capturedArgs[0]).not.toContain('sess_A');

    const scanResult = scan(root, {
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    });
    expect(scanResult.timeline[1]!.sessionMode).toBe('fresh');
    expect(scanResult.timeline[1]!.sessionId).toBe('sess_new_round');
  });

  it('second-opinion audit participates in continuity when its agent matches the continuity mode (fresh chain, own session id)', async () => {
    const root = setupProject();
    const config = loadConfig(root);

    const opencodeArgs: string[][] = [];
    const opencodeSpawn = async (input: RunInput, args: string[]) => {
      opencodeArgs.push(args);
      const prompt = args[args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      if (outputPathMatch?.[1]) {
        const absOut = resolve(root, outputPathMatch[1]);
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        writeFileSync(absOut, `# Plan Audit\n\n## Verdict\nAPPROVED\n`);
      }
      return {
        stdout: '{"type":"step_start","timestamp":1783011546031,"sessionID":"ses_second_opinion_opencode"}\n' +
                '{"type":"text","part":{"text":"Done."}}\n' +
                '{"type":"step_finish","part":{"reason":"stop"}}',
        stderr: '',
        exitCode: 0,
        toolCalls: [],
        stopReason: 'stop',
        completion: 'complete' as const,
        sessionId: 'ses_second_opinion_opencode'
      };
    };

    const codexProcessRunner = async (options: ProcessRunOptions): Promise<RawProcessResult> => {
      const prompt = options.args[options.args.length - 1] || '';
      const outputPathMatch = prompt.match(/Write your output to:\s*([^\s\r\n]+)/i);
      
      const isResumed = options.args.includes('resume');
      const sessionId = isResumed ? options.args[options.args.indexOf('resume') + 1] : 'sess_codex_fresh';

      let isFollowUp = false;
      if (outputPathMatch?.[1]) {
        const absOut = resolve(root, outputPathMatch[1]);
        mkdirSync(join(root, 'docs/dev'), { recursive: true });
        isFollowUp = outputPathMatch[1].includes('followup');
        if (isFollowUp) {
          writeFileSync(absOut, `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`);
        }
      }
      return {
        stdout: codexStdout(sessionId, isFollowUp ? 'patched' : 'APPROVED'),
        stderr: '',
        exitCode: 0,
        timedOut: false,
        signal: null,
        durationMs: 50
      };
    };

    const registry = createProductionAdapterRegistry(config.registry, { opencodeSpawn, codexProcessRunner });

    mockSecondOpinionRunner = { agent: 'opencode', model: 'opencode-go/deepseek-v4-flash' };
    mockStageActionChoices = ['run-one-step-audit', 'stop'];

    const devDir = join(root, 'docs/dev');
    const firstMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit' as const, role: 'auditor',
      version: 1, agent: 'codex', model: 'gpt-5.5', target: 'docs/dev/plan.md',
      priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z',
      sessionMode: 'fresh' as const, sessionId: 'sess_codex_first'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-codex.md'),
      buildFrontMatter(firstMeta) + `\n## Verdict\nAPPROVED\n`
    );

    const result = await runLoop(root, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'codex', model: 'gpt-5.5' },
      'plan-follow-up': { agent: 'codex', model: 'gpt-5.5' }
    }, {
      maxIterations: 5,
      registry,
      output: mockOutput,
      interactive: true
    });

    expect(result.success).toBe(true);

    const scanResult = scan(root, {
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    });

    const secondOpinionStep = scanResult.timeline.find(s => s.version === 2 && s.agent === 'opencode');
    expect(secondOpinionStep).toBeDefined();
    expect(secondOpinionStep!.sessionMode).toBe('fresh');
    expect(secondOpinionStep!.sessionId).toBe('ses_second_opinion_opencode');

    expect(opencodeArgs).toHaveLength(1);
    expect(opencodeArgs[0]).not.toContain('-c');
  });
});
