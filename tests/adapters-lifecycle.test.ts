import { describe, it, expect } from 'vitest';
import { createOpencodeAdapter } from '../src/adapters/opencode.js';
import { createCodexAdapter } from '../src/adapters/codex.js';
import { createClaudeAdapter } from '../src/adapters/claude.js';
import {
  spawnAgentProcess,
  type ProcessRunner,
  type ProcessRunOptions,
  type RawProcessResult
} from '../src/adapters/utils.js';
import {
  summarizeLifecycle,
  type LifecycleEvent
} from '../src/adapter-lifecycle.js';

describe('summarizeLifecycle (model helper)', () => {
  it('reduces a started + 2 messages + completed sequence to the last message and summed tool-call count', () => {
    const events: LifecycleEvent[] = [
      { type: 'started', agent: 'opencode', model: 'm', version: 1, skillId: 's', message: 'go', atMs: 0 },
      { type: 'message', agent: 'opencode', version: 1, text: 'first', toolCalls: 1, atMs: 1 },
      { type: 'message', agent: 'opencode', version: 1, text: 'second', toolCalls: 2, atMs: 2 },
      { type: 'completed', agent: 'opencode', version: 1, atMs: 3 }
    ];
    const summary = summarizeLifecycle(events);
    expect(summary.lastMessage).toBe('second');
    expect(summary.toolCallCount).toBe(3);
  });

  it('returns null lastMessage and zero toolCallCount when no message events', () => {
    const events: LifecycleEvent[] = [
      { type: 'started', agent: 'opencode', model: 'm', version: 1, skillId: 's', message: 'go', atMs: 0 },
      { type: 'completed', agent: 'opencode', version: 1, atMs: 1 }
    ];
    const summary = summarizeLifecycle(events);
    expect(summary.lastMessage).toBeNull();
    expect(summary.toolCallCount).toBe(0);
  });
});

/** Build a ProcessRunner that returns the canned RawProcessResult after
 *  optionally calling onStdoutChunk for the test's chunk list. */
function makeRunner(raw: RawProcessResult, chunks: string[] = []): ProcessRunner {
  return async (options: ProcessRunOptions): Promise<RawProcessResult> => {
    for (const chunk of chunks) {
      options.onStdoutChunk?.(chunk);
    }
    return raw;
  };
}

function collectEvents(): { events: LifecycleEvent[]; push: (e: LifecycleEvent) => void } {
  const events: LifecycleEvent[] = [];
  return { events, push: (e) => events.push(e) };
}

