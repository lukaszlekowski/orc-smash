import { describe, it, expect } from 'vitest';
import {
  spawnAgentProcess,
  spawnOpencode,
  type ProcessRunner,
  type RawProcessResult
} from '../../src/adapters/utils.js';
import { structuredMessage } from '../../src/adapters/errors.js';
import type { LifecycleEvent } from '../../src/adapter-lifecycle.js';
import type { SpawnRuntime } from '../../src/adapters/process-group.js';
import { makeRunResult, makeRunError } from '../helpers/results.js';

/**
 * M2 coverage: ownership-control failures from the owned spawn path (group
 * close verification / cgroup cleanup) must surface as `error.kind ===
 * 'ownership'`, NOT 'spawn', so structuredMessage() renders the operator
 * recovery procedure instead of "CLI missing from PATH". Genuine spawn failures
 * (ENOENT) stay 'spawn'.
 */
function ownershipFailureRunner(message: string): ProcessRunner {
  return async (): Promise<RawProcessResult> => ({
    stdout: '',
    stderr: '',
    exitCode: -1,
    timedOut: false,
    signal: null,
    durationMs: 1,
    ownershipFailure: { message }
  });
}

function spawnErrorRunner(message: string): ProcessRunner {
  return async (): Promise<RawProcessResult> => ({
    stdout: '',
    stderr: '',
    exitCode: -1,
    timedOut: false,
    signal: null,
    durationMs: 1,
    spawnErrorMessage: message
  });
}

function collectEvents(): { events: LifecycleEvent[]; push: (e: LifecycleEvent) => void } {
  const events: LifecycleEvent[] = [];
  return { events, push: (e) => events.push(e) };
}

describe('spawnAgentProcess — ownership failure classification', () => {
  it('classifies an ownershipFailure as ownership, not spawn', async () => {
    const { events, push } = collectEvents();
    const result = await spawnAgentProcess(
      'codex',
      ['exec'],
      '/tmp',
      { agent: 'codex', model: 'm', skillId: 'plan-audit', version: 1, onLifecycle: push },
      ownershipFailureRunner('Ownership verification failed: survivors')
    );

    expect(result.error?.kind).toBe('ownership');
    expect(result.error?.message).toContain('Ownership verification failed');
    expect(events.some((e) => e.type === 'failed' && e.errorKind === 'ownership')).toBe(true);
  });

  it('still classifies a genuine spawnErrorMessage as spawn (regression)', async () => {
    const { events, push } = collectEvents();
    const result = await spawnAgentProcess(
      'claude',
      ['-p'],
      '/tmp',
      { agent: 'claude', model: 'm', skillId: 'plan-audit', version: 1, onLifecycle: push },
      spawnErrorRunner('ENOENT')
    );

    expect(result.error?.kind).toBe('spawn');
    expect(events.some((e) => e.type === 'failed' && e.errorKind === 'spawn')).toBe(true);
  });

  it('prefers ownership over spawn when both signals are present', async () => {
    const both: ProcessRunner = async (): Promise<RawProcessResult> => ({
      stdout: '',
      stderr: '',
      exitCode: -1,
      timedOut: false,
      signal: null,
      durationMs: 1,
      spawnErrorMessage: 'ENOENT',
      ownershipFailure: { message: 'Ownership verification failed: cgroup unreadable' }
    });
    const result = await spawnAgentProcess(
      'agy',
      [],
      '/tmp',
      { agent: 'agy', model: 'm', skillId: 'plan-audit', version: 1 },
      both
    );
    expect(result.error?.kind).toBe('ownership');
  });
});

describe('spawnOpencode — ownership failure classification', () => {
  it('classifies an ownershipFailure as ownership (early return, no stream parse)', async () => {
    const { events, push } = collectEvents();
    const result = await spawnOpencode(
      { prompt: '', model: 'm', cwd: '/tmp', skillId: 'plan-audit', version: 1, onLifecycle: push },
      [],
      { processRunner: ownershipFailureRunner('Ownership verification failed: survivors') }
    );

    expect(result.error?.kind).toBe('ownership');
    expect(result.error?.message).toContain('Ownership verification failed');
    expect(events.some((e) => e.type === 'failed' && e.errorKind === 'ownership')).toBe(true);
  });
});

