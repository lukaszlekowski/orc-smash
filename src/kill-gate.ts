import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  resolveProcessIdentity,
  START_TOLERANCE_MS,
  type ProcessIdentityResult,
  type VerifiedIdentity
} from './process-identity.js';

/**
 * The only production boundary that can deliver a negative-PID signal. The
 * `source` field is an authority distinction, not a logging hint:
 * fresh capabilities may signal while the creating CLI is alive; durable
 * records are refused on macOS and require collision-resistant Linux evidence.
 */

export interface KillTarget {
  pgid: number;
  leaderPid: number;
  leaderStartMs: number;
  sessionId?: number;
  executablePath?: string;
  argvFingerprint?: string;
  source: 'durable' | 'fresh';
}

export type GateDecision =
  | { outcome: 'authorized'; source: 'fresh' | 'durable'; identity: VerifiedIdentity }
  | {
      outcome: 'rejected';
      kind:
        | 'structural'
        | 'self-unresolvable'
        | 'identity-drift'
        | 'leader-gone'
        | 'ambiguous-identity'
        | 'durable-macos-refused'
        | 'durable-evidence-insufficient'
        | 'unsupported-platform';
      reason: string;
    };

export type KillGateResult =
  | {
      outcome: 'sent';
      sent: true;
      signal: NodeJS.Signals | 0;
      target: Pick<KillTarget, 'pgid' | 'leaderPid' | 'source'>;
      decision: Extract<GateDecision, { outcome: 'authorized' }>;
    }
  | {
      outcome: 'already-gone';
      sent: false;
      signal: NodeJS.Signals | 0;
      target: Pick<KillTarget, 'pgid' | 'leaderPid' | 'source'>;
      reason: string;
    }
  | {
      outcome: 'rejected';
      sent: false;
      signal: NodeJS.Signals | 0;
      target: Pick<KillTarget, 'pgid' | 'leaderPid' | 'source'>;
      decision: Extract<GateDecision, { outcome: 'rejected' }>;
      reason: string;
    };

/** Backward-compatible name used by the adapter seam. */
export type GatedKillResult = KillGateResult;

export interface GateDeps {
  /** Test seam for platform identity resolution. */
  resolveIdentity?: (pid: number) => ProcessIdentityResult;
  /** Test seam for self/ancestor group resolution. */
  forbiddenPgids?: () => Set<number> | null;
}

type SignalSender = (pid: number, signal: NodeJS.Signals | 0) => void;
let signalSender: SignalSender = (pid, signal) => {
  // Keep the negative-PID operation syntactically confined to this module.
  process.kill(pid, signal);
};

let forbiddenCache: Set<number> | null | undefined;
let forbiddenResolverOverride: (() => Set<number> | null) | null = null;

export function __setSignalSenderForTests(sender: SignalSender | null): void {
  signalSender = sender ?? ((pid, signal) => process.kill(pid, signal));
}

export function __resetForbiddenPgidCacheForTests(): void {
  forbiddenCache = undefined;
  forbiddenResolverOverride = null;
}

export function __setForbiddenPgidResolverForTests(resolver: (() => Set<number> | null) | null): void {
  forbiddenResolverOverride = resolver;
  forbiddenCache = undefined;
}

function targetSummary(target: KillTarget): Pick<KillTarget, 'pgid' | 'leaderPid' | 'source'> {
  return { pgid: target.pgid, leaderPid: target.leaderPid, source: target.source };
}

function rejected(
  target: KillTarget,
  signal: NodeJS.Signals | 0,
  kind: Extract<GateDecision, { outcome: 'rejected' }>['kind'],
  reason: string
): KillGateResult {
  const decision: Extract<GateDecision, { outcome: 'rejected' }> = {
    outcome: 'rejected',
    kind,
    reason
  };
  return {
    outcome: 'rejected',
    sent: false,
    signal,
    target: targetSummary(target),
    decision,
    reason
  };
}

function alreadyGone(target: KillTarget, signal: NodeJS.Signals | 0, reason: string): KillGateResult {
  return {
    outcome: 'already-gone',
    sent: false,
    signal,
    target: targetSummary(target),
    reason
  };
}