describe('spawnAgentProcess (codex/claude generic helper) — shared lifecycle contract', () => {
  it('emits started → completed on zero-exit success, no message events', async () => {
    const { events, push } = collectEvents();
    const runner = makeRunner({ stdout: '', stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 });
    const result = await spawnAgentProcess('codex', ['exec'], '/tmp', {
      agent: 'codex', model: 'm', skillId: 'plan-audit', version: 1, onLifecycle: push
    }, runner);
    expect(result.error).toBeUndefined();
    expect(events.map(e => e.type)).toEqual(['started', 'completed']);
  });

  it('emits started → failed { errorKind: "nonzero-exit" } on nonzero exit (v3 audit closure)', async () => {
    const { events, push } = collectEvents();
    const runner = makeRunner({ stdout: '', stderr: '', exitCode: 1, timedOut: false, signal: null, durationMs: 1 });
    const result = await spawnAgentProcess('claude', ['-p'], '/tmp', {
      agent: 'claude', model: 'm', skillId: 'plan-audit', version: 1, onLifecycle: push
    }, runner);
    expect(result.error).toBeUndefined(); // RunResult error stays spawn-only
    expect(result.exitCode).toBe(1);
    expect(events).toHaveLength(2);
    expect(events[0]!.type).toBe('started');
    expect(events[1]!.type).toBe('failed');
    if (events[1]!.type === 'failed') {
      expect(events[1]!.errorKind).toBe('nonzero-exit');
    }
  });

  it('emits started → failed { errorKind: "spawn" } on spawn error', async () => {
    const { events, push } = collectEvents();
    const runner = makeRunner({
      stdout: '', stderr: '', exitCode: -1, timedOut: false, signal: null, durationMs: 1,
      spawnErrorMessage: 'command not found'
    });
    const result = await spawnAgentProcess('codex', ['exec'], '/tmp', {
      agent: 'codex', model: 'm', skillId: 'plan-audit', version: 1, onLifecycle: push
    }, runner);
    expect(result.error?.kind).toBe('spawn');
    expect(events[1]!.type).toBe('failed');
    if (events[1]!.type === 'failed') {
      expect(events[1]!.errorKind).toBe('spawn');
    }
  });

  it('NEVER emits a message event for codex/claude (per-adapter richness boundary)', async () => {
    const { events, push } = collectEvents();
    const runner = makeRunner({ stdout: 'lots of output', stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 });
    await spawnAgentProcess('codex', ['exec'], '/tmp', {
      agent: 'codex', model: 'm', skillId: 'plan-audit', version: 1, onLifecycle: push
    }, runner);
    expect(events.some(e => e.type === 'message')).toBe(false);
  });

  it('emits started → failed { errorKind: "timeout" } and RunResult error.kind "timeout" when raw.timedOut is true (watchdog §1)', async () => {
    const { events, push } = collectEvents();
    const runner = makeRunner({ stdout: '', stderr: '', exitCode: 0, timedOut: true, signal: null, durationMs: 60000 });
    const result = await spawnAgentProcess('codex', ['exec'], '/tmp', {
      agent: 'codex', model: 'm', skillId: 'plan-audit', version: 1, onLifecycle: push,
      timeoutMs: 1000
    }, runner);
    expect(result.error?.kind).toBe('timeout');
    expect(events.map(e => e.type)).toEqual(['started', 'failed']);
    if (events[1]!.type === 'failed') {
      expect(events[1]!.errorKind).toBe('timeout');
    }
  });

  it('watchdog timeout classification also applies through the claude lifecycle path', async () => {
    const { events, push } = collectEvents();
    const runner = makeRunner({ stdout: '', stderr: '', exitCode: 124, timedOut: true, signal: 'SIGTERM' as any, durationMs: 60000 });
    const result = await spawnAgentProcess('claude', ['-p'], '/tmp', {
      agent: 'claude', model: 'm', skillId: 'plan-audit', version: 1, onLifecycle: push,
      timeoutMs: 2000
    }, runner);
    // Timeout takes precedence over nonzero-exit.
    expect(result.error?.kind).toBe('timeout');
    const failed = events.find(e => e.type === 'failed');
    expect(failed).toBeDefined();
    if (failed && failed.type === 'failed') {
      expect(failed.errorKind).toBe('timeout');
    }
  });

  it('passes the resolved timeoutMs through to the process runner', async () => {
    let captured: any = undefined;
    const runner: ProcessRunner = async (options) => {
      captured = options;
      return { stdout: '', stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 };
    };
    await spawnAgentProcess('codex', ['exec'], '/tmp', {
      agent: 'codex', model: 'm', skillId: 'plan-audit', version: 1, timeoutMs: 4242
    }, runner);
    expect(captured.timeoutMs).toBe(4242);
  });
});

