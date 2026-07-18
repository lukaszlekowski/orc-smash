import { confirm } from '@inquirer/prompts';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CliOutput } from '../cli-output.js';
import type { CommandResult } from './types.js';
import {
  getProjectDir,
  getBaseStateDir,
  readActive,
  readLock,
  readProjectIndex,
  releaseProjectLock,
  writeActive,
  type ActiveRecord,
  type LockRecord,
  type ProjectRecord
} from '../run-ownership.js';
import { resolveProcessIdentity, type ProcessIdentityResult } from '../process-identity.js';

export interface OwnershipRecoveryOptions {
  project: string;
  output: CliOutput;
  yes?: boolean;
  /** Test seam for the interactive confirmation. */
  confirmFn?: (message: string) => Promise<boolean>;
  stateDir?: string;
}

interface RecoverySnapshot {
  projectRoot: string;
  projectDir: string;
  lock: LockRecord;
  project: ProjectRecord | null;
  active: ActiveRecord | null;
}

function describeIdentity(identity: ProcessIdentityResult): string {
  if (identity.status === 'gone') return 'gone';
  if (identity.status === 'ambiguous') return `ambiguous (${identity.reason})`;
  return `verified pid=${identity.pid} pgid=${identity.pgid} session=${identity.sessionId} start=${identity.startEvidence.value} executable=${identity.executablePath}`;
}

function loadSnapshot(options: OwnershipRecoveryOptions): RecoverySnapshot {
  const projectRoot = fs.realpathSync(path.resolve(options.project));
  const projectDir = getProjectDir(projectRoot, options.stateDir ?? getBaseStateDir());
  const lock = readLock(projectDir);
  const projectPath = path.join(projectDir, 'project.json');
  const project = fs.existsSync(projectPath) ? readProjectIndex(projectDir) : null;
  const active = fs.existsSync(lock.runDir) && fs.existsSync(path.join(lock.runDir, 'active.json'))
    ? readActive(lock.runDir)
    : null;
  return { projectRoot, projectDir, lock, project, active };
}

function inspectionCommand(pid: number): string {
  return `ps -p ${pid} -o pid=,ppid=,pgid=,sess=,lstart=,command=`;
}

export async function ownershipStatusAction(options: OwnershipRecoveryOptions): Promise<CommandResult> {
  try {
    const snapshot = loadSnapshot(options);
    options.output.note(`Canonical project: ${snapshot.projectRoot}`);
    options.output.note(`Ownership state: ${snapshot.projectDir}`);
    options.output.note(`Recorded lock: runId=${snapshot.lock.runId} pid=${snapshot.lock.pid} start=${snapshot.lock.startMs} command=${snapshot.lock.command}`);
    options.output.note(`Observed lock holder: ${describeIdentity(resolveProcessIdentity(snapshot.lock.pid))}`);
    if (snapshot.project) options.output.note(`Project pointer: runId=${snapshot.project.currentRunId} state=${snapshot.project.state}`);
    if (!snapshot.active) {
      options.output.note('Active record: missing');
    } else {
      options.output.note(`Active lifecycle: ${snapshot.active.state}${snapshot.active.reason ? ` (${snapshot.active.reason})` : ''}`);
      for (const group of snapshot.active.groups) {
        options.output.note(
          `Recorded group: pid=${group.leaderPid} pgid=${group.pgid} session=${group.sessionId} start=${group.leaderStartMs} executable=${group.executablePath ?? group.command}`
        );
        options.output.note(`Observed group leader: ${describeIdentity(resolveProcessIdentity(group.leaderPid))}`);
      }
    }
    options.output.note(`Inspect without signalling: ${inspectionCommand(snapshot.lock.pid)}`);
    for (const group of snapshot.active?.groups ?? []) options.output.note(`Inspect group leader: ${inspectionCommand(group.leaderPid)}`);
    return { exitCode: 0 };
  } catch (error: any) {
    const message = `Ownership status failed: ${error?.message ?? String(error)}`;
    options.output.error(message);
    return { exitCode: 1, message };
  }
}

function positivelyLive(identity: ProcessIdentityResult): boolean {
  return identity.status === 'verified';
}

export async function ownershipReleaseAction(options: OwnershipRecoveryOptions): Promise<CommandResult> {
  let snapshot: RecoverySnapshot;
  try {
    snapshot = loadSnapshot(options);
  } catch (error: any) {
    const message = `Ownership release failed: ${error?.message ?? String(error)}`;
    options.output.error(message);
    return { exitCode: 1, message };
  }

  const holder = resolveProcessIdentity(snapshot.lock.pid);
  if (holder.status !== 'gone') {
    const message = `Refusing release: recorded CLI holder is not proven dead (${describeIdentity(holder)}).`;
    options.output.error(message);
    return { exitCode: 1, message };
  }
  for (const group of snapshot.active?.groups ?? []) {
    const observed = resolveProcessIdentity(group.leaderPid);
    if (positivelyLive(observed)) {
      const message = `Refusing release: recorded group leader ${group.leaderPid} is live (${describeIdentity(observed)}).`;
      options.output.error(message);
      return { exitCode: 1, message };
    }
    if (observed.status === 'ambiguous') {
      const message = `Refusing release: group leader ${group.leaderPid} is ambiguous; inspect it before asserting no owned processes remain.`;
      options.output.error(message);
      return { exitCode: 1, message };
    }
  }

  if (!options.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      const message = 'Refusing release: non-interactive use requires --yes.';
      options.output.error(message);
      return { exitCode: 1, message };
    }
    const message = `I have verified that no owned processes remain for ${snapshot.projectRoot}. Release retained admission?`;
    const accepted = await (options.confirmFn ? options.confirmFn(message) : confirm({ message, default: false }));
    if (!accepted) {
      const result = 'Ownership release cancelled; admission retained.';
      options.output.note(result);
      return { exitCode: 1, message: result };
    }
  }

  try {
    if (!snapshot.active) throw new Error('active.json is missing; retained evidence cannot be marked safely');
    const marked: ActiveRecord = {
      ...snapshot.active,
      state: 'failed',
      reason: 'operator-released',
      recoveryAtMs: Date.now(),
      cliRevision: snapshot.active.cliRevision + 1
    };
    writeActive(snapshot.lock.runDir, marked);
    // The mark is durable before admission removal. A crash between this call
    // and pointer removal leaves a failed record that can be released again.
    releaseProjectLock(snapshot.projectDir, snapshot.lock.runId);
    const result = `Ownership admission released for ${snapshot.projectRoot}.`;
    options.output.note(result);
    return { exitCode: 0, message: result };
  } catch (error: any) {
    const message = `Ownership release failed after safety checks: ${error?.message ?? String(error)}; admission was retained where possible.`;
    options.output.error(message);
    return { exitCode: 1, message };
  }
}
