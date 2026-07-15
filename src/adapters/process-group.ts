import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fork, type ChildProcess } from 'node:child_process';
import type { RawProcessResult } from './utils.js';
import type { SpawnRequest } from './types.js';
import { registerGroup, confirmGroupClosed } from '../run-ownership.js';
import {
  resolveProcessIdentity,
  resolveExecutablePath,
  START_TOLERANCE_MS,
  type VerifiedIdentity
} from '../process-identity.js';
import {
  killProcessGroupGated,
  resolveForbiddenPgids,
  type KillGateResult,
  type KillTarget
} from '../kill-gate.js';
import {
  registerOwnedRuntime,
  unregisterOwnedRuntime,
  type OwnedRuntimeCapability
} from '../owned-runtime-registry.js';

export interface ProcessGroupHandle {
  pgid: number;
  leaderPid: number;
  sessionId: number;
  leaderStartMs: number;
  /** The bootstrap leader's executable, used by the kill gate. */
  bootstrapExecutablePath: string;
  /** The requested provider executable, retained for diagnostics/start checks. */
  executablePath: string;
  argvFingerprint?: string;
}

export interface SpawnRuntime {
  spawn(req: SpawnRequest): {
    result: Promise<RawProcessResult>;
    handle?: ProcessGroupHandle;
    ready?: Promise<void>;
  };
}

export function resolveBootstrapPath(): string {
  return fileURLToPath(new URL('./process-group-bootstrap.mjs', import.meta.url));
}

/** Compatibility export for older callers; it now resolves the Node bootstrap. */
export function resolveWrapperPath(): string {
  return resolveBootstrapPath();
}

export type TerminationResult =
  | Extract<KillGateResult, { outcome: 'sent' }>
  | Extract<KillGateResult, { outcome: 'already-gone' }>
  | Extract<KillGateResult, { outcome: 'rejected' }>;

function handleToTarget(handle: ProcessGroupHandle, source: 'durable' | 'fresh'): KillTarget {
  return {
    pgid: handle.pgid,
    leaderPid: handle.leaderPid,
    leaderStartMs: handle.leaderStartMs,
    sessionId: handle.sessionId,
    executablePath: handle.bootstrapExecutablePath,
    argvFingerprint: handle.argvFingerprint,
    source
  };
}

function sameExecutable(expected: string, observed: string): boolean {
  return expected === observed || path.basename(expected) === path.basename(observed);
}

function isFreshHandleIdentity(handle: ProcessGroupHandle, identity: VerifiedIdentity): boolean {
  const forbidden = resolveForbiddenPgids();
  if (!forbidden) return false;
  return (
    identity.pid === handle.leaderPid &&
    identity.pgid === handle.pgid &&
    identity.sessionId === handle.sessionId &&
    !forbidden.has(identity.pgid) &&
    Math.abs(identity.startEvidence.value - handle.leaderStartMs) <= START_TOLERANCE_MS &&
    sameExecutable(handle.bootstrapExecutablePath, identity.executablePath)
  );
}

/** Signal 0 remains inside the kill gate and is only used to prove absence. */
export async function isProcessGroupAbsent(
  handle: ProcessGroupHandle,
  source: 'durable' | 'fresh' = 'fresh'
): Promise<boolean> {
  const result = killProcessGroupGated(handleToTarget(handle, source), 0);
  return result.outcome === 'already-gone';
}

async function waitForGroupAbsent(handle: ProcessGroupHandle, timeoutMs: number, source: 'durable' | 'fresh'): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isProcessGroupAbsent(handle, source)) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return isProcessGroupAbsent(handle, source);
}

/**
 * Fresh/durable group termination. A record is retired only after this caller
 * separately verifies group absence; a merely attempted signal is not success.
 */
export async function terminateProcessGroup(
  handle: ProcessGroupHandle,
  graceMs = 2000,
  source: 'durable' | 'fresh' = 'fresh'
): Promise<TerminationResult> {
  // Durable macOS cleanup must not even perform a negative-PID existence probe;
  // the durable authority decision is made before any group signal.
  if (source === 'fresh' && await isProcessGroupAbsent(handle, source)) {
    return {
      outcome: 'already-gone',
      sent: false,
      signal: 'SIGTERM',
      target: { pgid: handle.pgid, leaderPid: handle.leaderPid, source },
      reason: 'process group is already absent'
    };
  }

  // On Linux, signal 0 can prove that a durable group is already absent even
  // when its leader has gone. macOS deliberately skips this observation: no
  // unattended durable group probe is allowed there.
  if (source === 'durable' && process.platform === 'linux' && await isProcessGroupAbsent(handle, source)) {
    return {
      outcome: 'already-gone',
      sent: false,
      signal: 'SIGTERM',
      target: { pgid: handle.pgid, leaderPid: handle.leaderPid, source },
      reason: 'process group is already absent'
    };
  }

  const term = killProcessGroupGated(handleToTarget(handle, source), 'SIGTERM');
  if (term.outcome !== 'sent') return term;
  if (await waitForGroupAbsent(handle, graceMs, source)) return term;

  const kill = killProcessGroupGated(handleToTarget(handle, source), 'SIGKILL');
  if (kill.outcome === 'rejected' && await isProcessGroupAbsent(handle, source)) {
    return {
      outcome: 'already-gone',
      sent: false,
      signal: 'SIGKILL',
      target: { pgid: handle.pgid, leaderPid: handle.leaderPid, source },
      reason: 'process group disappeared during termination'
    };
  }
  return kill;
}

