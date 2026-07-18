import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  killProcessGroupGated,
  __setSignalSenderForTests,
  __resetForbiddenPgidCacheForTests,
  type KillTarget
} from '../src/kill-gate.js';
import type { ProcessIdentityResult } from '../src/process-identity.js';

/**
 * Unit coverage for the authorized kill gate — the single boundary every
 * `process.kill(-pgid, …)` routes through. All identity resolution and signal
 * delivery are injected, so these tests issue ZERO real signals and ZERO real
 * `ps` calls. They assert the gate can never target the CLI's own group, an
 * ancestor group, PID 1, or a recycled/foreign PGID.
 */

function verified(
  t: KillTarget,
  over: Partial<{ collisionResistant: boolean; exec: string; argv: string | undefined }> = {}
): ProcessIdentityResult {
  return {
    status: 'verified',
    pid: t.leaderPid,
    pgid: t.pgid,
    sessionId: t.sessionId ?? t.pgid,
    executablePath: over.exec ?? t.executablePath ?? '/usr/bin/provider',
    argvFingerprint: over.argv ?? t.argvFingerprint,
    startEvidence: { value: t.leaderStartMs, resolution: 'tick' },
    collisionResistant: over.collisionResistant ?? true
  };
}

function target(over: Partial<KillTarget> = {}): KillTarget {
  return {
    pgid: 99999,
    leaderPid: 99999,
    leaderStartMs: 1_000_000,
    sessionId: 99999,
    executablePath: '/usr/bin/provider',
    source: 'fresh',
    ...over
  };
}

const onlySystemForbidden = () => new Set<number>([0, 1]);

describe('killProcessGroupGated', () => {
  let sendCalls: Array<{ pid: number; signal: NodeJS.Signals | 0 }>;

  beforeEach(() => {
    sendCalls = [];
    __setSignalSenderForTests((pid, signal) => {
      sendCalls.push({ pid, signal });
    });
    __resetForbiddenPgidCacheForTests();
  });

  afterEach(() => {
    __setSignalSenderForTests(null);
    __resetForbiddenPgidCacheForTests();
  });

  describe('authorization (happy path)', () => {
    it('authorizes and sends when identity matches (strong)', () => {
      const t = target();
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => verified(t)
      });
      expect(res.sent).toBe(true);
      expect(sendCalls).toEqual([{ pid: -99999, signal: 'SIGTERM' }]);
    });

    it('accepts second-granularity recorded startMs within tolerance', () => {
      // Recorded value is second-granularity; observed precise within 2000ms.
      const t = target({ leaderStartMs: 1_000_000 });
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => ({
          ...verified(t),
          startEvidence: { value: 1_000_900, resolution: 'tick' }
        })
      });
      expect(res.sent).toBe(true);
    });

    it('rejects ambiguous identity even when partial pgid/session/start fields match', () => {
      const t = target({ pgid: 99999, sessionId: 99999, leaderStartMs: 1_000_000 });
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => ({
          status: 'ambiguous',
          reason: 'executablePath not determinable',
          partial: { pgid: 99999, sessionId: 99999, startMs: 1_000_000 }
        })
      });
      expect(res.sent).toBe(false);
      expect(res.outcome).toBe('rejected');
      expect(sendCalls).toEqual([]);
    });
  });

  describe('structural rejections (incident prevention)', () => {
    it('rejects pgid <= 1', () => {
      const res = killProcessGroupGated(target({ pgid: 1, leaderPid: 1 }), 'SIGKILL', {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => ({ status: 'gone' })
      });
      expect(res.sent).toBe(false);
      expect(sendCalls).toEqual([]);
    });

    it('rejects pgid === cli pid', () => {
      const t = target({ pgid: process.pid, leaderPid: process.pid });
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => verified(t)
      });
      expect(res.sent).toBe(false);
      expect(sendCalls).toEqual([]);
    });

    it('rejects a forbidden self/ancestor pgid', () => {
      const t = target({ pgid: 555, leaderPid: 555, sessionId: 555 });
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: () => new Set([0, 1, 555]),
        resolveIdentity: () => verified(t)
      });
      expect(res.sent).toBe(false);
      expect(sendCalls).toEqual([]);
    });

    it('fail-closes (rejects everything) when own pgid is unresolvable', () => {
      const t = target();
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: () => null,
        resolveIdentity: () => verified(t)
      });
      expect(res.sent).toBe(false);
      expect(sendCalls).toEqual([]);
    });
  });

  describe('identity rejections (PID-reuse defense)', () => {
    it('rejects when the leader is gone', () => {
      const t = target();
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => ({ status: 'gone' })
      });
      expect(res.sent).toBe(false);
      expect(sendCalls).toEqual([]);
    });

    it('rejects on pgid drift (PID reused into a different group)', () => {
      const t = target({ pgid: 99999 });
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => ({ ...verified(t), pgid: 88888 })
      });
      expect(res.sent).toBe(false);
      expect(sendCalls).toEqual([]);
    });

    it('rejects on startMs drift beyond tolerance (possible PID reuse)', () => {
      const t = target({ leaderStartMs: 1_000_000 });
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => ({
          ...verified(t),
          startEvidence: { value: 1_005_000, resolution: 'tick' }
        })
      });
      expect(res.sent).toBe(false);
      expect(sendCalls).toEqual([]);
    });

    it('rejects ambiguous-without-partial (unparseable identity)', () => {
      const t = target();
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => ({ status: 'ambiguous', reason: 'unparseable ps output' })
      });
      expect(res.sent).toBe(false);
      expect(sendCalls).toEqual([]);
    });

    it('requires exact executable identity for durable Linux authority', () => {
      const t = target({
        source: 'durable',
        executablePath: 'provider',
        argvFingerprint: 'provider\0--exact'
      });
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => verified(t, {
          exec: '/usr/bin/provider',
          argv: 'provider\0--exact',
          collisionResistant: true
        })
      });
      expect(res.sent).toBe(false);
      expect(sendCalls).toEqual([]);
    });
  });

  describe('signal 0 (ping) is structural-only', () => {
    it('sends without resolving identity', () => {
      const t = target();
      let identityCalled = false;
      const res = killProcessGroupGated(t, 0, {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => {
          identityCalled = true;
          return verified(t);
        }
      });
      expect(res.sent).toBe(true);
      expect(identityCalled).toBe(false);
      expect(sendCalls).toEqual([{ pid: -99999, signal: 0 }]);
    });

    it('never probes a forbidden group even with signal 0', () => {
      const res = killProcessGroupGated(target({ pgid: 555 }), 0, {
        forbiddenPgids: () => new Set([555])
      });
      expect(res.sent).toBe(false);
      expect(sendCalls).toEqual([]);
    });
  });

  describe('send-error handling', () => {
    it('treats ESRCH on send as already-gone', () => {
      const t = target();
      __setSignalSenderForTests(() => {
        const e: Error & { code?: string } = new Error('No such process');
        e.code = 'ESRCH';
        throw e;
      });
      const res = killProcessGroupGated(t, 'SIGTERM', {
        forbiddenPgids: onlySystemForbidden,
        resolveIdentity: () => verified(t)
      });
      expect(res.sent).toBe(false);
      expect(res.outcome).toBe('already-gone');
    });
  });
});
