import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { OwnedSpawnRuntime } from '../../src/adapters/process-group.js';
import {
  __resetForbiddenPgidCacheForTests,
  __setSignalSenderForTests,
  resolveForbiddenPgids
} from '../../src/kill-gate.js';
import { resolveProcessIdentity } from '../../src/process-identity.js';
import {
  acquireProjectLock,
  readActive,
  releaseProjectLock,
  watchLease,
  writeActive,
  writeControl
} from '../../src/run-ownership.js';
import { terminateOwnedRuntimes } from '../../src/owned-runtime-registry.js';
import {
  clearInterruptState,
  handleOwnershipLoss,
  setActiveProjectRoot,
  setStepCtx
} from '../../src/interrupted-artifact.js';

const root = process.argv[2];
if (!root) throw new Error('runtime helper requires a temporary root path');

const known = {
  helperPid: process.pid,
  bootstrapPid: undefined,
  providerPid: undefined,
  childPid: undefined,
  allowedPgid: undefined
};
const signals = [];
const identities = {};
let senderInstalled = false;
let completed = false;
let ownedRunDir;
let activeWatcher;
let allowedSignalPgid;
let signalsBeforeAllowlist = 0;
let senderRejections = 0;

function send(message) {
  if (process.connected && typeof process.send === 'function') {
    process.send({
      ...message,
      signalsBeforeAllowlist,
      senderRejections,
      allowlistArmed: Number.isInteger(allowedSignalPgid)
    });
  }
}

function installRejectAllSignalSender() {
  // Install containment before the watcher can observe any expiry. Until the
  // independently verified fixture PGID is armed, no signal reaches process.kill.
  __setSignalSenderForTests((pid, signal) => {
    if (!Number.isInteger(allowedSignalPgid) || pid !== -allowedSignalPgid) {
      senderRejections++;
      if (!Number.isInteger(allowedSignalPgid)) signalsBeforeAllowlist++;
      throw new Error(`test safety gate rejected unexpected negative target ${pid}`);
    }
    signals.push({ pid, signal });
    process.kill(pid, signal);
  });
  senderInstalled = true;
}

function armSignalAllowlist(pgid) {
  if (Number.isInteger(allowedSignalPgid)) throw new Error('fixture PGID allowlist was already armed');
  if (!Number.isInteger(pgid) || pgid <= 1) throw new Error(`invalid fixture PGID ${pgid}`);
  allowedSignalPgid = pgid;
  known.allowedPgid = pgid;
}

function identity(pid, label) {
  const observed = resolveProcessIdentity(pid);
  if (observed.status !== 'verified') {
    throw new Error(`${label} identity is ${observed.status}: ${observed.reason ?? 'unknown'}`);
  }
  return observed;
}

function identitySnapshot(observed) {
  return {
    pid: observed.pid,
    pgid: observed.pgid,
    sessionId: observed.sessionId,
    startMs: observed.startEvidence.value,
    startResolution: observed.startEvidence.resolution,
    executablePath: observed.executablePath,
    argvFingerprint: observed.argvFingerprint
  };
}

function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitGone(pid, label) {
  await waitFor(() => !isAlive(pid), `${label} to exit`);
}

async function cleanupFreshRuntime() {
  if (!senderInstalled || !ownedRunDir) return;
  await terminateOwnedRuntimes(
    500,
    (capability) => capability.runId === 'run-a' && capability.runDir === ownedRunDir
  ).catch(() => {
    // If fresh authority is unavailable, the bounded fixture watchdogs are the
    // remaining cleanup path; no durable or reported-PID fallback is attempted.
  });
}

function fixtureProviderCode() {
  const cooperativeCode = "process.on('SIGTERM', () => process.exit(0)); setTimeout(() => process.exit(76), 12000); setInterval(() => {}, 1000);";
  return `
    // node -e intentionally runs this fixture as CommonJS; require keeps the
    // provider source self-contained and exercises the exact requested argv.
    const { spawn } = require('node:child_process');
    const cooperative = spawn(process.execPath, ['-e', ${JSON.stringify(cooperativeCode)}], { stdio: 'ignore' });
    process.stdout.write(String(process.pid) + ':' + String(cooperative.pid) + '\\n');
    setTimeout(() => process.exit(75), 15000);
    setInterval(() => {}, 1000);
  `;
}

function fixtureLoop() {
  return {
    kind: 'doc-audit',
    target: 'fixture.txt',
    targetKind: 'file',
    audit: 'fixture-audit',
    'follow-up': 'fixture-follow-up',
    implement: 'fixture-implement',
    auditPattern: 'docs/dev/fixture-audit-v{n}-{agent}.md',
    followUpPattern: 'docs/dev/fixture-follow-up-v{n}-{agent}.md',
    implementPattern: 'docs/dev/fixture-implement-v{n}-{agent}.md',
    inputs: []
  };
}