function expectedArgvFingerprint(command: string, args: string[]): string | undefined {
  return process.platform === 'darwin' ? undefined : [command, ...args].join('\0');
}

async function pollIdentity(
  pid: number,
  predicate: (identity: VerifiedIdentity) => boolean,
  timeoutMs: number,
  label: string
): Promise<VerifiedIdentity> {
  const deadline = Date.now() + timeoutMs;
  let lastReason = 'identity not yet available';
  while (Date.now() < deadline) {
    const identity = resolveProcessIdentity(pid);
    if (identity.status === 'verified') {
      if (predicate(identity)) return identity;
      lastReason = 'identity fields did not match the expected process group';
    } else if (identity.status === 'gone') {
      throw new Error(`OWNERSHIP_SPAWN_IDENTITY: ${label} exited during identity transition`);
    } else {
      lastReason = identity.reason;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`OWNERSHIP_SPAWN_IDENTITY: ${label} identity timeout: ${lastReason}`);
}

interface InternalGroup extends ReturnType<typeof ProcessGroupRuntime.createGroup> {
  cleanup: Promise<void>;
}

export class ProcessGroupRuntime {
  static createGroup(
    runId: string,
    runDir: string,
    command: string,
    providerArgs: string[],
    ownedEnv: Record<string, string>,
    cwd = process.cwd()
  ): {
    child: ChildProcess;
    handle: ProcessGroupHandle;
    ready: Promise<void>;
    cleanup: Promise<void>;
  } {
    const bootstrapPath = resolveBootstrapPath();
    const providerPath = resolveExecutablePath(command, ownedEnv, cwd);
    const providerArgv = expectedArgvFingerprint(command, providerArgs);
    const spec = {
      command,
      args: providerArgs,
      cwd,
      env: ownedEnv,
      expectedProviderExecutablePath: providerPath,
      expectedProviderArgvFingerprint: providerArgv
    };

    const child = fork(bootstrapPath, [JSON.stringify(spec)], {
      execPath: process.execPath,
      execArgv: [],
      detached: true,
      cwd,
      env: ownedEnv,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    const handle: ProcessGroupHandle = {
      pgid: child.pid ?? -1,
      leaderPid: child.pid ?? -1,
      sessionId: child.pid ?? -1,
      leaderStartMs: 0,
      bootstrapExecutablePath: process.execPath,
      executablePath: providerPath,
      argvFingerprint: undefined
    };

    let capability: OwnedRuntimeCapability | null = null;
    let cleanupStarted = false;
    let cleanupResolve!: () => void;
    let cleanupReject!: (error: unknown) => void;
    const cleanup = new Promise<void>((resolve, reject) => {
      cleanupResolve = resolve;
      cleanupReject = reject;
    });

    // Registry-driven ownership loss and the bootstrap close event can reach
    // cleanup concurrently. Keep both operations idempotent on the one fresh
    // capability so teardown never re-resolves a disappearing zombie as a new
    // identity and never races two active-record retirements.
    let terminationPromise: Promise<TerminationResult> | null = null;
    const terminateFresh = (graceMs: number): Promise<TerminationResult> => {
      if (!terminationPromise) {
        terminationPromise = terminateProcessGroup(handle, graceMs, 'fresh');
      }
      return terminationPromise;
    };

    let retirementPromise: Promise<boolean> | null = null;
    const retireIfClosed = (): Promise<boolean> => {
      if (!retirementPromise) {
        retirementPromise = (async () => {
          // SIGKILL is asynchronous and the bootstrap may remain a zombie
          // until the parent observes its close event. Allow that bounded
          // transition to settle before treating a fresh capability as
          // unretirable.
          if (!(await waitForGroupAbsent(handle, 1000, 'fresh'))) return false;
          try {
            await confirmGroupClosed(runDir, {
              pgid: handle.pgid,
              leaderPid: handle.leaderPid,
              sessionId: handle.sessionId,
              leaderStartMs: handle.leaderStartMs,
              command,
              bootstrapExecutablePath: handle.bootstrapExecutablePath,
              executablePath: handle.executablePath,
              argvFingerprint: handle.argvFingerprint
            });
          } catch (error) {
            return false;
          }
          return true;
        })();
      }
      return retirementPromise;
    };

    const cleanupGroup = async () => {
      if (cleanupStarted) return cleanup;
      cleanupStarted = true;
      try {
        if (capability) {
          const termination = await capability.terminate(2000);
          if (termination.outcome === 'rejected') throw new Error(termination.reason);
          const retired = await capability.retireIfClosed();
          if (!retired) throw new Error(`ownership-failure: group ${handle.pgid} did not retire after provider exit`);
          unregisterOwnedRuntime(capability);
        }
        try {
          if (child.connected) child.send({ protocolVersion: 1, type: 'retire' });
        } catch { /* group is already closed */ }
        cleanupResolve();
      } catch (error) {
        cleanupReject(error);
      }
      return cleanup;
    };

    let readySettled = false;
    let providerStarted = false;
    let readyResolve!: () => void;
    let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const readyTimeout = setTimeout(() => {
      if (!readySettled) failReady(new Error('OWNERSHIP_SPAWN_IDENTITY: bootstrap protocol timeout'));
    }, 7000);
    readyTimeout.unref();

    const failReady = (error: Error) => {
      if (readySettled) return;
      readySettled = true;
      clearTimeout(readyTimeout);
      readyReject(error);
      void (async () => {
        try {
          if (capability) {
            const termination = await capability.terminate(500);
            if (termination.outcome !== 'rejected' && await capability.retireIfClosed()) {
              unregisterOwnedRuntime(capability);
            }
          }
          else if (child.pid) {
            try {
              // Before ACK the bootstrap has not spawned a provider. Closing
              // IPC is the bounded, no-provider cleanup path; it also prevents
              // a malformed/mismatched readiness frame from leaving a waiter.
              if (child.connected) child.disconnect();
            } catch { /* child may already be exiting */ }
            const identity = resolveProcessIdentity(child.pid);
            if (identity.status === 'verified') {
              handle.pgid = identity.pgid;
              handle.sessionId = identity.sessionId;
              handle.leaderStartMs = identity.startEvidence.value;
              await terminateProcessGroup(handle, 500, 'fresh');
            }
          }
        } catch { /* ready failure is the primary error */ }
        finally {
          if (!cleanupStarted) {
            cleanupStarted = true;
            cleanupReject(error);
          }
        }
      })();
    };

    const onMessage = (frame: any) => {
      if (!frame || frame.protocolVersion !== 1 || typeof frame.type !== 'string') {
        failReady(new Error('Malformed bootstrap control frame'));
        return;
      }
      if (frame.type === 'failure') {
        failReady(new Error(`${frame.stage ?? 'bootstrap'}: ${frame.message ?? 'unknown bootstrap failure'}`));
        return;
      }
      if (frame.type === 'ready') {
        try {
          if (
            frame.bootstrapPid !== child.pid ||
            frame.pgid !== child.pid ||
            frame.sessionId !== child.pid ||
            typeof frame.leaderStartEvidence?.value !== 'number' ||
            frame.expectedProviderExecutablePath !== providerPath
          ) {
            throw new Error(
              `OWNERSHIP_SPAWN_IDENTITY: readiness identity mismatch ` +
              `(expected pid=${child.pid}, provider=${providerPath}; ` +
              `received pid=${frame.bootstrapPid}, pgid=${frame.pgid}, session=${frame.sessionId}, ` +
              `provider=${frame.expectedProviderExecutablePath})`
            );
          }
          handle.pgid = frame.pgid;
          handle.sessionId = frame.sessionId;
          handle.leaderStartMs = frame.leaderStartEvidence.value;
          const bootstrapIdentityPromise = pollIdentity(
            child.pid!,
            (identity) => isFreshHandleIdentity(handle, identity),
            5000,
            'bootstrap'
          );
          void bootstrapIdentityPromise.then((identity) => {
            handle.argvFingerprint = identity.argvFingerprint;
            registerGroup(runDir, {
              pgid: handle.pgid,
              leaderPid: handle.leaderPid,
              sessionId: handle.sessionId,
              leaderStartMs: handle.leaderStartMs,
              command,
              bootstrapExecutablePath: handle.bootstrapExecutablePath,
              executablePath: handle.executablePath,
              argvFingerprint: handle.argvFingerprint
            });
            capability = {
              epoch: Symbol(`owned-runtime:${runId}:${handle.pgid}`),
              runId,
              runDir,
              bootstrap: child,
              handle,
              terminate: terminateFresh,
              retireIfClosed
            };
            registerOwnedRuntime(capability);
            child.send({ protocolVersion: 1, type: 'ack' }, (error) => {
              if (error) failReady(new Error(`bootstrap ACK failed: ${error.message}`));
            });
          }).catch((error) => failReady(error instanceof Error ? error : new Error(String(error))));
        } catch (error) {
          failReady(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (frame.type === 'provider-started') {
        if (!capability) {
          failReady(new Error('OWNERSHIP_SPAWN_IDENTITY: provider started before capability registration'));
          return;
        }
        const providerPid = frame.providerPid;
        if (!Number.isInteger(providerPid) || providerPid <= 0) {
          failReady(new Error('Malformed provider-started frame'));
          return;
        }
        void pollIdentity(
          providerPid,
          (identity) =>
            identity.pgid === handle.pgid &&
            identity.sessionId === handle.sessionId &&
            sameExecutable(handle.executablePath, identity.executablePath) &&
            (providerArgv === undefined || identity.argvFingerprint === providerArgv),
          5000,
          'provider'
        ).then(() => {
          providerStarted = true;
          if (!readySettled) {
            readySettled = true;
            clearTimeout(readyTimeout);
            readyResolve();
          }
        }).catch((error) => failReady(error instanceof Error ? error : new Error(String(error))));
        return;
      }
      if (frame.type === 'provider-exited') {
        void cleanupGroup();
      }
    };

    child.on('message', onMessage);
    child.on('error', (error) => failReady(error));
    child.on('close', (code, signal) => {
      if (!readySettled && !providerStarted) {
        failReady(new Error(`bootstrap exited before readiness/provider start (code ${code}, signal ${signal})`));
      }
      if (!cleanupStarted && providerStarted) void cleanupGroup();
      if (!cleanupStarted && !providerStarted) {
        cleanupStarted = true;
        cleanupResolve();
      }
    });

    return { child, handle, ready, cleanup };
  }
}

export class OwnedSpawnRuntime implements SpawnRuntime {
  constructor(private readonly runId: string, private readonly runDir: string) {}

  spawn(req: SpawnRequest): {
    result: Promise<RawProcessResult>;
    handle?: ProcessGroupHandle;
    ready?: Promise<void>;
  } {
    const startedAt = Date.now();
    let resolveResult!: (result: RawProcessResult) => void;
    const result = new Promise<RawProcessResult>((resolve) => { resolveResult = resolve; });
    const group = ProcessGroupRuntime.createGroup(
      this.runId,
      this.runDir,
      req.command,
      req.args ?? [],
      req.env ?? {},
      req.cwd ?? process.cwd()
    ) as InternalGroup;
    let stdout = '';
    let stderr = '';
    let settled = false;
    let providerExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    group.child.stdout?.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stdout += chunk;
      req.onStdoutChunk?.(chunk);
    });
    group.child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    const finishResult = async (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      let ownershipFailure: { message: string } | undefined;
      try {
        await group.cleanup;
      } catch (error: any) {
        ownershipFailure = { message: error?.message ?? String(error) };
      }
      resolveResult({
        stdout,
        stderr,
        // The parent deliberately SIGKILLs the idle bootstrap after a normal
        // provider exit to close the owned group. Preserve the provider's
        // protocol-reported outcome instead of exposing that control signal as
        // the agent's result.
        exitCode: providerExit?.code ?? code ?? (providerExit?.signal || signal ? -1 : 0),
        timedOut: false,
        signal: providerExit ? providerExit.signal : signal,
        durationMs: Date.now() - startedAt,
        ownershipFailure
      });
    };
    group.child.on('message', (frame: any) => {
      if (frame?.protocolVersion === 1 && frame.type === 'provider-exited') {
        providerExit = {
          code: typeof frame.code === 'number' ? frame.code : null,
          signal: frame.signal ?? null
        };
      }
    });
    let closeSeen = false;
    group.child.on('exit', (code, signal) => {
      // In restricted sandboxes `close` can be delayed when an inherited
      // stdio stream remains open. Give close the normal path, but settle an
      // early-exit result if it never arrives.
      setTimeout(() => {
        if (!closeSeen) void finishResult(code, signal);
      }, 100).unref();
    });
    group.child.on('close', (code, signal) => {
      closeSeen = true;
      void finishResult(code, signal);
    });
    group.child.on('error', (error) => {
      if (settled) return;
      settled = true;
      resolveResult({
        stdout,
        stderr,
        exitCode: -1,
        timedOut: false,
        signal: null,
        durationMs: Date.now() - startedAt,
        spawnErrorMessage: error.message
      });
    });
    return { result, handle: group.handle, ready: group.ready };
  }
}
