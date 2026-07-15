import type { ChildProcess } from 'node:child_process';
import type { ProcessGroupHandle, TerminationResult } from './adapters/process-group.js';

/**
 * A fresh capability exists only in the CLI that created the process group.
 * Durable JSON records intentionally cannot reconstruct one. The registry is
 * the single in-process owner of these capabilities for interrupt and lease
 * cleanup.
 */

export interface OwnedRuntimeCapability {
  readonly epoch: symbol;
  readonly runId: string;
  readonly runDir: string;
  readonly bootstrap: ChildProcess;
  readonly handle: ProcessGroupHandle;
  readonly terminate: (graceMs: number) => Promise<TerminationResult>;
  /** Return true only after group absence and active-record retirement were checked. */
  readonly retireIfClosed: () => Promise<boolean>;
}

export interface OwnedRuntimeTermination {
  capability: OwnedRuntimeCapability;
  result: TerminationResult;
  retired: boolean;
}

const capabilities = new Map<symbol, OwnedRuntimeCapability>();

export function registerOwnedRuntime(capability: OwnedRuntimeCapability): void {
  capabilities.set(capability.epoch, capability);
}

export function unregisterOwnedRuntime(capability: OwnedRuntimeCapability): void {
  if (capabilities.get(capability.epoch) === capability) {
    capabilities.delete(capability.epoch);
  }
}

export function listOwnedRuntimes(): OwnedRuntimeCapability[] {
  return [...capabilities.values()];
}

export function resetOwnedRuntimeRegistryForTests(): void {
  capabilities.clear();
}

/**
 * Terminate exactly the capabilities currently registered. The returned list
 * is one-for-one with that snapshot; no handle is rebuilt from active.json.
 */
export async function terminateOwnedRuntimes(
  graceMs = 2000,
  filter?: (capability: OwnedRuntimeCapability) => boolean
): Promise<OwnedRuntimeTermination[]> {
  const snapshot = listOwnedRuntimes().filter((capability) => filter ? filter(capability) : true);
  const results: OwnedRuntimeTermination[] = [];
  for (const capability of snapshot) {
    let result: TerminationResult;
    try {
      result = await capability.terminate(graceMs);
    } catch (error: any) {
      result = {
        outcome: 'rejected',
        sent: false,
        signal: 'SIGTERM',
        target: {
          pgid: capability.handle.pgid,
          leaderPid: capability.handle.leaderPid,
          source: 'fresh'
        },
        reason: error?.message ?? String(error),
        decision: {
          outcome: 'rejected',
          kind: 'identity-drift',
          reason: error?.message ?? String(error)
        }
      };
    }

    let retired = false;
    if (result.outcome === 'sent' || result.outcome === 'already-gone') {
      try {
        retired = await capability.retireIfClosed();
      } catch {
        retired = false;
      }
    }
    if (retired) unregisterOwnedRuntime(capability);
    results.push({ capability, result, retired });
  }
  return results;
}