async function main() {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const helperIdentity = identity(process.pid, 'detached helper');
  identities.helper = identitySnapshot(helperIdentity);
  if (
    helperIdentity.pid !== helperIdentity.pgid ||
    helperIdentity.pid !== helperIdentity.sessionId
  ) {
    throw new Error(
      `helper is not an independent session leader: pid=${helperIdentity.pid}, pgid=${helperIdentity.pgid}, session=${helperIdentity.sessionId}`
    );
  }

  const forbidden = resolveForbiddenPgids();
  if (!forbidden || !forbidden.has(helperIdentity.pgid)) {
    throw new Error('production forbidden-group resolver did not protect the detached helper group');
  }

  const runId = 'run-a';
  const runDir = join(root, 'runs', runId);
  ownedRunDir = runDir;
  const projectDir = join(root, 'projects', 'fixture');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  mkdirSync(projectDir, { recursive: true, mode: 0o700 });

  const now = Date.now();
  const leaseTtlMs = 6_000;
  const control = {
    schemaVersion: 1,
    runId,
    ownerTokenHash: '0'.repeat(64),
    projectRoot: root,
    hostInstanceId: 'runtime-helper-host',
    leaseIssuedMs: now,
    leaseTtlMs,
    leaseExpiresMs: now + leaseTtlMs,
    issuerRevision: 1
  };
  writeControl(runDir, control);
  writeActive(runDir, {
    schemaVersion: 1,
    cliIdentity: {
      pid: helperIdentity.pid,
      startMs: helperIdentity.startEvidence.value,
      command: process.execPath
    },
    groups: [],
    state: 'starting',
    cliRevision: 1
  });
  await acquireProjectLock(projectDir, {
    schemaVersion: 1,
    runId,
    pid: helperIdentity.pid,
    startMs: helperIdentity.startEvidence.value,
    runDir,
    command: process.execPath,
    projectRoot: root
  });

  const ownedEnv = { ...process.env };
  delete ownedEnv.ORC_RUN_ID;
  delete ownedEnv.ORC_RUN_TOKEN;
  delete ownedEnv.ORC_RUN_STATE_DIR;

  const ownershipContext = {
    token: 'fixture-token',
    runId,
    stateDir: root,
    projectDir,
    runDir,
    control,
    env: ownedEnv
  };
  setActiveProjectRoot(root);
  setStepCtx({
    loop: 'fixture',
    kind: 'implement',
    version: 1,
    agent: 'fixture',
    model: 'fixture',
    skillId: 'fixture'
  });
  installRejectAllSignalSender();
  activeWatcher = watchLease(ownershipContext, { intervalMs: 25, maxReadErrors: 1 });
  const ownershipLossPromise = activeWatcher.expired.then(() => handleOwnershipLoss(fixtureLoop(), ownershipContext));

  let output = '';
  const runtime = new OwnedSpawnRuntime(runId, runDir);
  const spawned = runtime.spawn({
    command: process.execPath,
    args: ['-e', fixtureProviderCode()],
    env: ownedEnv,
    cwd: root,
    onStdoutChunk: (chunk) => {
      output += chunk;
      const match = output.match(/(\d+):(\d+)\s*\n/);
      if (match) {
        known.providerPid = Number.parseInt(match[1], 10);
        known.childPid = Number.parseInt(match[2], 10);
      }
    }
  });
  known.bootstrapPid = spawned.handle?.leaderPid;
  if (!Number.isInteger(known.bootstrapPid)) throw new Error('owned runtime did not expose a bootstrap PID');

  await spawned.ready;
  const providerReadyAtMs = Date.now();
  if (providerReadyAtMs >= control.leaseExpiresMs) {
    throw new Error('fixture provider was not ready while the lease was still valid');
  }
  await waitFor(
    () => Number.isInteger(known.providerPid) && Number.isInteger(known.childPid),
    'fixture provider and cooperative child PIDs'
  );

  // This is an independent process-table read, separate from the runtime's
  // readiness verification and never derived from the mutable handle object.
  const fixture = identity(known.bootstrapPid, 'fixture bootstrap');
  identities.bootstrap = identitySnapshot(fixture);
  identities.provider = identitySnapshot(identity(known.providerPid, 'fixture provider'));
  identities.child = identitySnapshot(identity(known.childPid, 'cooperative child'));
  if (
    fixture.pid !== known.bootstrapPid ||
    fixture.pgid !== known.bootstrapPid ||
    fixture.sessionId !== known.bootstrapPid ||
    fixture.pgid !== spawned.handle.pgid ||
    fixture.sessionId !== spawned.handle.sessionId ||
    forbidden.has(fixture.pgid)
  ) {
    throw new Error(
      `fixture group was not independently isolated: pid=${fixture.pid}, pgid=${fixture.pgid}, session=${fixture.sessionId}, allowed=${spawned.handle.pgid}`
    );
  }
  armSignalAllowlist(fixture.pgid);
  if (signalsBeforeAllowlist !== 0) {
    throw new Error(`signal delivery was attempted before the fixture PGID was armed: ${signalsBeforeAllowlist}`);
  }

  // Lease updates are sequential and cannot move the deadline backward. The
  // initial lease gives setup room; this revision leaves only a short future
  // window after the verified target is armed for the watcher to observe.
  const revisedLeaseExpiresMs = control.leaseExpiresMs + 750;
  const revisedLeaseIssuedMs = Date.now();
  if (revisedLeaseExpiresMs <= revisedLeaseIssuedMs) {
    throw new Error('fixture setup consumed the initial lease before target arming');
  }
  const revisedControl = {
    ...control,
    leaseIssuedMs: revisedLeaseIssuedMs,
    leaseTtlMs: revisedLeaseExpiresMs - revisedLeaseIssuedMs,
    leaseExpiresMs: revisedLeaseExpiresMs,
    issuerRevision: control.issuerRevision + 1
  };
  writeControl(runDir, revisedControl);
  ownershipContext.control = revisedControl;

  send({
    type: 'started',
    ...known,
    identities,
    leaseExpiresMs: revisedControl.leaseExpiresMs,
    initialLeaseExpiresMs: control.leaseExpiresMs,
    providerReadyAtMs,
    cleanupSource: 'watchLease'
  });

  const loss = await Promise.race([
    ownershipLossPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('watchLease did not observe lease expiry')), 10_000))
  ]);
  activeWatcher.cancel();
  activeWatcher = undefined;
  if (loss.kind !== 'ownership-stopped') {
    throw new Error(`ownership loss did not stop through fresh capability: ${loss.reason}`);
  }

  const result = await Promise.race([
    spawned.result,
    new Promise((_, reject) => setTimeout(() => reject(new Error('owned runtime result did not settle')), 8_000))
  ]);
  const active = readActive(runDir);
  await Promise.all([
    waitGone(known.bootstrapPid, 'bootstrap'),
    waitGone(known.providerPid, 'provider'),
    waitGone(known.childPid, 'cooperative child')
  ]);

  if (active.state !== 'stopped' || active.groups.length !== 0) {
    throw new Error(`active record was not retired after verified absence: ${JSON.stringify(active)}`);
  }
  if (!Array.isArray(signals) || signals.length === 0 || signals.some(({ pid }) => pid !== -known.allowedPgid)) {
    throw new Error('fresh signal allowlist did not exclusively deliver to the fixture group');
  }

  const secondRunDir = join(root, 'runs', 'run-b');
  mkdirSync(secondRunDir, { recursive: true, mode: 0o700 });
  await acquireProjectLock(projectDir, {
    schemaVersion: 1,
    runId: 'run-b',
    pid: helperIdentity.pid,
    startMs: helperIdentity.startEvidence.value,
    runDir: secondRunDir,
    command: process.execPath,
    projectRoot: root
  });
  const relaunchAdmitted = existsSync(join(projectDir, 'project.lock'));
  releaseProjectLock(projectDir, 'run-b');

  completed = true;
  send({
    type: 'result',
    ok: true,
    ...known,
    identities,
    signals,
    leaseWasValidAtProviderReady: providerReadyAtMs < control.leaseExpiresMs,
    cleanupSource: 'watchLease',
    activeState: active.state,
    activeGroups: active.groups,
    pidsGone: !isAlive(known.bootstrapPid) && !isAlive(known.providerPid) && !isAlive(known.childPid),
    relaunchAdmitted,
    providerResult: { exitCode: result.exitCode, signal: result.signal }
  });
}

try {
  await main();
} catch (error) {
  send({
    type: 'result',
    ok: false,
    ...known,
    signals,
    error: error?.message ?? String(error)
  });
} finally {
  activeWatcher?.cancel();
  if (!completed) await cleanupFreshRuntime();
  if (senderInstalled) __setSignalSenderForTests(null);
  __resetForbiddenPgidCacheForTests();
  clearInterruptState();
  if (process.connected) process.disconnect();
  setImmediate(() => process.exit(completed ? 0 : 1));
}