function authorized(
  target: KillTarget,
  signal: NodeJS.Signals | 0,
  decision: Extract<GateDecision, { outcome: 'authorized' }>
): KillGateResult {
  try {
    signalSender(-target.pgid, signal);
    return {
      outcome: 'sent',
      sent: true,
      signal,
      target: targetSummary(target),
      decision
    };
  } catch (error: any) {
    if (error?.code === 'ESRCH') return alreadyGone(target, signal, 'process group no longer exists');
    return rejected(
      target,
      signal,
      'identity-drift',
      `negative signal delivery failed: ${error?.message ?? String(error)}`
    );
  }
}

function readPgid(pid: number): number | null {
  try {
    const value = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000
    }).trim();
    const pgid = Number.parseInt(value, 10);
    return Number.isInteger(pgid) ? pgid : null;
  } catch {
    return null;
  }
}

function readParentAndPgid(pid: number): { ppid: number; pgid: number } | null {
  try {
    const output = execFileSync('ps', ['-o', 'ppid=,pgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000
    }).trim();
    const parts = output.split(/\s+/);
    const ppid = Number.parseInt(parts[0]!, 10);
    const pgid = Number.parseInt(parts[1]!, 10);
    if (!Number.isInteger(ppid) || !Number.isInteger(pgid)) return null;
    return { ppid, pgid };
  } catch {
    return null;
  }
}

/**
 * Resolve the CLI's own and every ancestor process group without using
 * `process.kill(0, ...)`, which would target the caller's group. Any lookup
 * failure returns null so every terminating signal fails closed.
 */
export function resolveForbiddenPgids(): Set<number> | null {
  if (forbiddenResolverOverride) return forbiddenResolverOverride();
  if (forbiddenCache !== undefined) return forbiddenCache;

  const ownPgid = readPgid(process.pid);
  if (ownPgid === null) {
    forbiddenCache = null;
    return null;
  }

  const forbidden = new Set<number>([0, 1, process.pid, ownPgid]);
  let pid = process.ppid;
  let depth = 0;
  while (pid > 1 && depth < 64) {
    const identity = readParentAndPgid(pid);
    if (!identity) {
      forbiddenCache = null;
      return null;
    }
    forbidden.add(identity.pgid);
    if (identity.ppid === pid) {
      forbiddenCache = null;
      return null;
    }
    pid = identity.ppid;
    depth++;
  }
  if (depth >= 64) {
    forbiddenCache = null;
    return null;
  }

  forbiddenCache = forbidden;
  return forbidden;
}

function structuralReason(target: KillTarget, forbidden: Set<number> | null): string | null {
  if (!Number.isInteger(target.pgid) || target.pgid <= 1) return `pgid ${target.pgid} <= 1`;
  if (target.pgid === process.pid) return 'pgid equals the CLI pid';
  if (target.pgid === process.ppid) return 'pgid equals the CLI parent pid';
  if (!forbidden) return 'could not resolve the CLI self/ancestor process groups';
  if (forbidden.has(target.pgid)) return `pgid ${target.pgid} belongs to the CLI or an ancestor`;
  return null;
}

function sameExecutable(expected: string, observed: string): boolean {
  if (expected === observed) return true;
  // A command without a slash is a PATH lookup request. The runtime stores the
  // resolved path where possible, but basename comparison preserves that exact
  // spawn contract for a provider whose platform display omits its directory.
  if (!expected.includes(path.sep) || !observed.includes(path.sep)) {
    return path.basename(expected) === path.basename(observed);
  }
  return false;
}

function durableExecutableMatches(expected: string, observed: string): boolean {
  // Durable authority requires exact persisted executable identity. Fresh
  // authority may use the basename fallback for lossy provider display data.
  return expected === observed;
}