describe('codex & claude adapters — adapterFinalized terminal ownership & lifecycle (processRunner injection seam)', () => {
  describe('codex adapter terminal lifecycle', () => {
    it('valid stream → started → progress message → completed (exactly 1 completed), stdout set, no error', async () => {
      const events: LifecycleEvent[] = [];
      const validStream = [
        '{"type":"thread.started","thread_id":"sess_codex_999"}',
        '{"type":"item.created","item":{"id":"t-1","type":"command_execution"}}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"APPROVED\\nAll done."}}',
      ].join('\n');
      const runner: ProcessRunner = async (opts) => {
        opts.onStdoutChunk?.(validStream);
        return { stdout: validStream, stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 };
      };
      const adapter = createCodexAdapter({ processRunner: runner });
      const result = await adapter.run({
        prompt: 'do work',
        model: 'gpt-5.4',
        cwd: '/tmp',
        skillId: 'plan-audit',
        version: 1,
        onLifecycle: (e) => events.push(e),
      });

      expect(result.error).toBeUndefined();
      expect(result.stdout).toBe('APPROVED\nAll done.');
      expect(result.sessionId).toBe('sess_codex_999');

      const types = events.map(e => e.type);
      expect(types[0]).toBe('started');
      expect(types.filter(t => t === 'completed')).toHaveLength(1);
      expect(types.filter(t => t === 'failed')).toHaveLength(0);
      expect(types[types.length - 1]).toBe('completed');
    });

    it('zero-exit malformed / incomplete stream → started → failed (errorKind: server), NO completed event emitted', async () => {
      const events: LifecycleEvent[] = [];
      // Missing agent_message on finish
      const malformedStream = '{"type":"thread.started","thread_id":"sess_codex_999"}\n';
      const runner: ProcessRunner = async (opts) => {
        opts.onStdoutChunk?.(malformedStream);
        return { stdout: malformedStream, stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 };
      };
      const adapter = createCodexAdapter({ processRunner: runner });
      const result = await adapter.run({
        prompt: 'do work',
        model: 'gpt-5.4',
        cwd: '/tmp',
        skillId: 'plan-audit',
        version: 1,
        onLifecycle: (e) => events.push(e),
      });

      expect(result.error?.kind).toBe('server');
      const types = events.map(e => e.type);
      expect(types[0]).toBe('started');
      expect(types.filter(t => t === 'completed')).toHaveLength(0);
      expect(types.filter(t => t === 'failed')).toHaveLength(1);
      expect(types[types.length - 1]).toBe('failed');
      const failed = events.find((e): e is Extract<LifecycleEvent, { type: 'failed' }> => e.type === 'failed');
      expect(failed?.errorKind).toBe('server');
    });

    it('resumed session ID mismatch → started → failed (errorKind: server), NO completed event emitted', async () => {
      const events: LifecycleEvent[] = [];
      const stream = [
        '{"type":"thread.started","thread_id":"sess_different"}',
        '{"type":"item.completed","item":{"type":"agent_message","text":"APPROVED"}}',
      ].join('\n');
      const runner: ProcessRunner = async (opts) => {
        opts.onStdoutChunk?.(stream);
        return { stdout: stream, stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 };
      };
      const adapter = createCodexAdapter({ processRunner: runner });
      const result = await adapter.run({
        prompt: 'do work',
        model: 'gpt-5.4',
        cwd: '/tmp',
        skillId: 'plan-audit',
        version: 1,
        continuity: { mode: 'resumed', sessionId: 'sess_expected' },
        onLifecycle: (e) => events.push(e),
      });

      expect(result.error?.kind).toBe('server');
      expect(result.error?.message).toContain('Resumed thread ID mismatch');
      const types = events.map(e => e.type);
      expect(types.filter(t => t === 'completed')).toHaveLength(0);
      expect(types.filter(t => t === 'failed')).toHaveLength(1);
      const failed = events.find((e): e is Extract<LifecycleEvent, { type: 'failed' }> => e.type === 'failed');
      expect(failed?.errorKind).toBe('server');
    });
  });

  describe('claude adapter terminal lifecycle', () => {
    it('valid stream → started → progress message → completed (exactly 1 completed), stdout set, no error', async () => {
      const events: LifecycleEvent[] = [];
      const validStream = [
        '{"type":"system","session_id":"sess_claude_111"}',
        '{"type":"assistant","session_id":"sess_claude_111","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Bash"}]}}',
        '{"type":"result","session_id":"sess_claude_111","result":"COMPLETED"}',
      ].join('\n') + '\n';
      const runner: ProcessRunner = async (opts) => {
        opts.onStdoutChunk?.(validStream);
        return { stdout: validStream, stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 };
      };
      const adapter = createClaudeAdapter({ processRunner: runner });
      const result = await adapter.run({
        prompt: 'do work',
        model: 'glm-5.2',
        cwd: '/tmp',
        skillId: 'plan-follow-up',
        version: 1,
        onLifecycle: (e) => events.push(e),
      });

      expect(result.error).toBeUndefined();
      expect(result.stdout).toBe('COMPLETED');
      expect(result.sessionId).toBe('sess_claude_111');

      const types = events.map(e => e.type);
      expect(types[0]).toBe('started');
      expect(types.filter(t => t === 'completed')).toHaveLength(1);
      expect(types.filter(t => t === 'failed')).toHaveLength(0);
      expect(types[types.length - 1]).toBe('completed');
    });

    it('zero-exit malformed / incomplete stream → started → failed (errorKind: server), NO completed event emitted', async () => {
      const events: LifecycleEvent[] = [];
      // Missing result event on finish
      const malformedStream = '{"type":"system","session_id":"sess_claude_111"}\n';
      const runner: ProcessRunner = async (opts) => {
        opts.onStdoutChunk?.(malformedStream);
        return { stdout: malformedStream, stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 };
      };
      const adapter = createClaudeAdapter({ processRunner: runner });
      const result = await adapter.run({
        prompt: 'do work',
        model: 'glm-5.2',
        cwd: '/tmp',
        skillId: 'plan-follow-up',
        version: 1,
        onLifecycle: (e) => events.push(e),
      });

      expect(result.error?.kind).toBe('server');
      const types = events.map(e => e.type);
      expect(types[0]).toBe('started');
      expect(types.filter(t => t === 'completed')).toHaveLength(0);
      expect(types.filter(t => t === 'failed')).toHaveLength(1);
      expect(types[types.length - 1]).toBe('failed');
      const failed = events.find((e): e is Extract<LifecycleEvent, { type: 'failed' }> => e.type === 'failed');
      expect(failed?.errorKind).toBe('server');
    });

    it('resumed session ID mismatch → started → failed (errorKind: server), NO completed event emitted', async () => {
      const events: LifecycleEvent[] = [];
      const stream = [
        '{"type":"system","session_id":"sess_different"}',
        '{"type":"result","session_id":"sess_different","result":"COMPLETED"}',
      ].join('\n') + '\n';
      const runner: ProcessRunner = async (opts) => {
        opts.onStdoutChunk?.(stream);
        return { stdout: stream, stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 };
      };
      const adapter = createClaudeAdapter({ processRunner: runner });
      const result = await adapter.run({
        prompt: 'do work',
        model: 'glm-5.2',
        cwd: '/tmp',
        skillId: 'plan-follow-up',
        version: 1,
        continuity: { mode: 'resumed', sessionId: 'sess_expected' },
        onLifecycle: (e) => events.push(e),
      });

      expect(result.error?.kind).toBe('server');
      expect(result.error?.message).toContain('Resumed thread ID mismatch');
      const types = events.map(e => e.type);
      expect(types.filter(t => t === 'completed')).toHaveLength(0);
      expect(types.filter(t => t === 'failed')).toHaveLength(1);
      const failed = events.find((e): e is Extract<LifecycleEvent, { type: 'failed' }> => e.type === 'failed');
      expect(failed?.errorKind).toBe('server');
    });
  });
});

