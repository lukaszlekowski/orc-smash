import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ActiveSchema,
  ControlSchema,
  CURRENT_SCHEMA_VERSION,
  acquireProjectLock,
  getBaseStateDir,
  getProjectDir,
  getRunDir,
  readActive,
  readControl,
  tokenMatches,
  verifyDirectoryPermissions,
  writeActive,
  type ActiveRecord,
  type ControlRecord,
  type OwnershipContext
} from '../run-ownership.js';
import { createLeaseClock } from '../lease-clock.js';
import { getProcessCommand, getProcessStartTime } from '../process-identity.js';

export interface OwnershipLaunchInput {
  runId?: string;
  token?: string;
  stateDir?: string;
  /** Optional test/launcher-provided environment snapshot. */
  env?: NodeJS.ProcessEnv;
}

/** Names from the superseded cgroup launcher contract. */
export const OBSOLETE_OWNERSHIP_SELECTORS = [
  'ORC_CGROUP_PATH',
  'ORC_RUN_CGROUP',
  'ORC_RUN_CGROUP_PATH',
  'ORC_RUN_CGROUP_INO',
  'ORC_RUN_CGROUP_DEV'
] as const;

const OWNERSHIP_ENV_KEYS = [
  'ORC_RUN_ID',
  'ORC_RUN_TOKEN',
  'ORC_RUN_STATE_DIR',
  ...OBSOLETE_OWNERSHIP_SELECTORS
] as const;

export function parseLaunchInput(env: NodeJS.ProcessEnv = process.env): OwnershipLaunchInput {
  return {
    runId: env['ORC_RUN_ID'],
    token: env['ORC_RUN_TOKEN'],
    stateDir: env['ORC_RUN_STATE_DIR'],
    env
  };
}

function validateSelectorValue(name: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value.length === 0 || value.includes('\0')) throw new Error(`Invalid ${name} value`);
}

function validateLaunchMode(input: OwnershipLaunchInput, env: NodeJS.ProcessEnv): 'terminal' | 'owned' {
  const hasId = input.runId !== undefined;
  const hasToken = input.token !== undefined;
  const obsolete = OBSOLETE_OWNERSHIP_SELECTORS.filter((key) => env[key] !== undefined);
  if (obsolete.length > 0) {
    throw new Error(`Invalid ownership mode: obsolete selector present (${obsolete.join(', ')})`);
  }
  if (!hasId && !hasToken) return 'terminal';
  if (hasId !== hasToken) {
    throw new Error('Ambiguous mode: ORC_RUN_ID and ORC_RUN_TOKEN must be provided together');
  }
  validateSelectorValue('ORC_RUN_ID', input.runId);
  validateSelectorValue('ORC_RUN_TOKEN', input.token);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.runId!)) {
    throw new Error('Invalid ORC_RUN_ID value');
  }
  if (input.stateDir !== undefined) validateSelectorValue('ORC_RUN_STATE_DIR', input.stateDir);
  return 'owned';
}

function scrubOwnershipEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) env[key] = value;
  }
  for (const key of OWNERSHIP_ENV_KEYS) delete env[key];
  return env;
}

export async function openOwnedRun(
  input: OwnershipLaunchInput,
  projectRoot: string
): Promise<OwnershipContext | null> {
  const sourceEnv = input.env ?? process.env;
  const mode = validateLaunchMode(input, sourceEnv);
  if (mode === 'terminal') return null;

  const runId = input.runId!;
  const token = input.token!;
  const stateDir = getBaseStateDir(input.stateDir);
  const runDir = getRunDir(runId, stateDir);
  const controlFile = path.join(runDir, 'control.json');

  if (!fs.existsSync(controlFile)) {
    throw new Error(`Control record control.json not found for run ${runId} in ${runDir}`);
  }
  verifyDirectoryPermissions(runDir);

  let control: ControlRecord;
  try {
    control = ControlSchema.parse(JSON.parse(fs.readFileSync(controlFile, 'utf8')));
  } catch (error: any) {
    throw new Error(`Malformed or unsupported control.json for run ${runId}: ${error?.message ?? String(error)}`);
  }
  // `readControl` applies the stable unsupported-record envelope and lease
  // tuple validation; use it after the explicit error context above.
  control = readControl(runDir);
  if (control.runId !== runId) throw new Error(`Control runId mismatch for run ${runId}`);
  if (!tokenMatches(token, control.ownerTokenHash)) throw new Error(`Owner token mismatch for run ${runId}`);

  const canonicalRoot = fs.realpathSync(projectRoot);
  const canonicalControlRoot = fs.realpathSync(control.projectRoot);
  if (canonicalRoot !== canonicalControlRoot) {
    throw new Error(`Project root mismatch: loop is running in ${canonicalRoot} but run was launched for ${canonicalControlRoot}`);
  }

  const projectDir = getProjectDir(projectRoot, stateDir);
  const cliIdentity = {
    pid: process.pid,
    startMs: getProcessStartTime(process.pid),
    command: getProcessCommand(process.pid)
  };
  await acquireProjectLock(projectDir, {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    runId,
    pid: cliIdentity.pid,
    startMs: cliIdentity.startMs,
    runDir,
    command: cliIdentity.command,
    projectRoot: canonicalRoot
  });

  try {
    const activeFile = path.join(runDir, 'active.json');
    let active: ActiveRecord;
    if (fs.existsSync(activeFile)) {
      active = readActive(runDir);
      if (
        active.cliIdentity.pid !== cliIdentity.pid ||
        Math.abs(active.cliIdentity.startMs - cliIdentity.startMs) > 2000 ||
        active.cliIdentity.command !== cliIdentity.command
      ) {
        throw new Error(`CLI identity drift or duplicate active.json writer detected for run ${runId}`);
      }
    } else {
      active = ActiveSchema.parse({
        schemaVersion: CURRENT_SCHEMA_VERSION,
        cliIdentity,
        groups: [],
        state: 'starting',
        cliRevision: 1
      });
      writeActive(runDir, active);
    }

    return {
      token,
      runId,
      stateDir,
      projectDir,
      runDir,
      control,
      leaseClock: createLeaseClock(control),
      env: scrubOwnershipEnvironment(sourceEnv)
    };
  } catch (error) {
    // Retain admission on an ambiguous/unsupported record. A caller can use
    // the explicit recovery command after inspecting the durable evidence.
    throw error;
  }
}