describe('structuredMessage — ownership remediation wording', () => {
  it('renders the operator recovery procedure for an ownership error', () => {
    const msg = structuredMessage(
      makeRunResult({ exitCode: -1, error: makeRunError({ kind: 'ownership', message: 'survivors remained' }) }),
      { label: 'Audit', model: 'm', agent: 'codex' }
    );
    expect(msg).toContain('Run ownership error');
    expect(msg).toContain('survivors remained');
    // Points the operator at the project admission lock recovery procedure,
    // distinguishing it from a spawn/PATH failure.
    expect(msg).toContain('project.lock');
  });
});

/**
 * v4-C1 coverage: the PRODUCTION shared spawn paths (codex/claude/agy via
 * spawnAgentProcess, opencode via spawnOpencode) must await the owned runtime's
 * `ready` bootstrap-registration barrier before resolving — not only the fake
 * adapter. A provider must not be treated as active before its group is durably
 * registered; a `ready` rejection is an ownership failure.
 */
function okRaw(): RawProcessResult {
  return { stdout: '', stderr: '', exitCode: 0, timedOut: false, signal: null, durationMs: 1 };
}

describe('spawnAgentProcess / spawnOpencode — owned bootstrap `ready` barrier (v4-C1)', () => {
  it('spawnAgentProcess does not resolve until the owned `ready` barrier settles', async () => {
    let releaseReady!: () => void;
    const ready = new Promise<void>((r) => { releaseReady = r; });
    const runtime: SpawnRuntime = { spawn: () => ({ result: Promise.resolve(okRaw()), ready }) };

    const p = spawnAgentProcess('codex', ['exec'], '/tmp', {
      agent: 'codex', model: 'm', skillId: 'plan-audit', version: 1, spawnRuntime: runtime
    });

    // `result` resolves almost immediately; if the path bypassed `ready`, p would settle now.
    await new Promise((r) => setTimeout(r, 25));
    let settled = false;
    await Promise.race([p.then(() => { settled = true; }), new Promise((r) => setTimeout(r, 15))]);
    expect(settled).toBe(false);

    releaseReady();
    const res = await p;
    expect(res.error).toBeUndefined();
    expect(res.exitCode).toBe(0);
  });

  it('spawnAgentProcess surfaces a `ready` rejection as an ownership failure', async () => {
    const runtime: SpawnRuntime = {
      spawn: () => ({ result: Promise.resolve(okRaw()), ready: Promise.reject(new Error('registration handshake failed')) })
    };
    const res = await spawnAgentProcess('claude', ['-p'], '/tmp', {
      agent: 'claude', model: 'm', skillId: 'plan-audit', version: 1, spawnRuntime: runtime
    });
    expect(res.error?.kind).toBe('ownership');
    expect(res.error?.message).toContain('Bootstrap registration barrier');
    expect(res.error?.message).toContain('registration handshake failed');
  });

  it('spawnOpencode awaits the owned `ready` barrier before resolving', async () => {
    let releaseReady!: () => void;
    const ready = new Promise<void>((r) => { releaseReady = r; });
    const runtime: SpawnRuntime = { spawn: () => ({ result: Promise.resolve(okRaw()), ready }) };

    const p = spawnOpencode(
      { prompt: '', model: 'm', cwd: '/tmp', skillId: 'plan-audit', version: 1, spawnRuntime: runtime },
      []
    );

    await new Promise((r) => setTimeout(r, 25));
    let settled = false;
    await Promise.race([p.then(() => { settled = true; }), new Promise((r) => setTimeout(r, 15))]);
    expect(settled).toBe(false);

    releaseReady();
    const res = await p;
    expect(res.error).toBeUndefined();
  });

  it('spawnOpencode surfaces a `ready` rejection as an ownership failure', async () => {
    const runtime: SpawnRuntime = {
      spawn: () => ({ result: Promise.resolve(okRaw()), ready: Promise.reject(new Error('wrapper exited before ACK')) })
    };
    const res = await spawnOpencode(
      { prompt: '', model: 'm', cwd: '/tmp', skillId: 'plan-audit', version: 1, spawnRuntime: runtime },
      []
    );
    expect(res.error?.kind).toBe('ownership');
    expect(res.error?.message).toContain('wrapper exited before ACK');
  });
});