describe('opencode adapter — processRunner injection seam (v8 audit M2 closure)', () => {
  it('emits started → message per chunk (delta, not cumulative) → completed on zero-exit success', async () => {
    const events: LifecycleEvent[] = [];
    const chunk1 = '{"type":"text","part":{"type":"text","text":"hello"}}\n';
    const chunk2 = '{"type":"text","part":{"type":"text","text":" world"}}\n';
    const chunk3 = '{"type":"tool_use","part":{"tool":"write","callID":"a","state":{"status":"ok"}}}\n';
    const chunk4 = '{"type":"tool_use","part":{"tool":"read","callID":"b","state":{"status":"ok"}}}\n';
    const allChunks = chunk1 + chunk2 + chunk3 + chunk4;
    const runner: ProcessRunner = async (options) => {
      options.onStdoutChunk?.(chunk1);
      options.onStdoutChunk?.(chunk2);
      options.onStdoutChunk?.(chunk3);
      options.onStdoutChunk?.(chunk4);
      return { stdout: allChunks, stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 };
    };
    const adapter = createOpencodeAdapter({ processRunner: runner });
    const result = await adapter.run({
      prompt: 'p', model: 'opencode-go/deepseek-v4-flash', cwd: '/tmp',
      skillId: 'plan-audit', version: 1,
      onLifecycle: (e) => events.push(e)
    });
    expect(result.error).toBeUndefined();
    const types = events.map(e => e.type);
    expect(types[0]).toBe('started');
    expect(types[types.length - 1]).toBe('completed');
    // Two message events (one for each text chunk and two for the tool calls;
    // the exact count depends on whether the deltas are emitted per chunk).
    const messageEvents = events.filter(e => e.type === 'message') as Array<Extract<LifecycleEvent, { type: 'message' }>>;
    expect(messageEvents.length).toBeGreaterThan(0);
    // Each text is a non-overlapping suffix and concatenating them equals the full text
    const allText = messageEvents.map(m => m.text).join('');
    expect(allText).toBe('hello world');
    // Each toolCalls is a delta; the sum equals the final cumulative count
    const totalToolCalls = messageEvents.reduce((sum, m) => sum + (m.toolCalls ?? 0), 0);
    expect(totalToolCalls).toBe(2);
  });

  it('emits started → failed { errorKind: "nonzero-exit" } when raw.exitCode is 1', async () => {
    const events: LifecycleEvent[] = [];
    const runner: ProcessRunner = async () => ({
      stdout: '', stderr: '', exitCode: 1, timedOut: false, signal: null, durationMs: 1
    });
    const adapter = createOpencodeAdapter({ processRunner: runner });
    const result = await adapter.run({
      prompt: 'p', model: 'opencode-go/deepseek-v4-flash', cwd: '/tmp',
      skillId: 'plan-audit', version: 1,
      onLifecycle: (e) => events.push(e)
    });
    expect(result.error?.kind).toBe('nonzero-exit');
    const failed = events.find(e => e.type === 'failed');
    expect(failed).toBeDefined();
    if (failed && failed.type === 'failed') {
      expect(failed.errorKind).toBe('nonzero-exit');
    }
  });

  it('emits started → failed { errorKind: "spawn" } on spawn error', async () => {
    const events: LifecycleEvent[] = [];
    const runner: ProcessRunner = async () => ({
      stdout: '', stderr: '', exitCode: -1, timedOut: false, signal: null, durationMs: 1,
      spawnErrorMessage: 'ENOENT'
    });
    const adapter = createOpencodeAdapter({ processRunner: runner });
    const result = await adapter.run({
      prompt: 'p', model: 'opencode-go/deepseek-v4-flash', cwd: '/tmp',
      skillId: 'plan-audit', version: 1,
      onLifecycle: (e) => events.push(e)
    });
    expect(result.error?.kind).toBe('spawn');
    const failed = events.find(e => e.type === 'failed');
    if (failed && failed.type === 'failed') {
      expect(failed.errorKind).toBe('spawn');
    }
  });

  it('emits failed { errorKind: "config" } when stderr contains "provider not found"', async () => {
    const events: LifecycleEvent[] = [];
    const runner: ProcessRunner = async () => ({
      stdout: '', stderr: 'Error: provider not found on server', exitCode: 0, timedOut: false, signal: null, durationMs: 1
    });
    const adapter = createOpencodeAdapter({ processRunner: runner });
    const result = await adapter.run({
      prompt: 'p', model: 'opencode-go/deepseek-v4-flash', cwd: '/tmp',
      skillId: 'plan-audit', version: 1,
      onLifecycle: (e) => events.push(e)
    });
    expect(result.error?.kind).toBe('config');
    const failed = events.find(e => e.type === 'failed');
    if (failed && failed.type === 'failed') {
      expect(failed.errorKind).toBe('config');
    }
  });

  it('emits failed { errorKind: "auth" } when stderr contains "unauthorized"', async () => {
    const events: LifecycleEvent[] = [];
    const runner: ProcessRunner = async () => ({
      stdout: '', stderr: 'Error: unauthorized API key', exitCode: 0, timedOut: false, signal: null, durationMs: 1
    });
    const adapter = createOpencodeAdapter({ processRunner: runner });
    const result = await adapter.run({
      prompt: 'p', model: 'opencode-go/deepseek-v4-flash', cwd: '/tmp',
      skillId: 'plan-audit', version: 1,
      onLifecycle: (e) => events.push(e)
    });
    expect(result.error?.kind).toBe('auth');
    const failed = events.find(e => e.type === 'failed');
    if (failed && failed.type === 'failed') {
      expect(failed.errorKind).toBe('auth');
    }
  });

  it('emits failed { errorKind: "timeout" } when raw.timedOut is true', async () => {
    const events: LifecycleEvent[] = [];
    const runner: ProcessRunner = async () => ({
      stdout: '', stderr: '', exitCode: 0, timedOut: true, signal: null, durationMs: 600000
    });
    const adapter = createOpencodeAdapter({ processRunner: runner });
    const result = await adapter.run({
      prompt: 'p', model: 'opencode-go/deepseek-v4-flash', cwd: '/tmp',
      skillId: 'plan-audit', version: 1,
      onLifecycle: (e) => events.push(e)
    });
    expect(result.error?.kind).toBe('timeout');
    const failed = events.find(e => e.type === 'failed');
    if (failed && failed.type === 'failed') {
      expect(failed.errorKind).toBe('timeout');
    }
  });
});
