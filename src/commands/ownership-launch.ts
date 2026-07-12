import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
  ControlSchema,
  ActiveSchema,
  getBaseStateDir,
  getProjectDir,
  getRunDir,
  verifyFilePermissions,
  writeJsonAtomic,
  acquireProjectLock,
  getProcessCommand,
  getProcessStartTime,
  type OwnershipContext,
  type ControlRecord,
  type ActiveRecord
} from '../run-ownership.js';
import { checkCgroupV2Capability } from '../adapters/process-group.js';

export interface OwnershipLaunchInput {
  runId?: string;
  token?: string;
  stateDir?: string;
}

export function parseLaunchInput(): OwnershipLaunchInput {
  return {
    runId: process.env['ORC_RUN_ID'],
    token: process.env['ORC_RUN_TOKEN'],
    stateDir: process.env['ORC_RUN_STATE_DIR']
  };
}

export async function openOwnedRun(
  input: OwnershipLaunchInput,
  projectRoot: string
): Promise<OwnershipContext | null> {
  const hasId = !!input.runId;
  const hasToken = !!input.token;

  if (!hasId && !hasToken) {
    return null; // Ordinary terminal mode (mutually exclusive)
  }

  if (hasId !== hasToken) {
    throw new Error('Ambiguous mode: both ORC_RUN_ID and ORC_RUN_TOKEN must be provided for app-owned mode');
  }

  // App-owned mode is active. Verify cgroup-v2 capability first.
  const cgroupCap = checkCgroupV2Capability();
  if (!cgroupCap.supported) {
    throw new Error(`App-owned mode rejected: cgroup-v2 capability check failed. Detail: ${cgroupCap.reason}`);
  }

  const runId = input.runId!;
  const token = input.token!;
  const stateDir = input.stateDir ?? getBaseStateDir();
  const runDir = getRunDir(runId);
  const controlFile = path.join(runDir, 'control.json');

  if (!fs.existsSync(controlFile)) {
    throw new Error(`Control record control.json not found for run ${runId} in ${runDir}`);
  }

  verifyFilePermissions(controlFile);
  const controlContent = fs.readFileSync(controlFile, 'utf-8');
  let control: ControlRecord;
  try {
    control = ControlSchema.parse(JSON.parse(controlContent));
  } catch (err: any) {
    throw new Error(`Malformed or invalid control.json for run ${runId}: ${err.message}`);
  }

  // Validate owner token
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  if (tokenHash !== control.ownerTokenHash) {
    throw new Error(`Owner token mismatch for run ${runId}`);
  }

  // Validate project root matching
  const canonicalRoot = fs.realpathSync(projectRoot);
  const canonicalControlRoot = fs.realpathSync(control.projectRoot);
  if (canonicalRoot !== canonicalControlRoot) {
    throw new Error(`Project root mismatch: loop is running in ${canonicalRoot} but run was launched for ${canonicalControlRoot}`);
  }

  // Acquire project lock (admission lock)
  const projectDir = getProjectDir(projectRoot);
  const startTime = getProcessStartTime(process.pid);
  const lockRecord = {
    runId,
    pid: process.pid,
    startMs: startTime,
    runDir,
    command: getProcessCommand(process.pid)
  };

  await acquireProjectLock(projectDir, lockRecord);

  // Initialize/Write active.json if it doesn't exist
  const activeFile = path.join(runDir, 'active.json');
  let activeRecord: ActiveRecord;
  if (fs.existsSync(activeFile)) {
    verifyFilePermissions(activeFile);
    activeRecord = ActiveSchema.parse(JSON.parse(fs.readFileSync(activeFile, 'utf-8')));
    // Check if CLI identity changed
    if (activeRecord.cliIdentity.pid !== process.pid || Math.abs(activeRecord.cliIdentity.startMs - startTime) > 2000) {
      throw new Error(`CLI identity drift or duplicate active.json writer detected for run ${runId}`);
    }
  } else {
    activeRecord = {
      cliIdentity: {
        pid: process.pid,
        startMs: startTime,
        command: getProcessCommand(process.pid)
      },
      groups: [],
      state: 'starting',
      cliRevision: 1
    };
    writeJsonAtomic(activeFile, activeRecord);
  }

  // Scrub environment for child processes
  const env = { ...process.env } as Record<string, string>;
  delete env['ORC_RUN_TOKEN'];
  delete env['ORC_RUN_ID'];
  delete env['ORC_RUN_STATE_DIR'];

  return {
    token,
    runId,
    stateDir,
    projectDir,
    runDir,
    control,
    env
  };
}