function authorizeIdentity(target: KillTarget, deps: GateDeps): GateDecision {
  if (target.source === 'durable' && process.platform === 'darwin') {
    return {
      outcome: 'rejected',
      kind: 'durable-macos-refused',
      reason: 'durable ownership records never authorize unattended macOS process-group signals'
    };
  }

  if (target.source === 'durable' && process.platform !== 'linux') {
    return {
      outcome: 'rejected',
      kind: 'unsupported-platform',
      reason: `durable process-group cleanup is unsupported on ${process.platform}`
    };
  }

  const observed = (deps.resolveIdentity ?? resolveProcessIdentity)(target.leaderPid);
  if (observed.status === 'gone') {
    return {
      outcome: 'rejected',
      kind: 'leader-gone',
      reason: `leader ${target.leaderPid} is gone; group ownership is unverifiable`
    };
  }
  if (observed.status === 'ambiguous') {
    return {
      outcome: 'rejected',
      kind: 'ambiguous-identity',
      reason: observed.reason
    };
  }

  if (observed.pgid !== target.pgid) {
    return {
      outcome: 'rejected',
      kind: 'identity-drift',
      reason: `pgid drift: observed ${observed.pgid}, recorded ${target.pgid}`
    };
  }
  if (target.sessionId === undefined || observed.sessionId !== target.sessionId) {
    return {
      outcome: 'rejected',
      kind: 'identity-drift',
      reason: `session drift: observed ${observed.sessionId}, recorded ${target.sessionId ?? 'missing'}`
    };
  }
  if (Math.abs(observed.startEvidence.value - target.leaderStartMs) > START_TOLERANCE_MS) {
    return {
      outcome: 'rejected',
      kind: 'identity-drift',
      reason: `leader start evidence differs by more than ${START_TOLERANCE_MS}ms`
    };
  }
  const executableMatches = target.source === 'durable'
    ? Boolean(target.executablePath && durableExecutableMatches(target.executablePath, observed.executablePath))
    : Boolean(target.executablePath && sameExecutable(target.executablePath, observed.executablePath));
  if (!executableMatches) {
    return {
      outcome: 'rejected',
      kind: 'identity-drift',
      reason: `executable path mismatch: observed ${observed.executablePath}, recorded ${target.executablePath ?? 'missing'}`
    };
  }
  if (
    target.argvFingerprint === undefined ||
    observed.argvFingerprint === undefined ||
    target.argvFingerprint !== observed.argvFingerprint
  ) {
    if (target.source === 'durable') {
      return {
        outcome: 'rejected',
        kind: 'durable-evidence-insufficient',
        reason: 'durable cleanup requires an exact argv fingerprint'
      };
    }
    // Fresh macOS identity may omit argv fingerprint, but if one side has it
    // the available evidence must match exactly.
    if (target.argvFingerprint !== undefined || observed.argvFingerprint !== undefined) {
      return {
        outcome: 'rejected',
        kind: 'identity-drift',
        reason: 'argv fingerprint mismatch or unavailable'
      };
    }
  }
  if (target.source === 'durable' && !observed.collisionResistant) {
    return {
      outcome: 'rejected',
      kind: 'durable-evidence-insufficient',
      reason: 'durable cleanup requires collision-resistant process incarnation evidence'
    };
  }

  return { outcome: 'authorized', source: target.source, identity: observed };
}

/**
 * Gate a group signal. Signal 0 is an observation used for a separate
 * group-absence check; terminating signals always require identity authority.
 */
export function killProcessGroupGated(
  target: KillTarget,
  signal: NodeJS.Signals | 0,
  deps: GateDeps = {}
): KillGateResult {
  const forbidden = deps.forbiddenPgids ? deps.forbiddenPgids() : resolveForbiddenPgids();
  const structural = structuralReason(target, forbidden);
  if (structural) {
    return rejected(target, signal, forbidden ? 'structural' : 'self-unresolvable', structural);
  }

  const decision = signal === 0
    ? ({
        outcome: 'authorized',
        source: target.source,
        identity: {
          status: 'verified',
          pid: target.leaderPid,
          pgid: target.pgid,
          sessionId: target.sessionId ?? target.pgid,
          executablePath: target.executablePath ?? '',
          startEvidence: { value: target.leaderStartMs, resolution: 'tick' },
          collisionResistant: false
        }
      } satisfies Extract<GateDecision, { outcome: 'authorized' }>)
    : authorizeIdentity(target, deps);

  if (decision.outcome !== 'authorized') {
    return rejected(target, signal, decision.kind, decision.reason);
  }
  return authorized(target, signal, decision);
}

export function killGateResultIsRetired(result: KillGateResult): boolean {
  return result.outcome === 'sent' || result.outcome === 'already-gone';
}
