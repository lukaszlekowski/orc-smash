/*
 * Source-shipped owned-run bootstrap.
 *
 * fd 0/1/2 belong exclusively to the provider after spawn. This file never
 * writes human-readable diagnostics to stdout or stderr; all control traffic
 * uses the private Node IPC channel. The parent owns group authorization and
 * may terminate the fresh group through src/kill-gate.ts.
 */

import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const PROTOCOL_VERSION = 1;
const READY = 'ready';
const PROVIDER_STARTED = 'provider-started';
const PROVIDER_EXITED = 'provider-exited';
const FAILURE = 'failure';
const ACK = 'ack';
const RETIRE = 'retire';

let provider = null;
let providerExit = null;
let parentDisconnected = false;
let shutdownRequested = false;
let retired = false;
let finishing = false;

function send(frame) {
  if (!process.connected || typeof process.send !== 'function') return false;
  try {
    process.send({ protocolVersion: PROTOCOL_VERSION, ...frame });
    return true;
  } catch {
    return false;
  }
}

function fail(message, stage = 'bootstrap') {
  send({ type: FAILURE, stage, message: String(message) });
  finish(70);
}

function processStartEvidence(pid) {
  try {
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000
    }).trim();
    const value = Date.parse(text);
    if (!Number.isFinite(value)) throw new Error('unparseable process start time');
    return { value, resolution: 'second' };
  } catch {
    // The parent independently resolves identity. A bounded wall-clock value
    // is still useful as the bootstrap's readiness evidence.
    return { value: Math.floor(Date.now() / 1000) * 1000, resolution: 'second' };
  }
}

function processGroupIdentity(pid) {
  try {
    const output = execFileSync(
      'ps',
      ['-o', 'pgid=,sess=', '-p', String(pid)],
      { encoding: 'utf8', timeout: 2000 }
    ).trim();
    const fields = output.split(/\s+/).map((value) => Number.parseInt(value, 10));
    if (
      fields.length < 2 ||
      !Number.isInteger(fields[0]) ||
      !Number.isInteger(fields[1]) ||
      fields[0] <= 1 ||
      fields[1] <= 1
    ) {
      throw new Error('unparseable process-group identity');
    }
    return { pgid: fields[0], sessionId: fields[1] };
  } catch {
    // This frame is advisory only. The parent independently resolves the
    // bootstrap identity before ACK, so a restricted process table cannot
    // become signal authority through this fallback.
    return { pgid: pid, sessionId: pid };
  }
}

function finish(code) {
  if (finishing) return;
  finishing = true;
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGHUP');
  process.exitCode = code;
  // Do not use console.* here: provider fd 1/2 must remain clean.
  setImmediate(() => process.exit(code));
}

function finishWithProviderSignal(signal) {
  if (finishing) return;
  finishing = true;
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGHUP');
  try {
    process.kill(process.pid, signal);
  } catch {
    // Re-raise failure is surfaced to the parent as a protocol failure rather
    // than being mistaken for a successful provider exit.
    finishing = false;
    send({ type: FAILURE, stage: 'signal-reraise', message: `failed to re-raise provider signal ${signal}` });
    finish(71);
  }
}

function forwardSignal(signal) {
  shutdownRequested = true;
  if (provider && !providerExit) {
    try { provider.kill(signal); } catch { /* provider may already be closing */ }
  }
  // When the provider has already exited, remain the group leader until the
  // parent checks group absence or sends RETIRE. This keeps fresh authority
  // alive long enough for a SIGKILL escalation to cover cooperative children.
}

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));
process.on('SIGHUP', () => forwardSignal('SIGHUP'));
process.on('uncaughtException', (error) => fail(error?.message ?? error, 'uncaught-exception'));
process.on('unhandledRejection', (error) => fail(error?.message ?? error, 'unhandled-rejection'));
process.on('warning', (warning) => send({ type: FAILURE, stage: 'warning', message: warning?.message ?? String(warning) }));

function finishAfterProvider() {
  if (!providerExit) return;
  if (parentDisconnected) {
    if (providerExit.signal) finishWithProviderSignal(providerExit.signal);
    else finish(providerExit.code ?? 0);
  } else if (retired) {
    if (providerExit.signal) finishWithProviderSignal(providerExit.signal);
    else finish(providerExit.code ?? 0);
  }
}

function startProvider(spec) {
  try {
    provider = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: 'inherit'
    });
  } catch (error) {
    fail(error?.message ?? error, 'provider-spawn');
    return;
  }

  provider.once('error', (error) => {
    providerExit = { code: null, signal: null, error: error?.message ?? String(error) };
    send({ type: FAILURE, stage: 'provider-spawn', message: providerExit.error });
    finish(72);
  });
  provider.once('close', (code, signal) => {
    providerExit = { code, signal };
    send({ type: PROVIDER_EXITED, code, signal });
    // A provider that independently dies by signal must be mirrored exactly.
    // Signals delivered as part of an owned shutdown are handled by the parent
    // group termination path instead.
    if (signal && !shutdownRequested) {
      finishWithProviderSignal(signal);
      return;
    }
    finishAfterProvider();
  });

  send({ type: PROVIDER_STARTED, providerPid: provider.pid });
}

// Install disconnect handling before the readiness frame is emitted. A parent
// may close the IPC channel immediately after receiving that frame.
process.on('disconnect', () => {
  parentDisconnected = true;
  if (!provider && !providerExit) {
    finish(66);
    return;
  }
  if (provider && !providerExit) {
    shutdownRequested = true;
    try { provider.kill('SIGTERM'); } catch { /* already gone */ }
    setTimeout(() => {
      if (provider && !providerExit) {
        try { provider.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, 2000).unref();
  }
  finishAfterProvider();
});

let spec;
try {
  spec = JSON.parse(process.argv[2] ?? '');
  if (
    !spec ||
    typeof spec.command !== 'string' ||
    !Array.isArray(spec.args) ||
    typeof spec.cwd !== 'string' ||
    !spec.env ||
    typeof spec.env !== 'object'
  ) throw new Error('malformed provider specification');
  const identity = processGroupIdentity(process.pid);
  send({
    type: READY,
    bootstrapPid: process.pid,
    pgid: identity.pgid,
    sessionId: identity.sessionId,
    leaderStartEvidence: processStartEvidence(process.pid),
    expectedProviderExecutablePath: spec.expectedProviderExecutablePath,
    expectedProviderArgvFingerprint: spec.expectedProviderArgvFingerprint
  });
} catch (error) {
  fail(error?.message ?? error, 'readiness');
}

function onMessage(message) {
  if (!message || message.protocolVersion !== PROTOCOL_VERSION) {
    fail('unsupported or malformed control frame', 'protocol');
    return;
  }
  if (message.type === ACK) {
    if (provider || providerExit) return;
    startProvider(spec);
    return;
  }
  if (message.type === RETIRE) {
    retired = true;
    finishAfterProvider();
  }
}

process.on('message', onMessage);
