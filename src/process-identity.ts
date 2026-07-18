import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Identity evidence used by the process-group gate. `verified` means every
 * requested field was read from the platform's process table. `ambiguous` is
 * deliberately not signal authority; it is retained only so callers can
 * explain why recovery is blocked.
 */

export const START_TOLERANCE_MS = 2000;

export interface VerifiedIdentity {
  status: 'verified';
  pid: number;
  pgid: number;
  sessionId: number;
  executablePath: string;
  argvFingerprint?: string;
  startEvidence: { value: number; resolution: 'second' | 'tick' };
  /** Linux `/proc` incarnation evidence is collision-resistant. */
  collisionResistant: boolean;
}

export interface AmbiguousIdentity {
  status: 'ambiguous';
  reason: string;
}

export interface GoneIdentity {
  status: 'gone';
}

export type ProcessIdentityResult = VerifiedIdentity | AmbiguousIdentity | GoneIdentity;

const MACOS_MONTHS: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11
};

function parseMacosLstart(value: string): number | null {
  // macOS: "Tue Jul 14 12:34:56 2026". Double spaces before a single-digit
  // day are normalized by split(/\s+/).
  const parts = value.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const month = MACOS_MONTHS[parts[1]!];
  const day = Number.parseInt(parts[2]!, 10);
  const time = parts[3]!.split(':').map((part) => Number.parseInt(part, 10));
  const year = Number.parseInt(parts[4]!, 10);
  if (
    month === undefined ||
    !Number.isInteger(day) ||
    time.length !== 3 ||
    time.some((part) => !Number.isInteger(part)) ||
    !Number.isInteger(year)
  ) {
    return null;
  }
  return new Date(year, month, day, time[0]!, time[1]!, time[2]!).getTime();
}

function parseMacosPsLine(value: string, pid: number): {
  pgid: number;
  sessionId: number;
  startText: string;
  command: string;
} | null {
  const parts = value.trim().split(/\s+/);
  // pgid, session, weekday, month, day, time, year, command...
  if (parts.length < 7) return null;
  const pgid = Number.parseInt(parts[0]!, 10);
  const reportedSessionId = Number.parseInt(parts[1]!, 10);
  if (!Number.isInteger(pgid) || pgid <= 1) return null;

  // The macOS ps shipped in some launchd/no-TTY environments reports `sess`
  // as 0 and does not expose a usable `sid` keyword. For the detached
  // process-group contract, the bootstrap is independently identified by
  // pgid === pid and POSIX setsid() makes that leader's session ID equal to its
  // PID; every provider in that group has the same session. Use the observed
  // PGID as the session evidence for group members as well. The parent still
  // requires the bootstrap's exact pid/pgid/session tuple before ACK, and
  // durable macOS authority remains refused.
  const sessionId = reportedSessionId > 1
    ? reportedSessionId
    : pgid;
  if (!sessionId) return null;
  return {
    pgid,
    sessionId,
    startText: parts.slice(2, 7).join(' '),
    command: parts.slice(7).join(' ')
  };
}

function firstAbsoluteToken(command: string): string | null {
  const token = command.trim().split(/\s+/)[0];
  if (!token || !token.startsWith('/')) return null;
  return token;
}

function resolveMacosIdentity(pid: number): ProcessIdentityResult {
  try {
    const output = execFileSync(
      'ps',
      ['-p', String(pid), '-o', 'pgid=,sess=,lstart=,command='],
      { encoding: 'utf8', timeout: 2000 }
    ).trim();
    if (!output) return { status: 'gone' };

    const parsed = parseMacosPsLine(output, pid);
    if (!parsed) return { status: 'ambiguous', reason: 'unparseable macOS ps output' };
    const startMs = parseMacosLstart(parsed.startText);
    if (startMs === null) return { status: 'ambiguous', reason: 'unparseable macOS start evidence' };

    const executablePath = firstAbsoluteToken(parsed.command);
    if (!executablePath) {
      // macOS command display is lossy. Do not manufacture partial authority
      // from a matching PGID and second-granularity start time.
      return {
        status: 'ambiguous',
        reason: 'executable path is not determinable from macOS ps output'
      };
    }

    return {
      status: 'verified',
      pid,
      pgid: parsed.pgid,
      sessionId: parsed.sessionId,
      executablePath,
      startEvidence: { value: startMs, resolution: 'second' },
      collisionResistant: false
    };
  } catch (error: any) {
    // `ps` exits non-zero for a process that disappeared between the caller's
    // lookup and this read. Other failures are ambiguous, not absent.
    if (error?.status !== undefined && error.status !== 0) return { status: 'gone' };
    return { status: 'ambiguous', reason: 'macOS process identity lookup failed' };
  }
}

function readLinuxBootTimeMs(): number {
  const line = fs
    .readFileSync('/proc/stat', 'utf8')
    .split('\n')
    .find((entry) => entry.startsWith('btime '));
  if (!line) throw new Error('btime not found');
  const seconds = Number.parseInt(line.split(/\s+/)[1]!, 10);
  if (!Number.isFinite(seconds)) throw new Error('invalid btime');
  return seconds * 1000;
}

function readLinuxClockTicks(): number {
  const value = Number.parseInt(execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8' }).trim(), 10);
  if (!Number.isFinite(value) || value <= 0) throw new Error('invalid CLK_TCK');
  return value;
}

function resolveLinuxIdentity(pid: number): ProcessIdentityResult {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const lastCloseParen = stat.lastIndexOf(')');
    if (lastCloseParen < 0) return { status: 'ambiguous', reason: 'malformed Linux stat line' };

    // The slice starts at field 3 (state), so field 4/5/6 are indexes 1/2/3
    // after the state. This avoids the common off-by-two PGID bug.
    const fields = stat.slice(lastCloseParen + 1).trim().split(/\s+/);
    const pgid = Number.parseInt(fields[2]!, 10);
    const sessionId = Number.parseInt(fields[3]!, 10);
    const startTicks = Number.parseInt(fields[19]!, 10);
    if (![pgid, sessionId, startTicks].every(Number.isFinite)) {
      return { status: 'ambiguous', reason: 'missing Linux process identity fields' };
    }

    const executablePath = fs.realpathSync(`/proc/${pid}/exe`);
    let argvFingerprint: string | undefined;
    try {
      const argv = fs.readFileSync(`/proc/${pid}/cmdline`);
      argvFingerprint = argv
        .toString('utf8')
        .split('\0')
        .filter((part) => part.length > 0)
        .join('\0');
    } catch {
      // argv is optional on Linux, but the typed process identity remains
      // collision-resistant through /proc start ticks + executable path.
    }

    const startMs = readLinuxBootTimeMs() + Math.round((startTicks * 1000) / readLinuxClockTicks());
    return {
      status: 'verified',
      pid,
      pgid,
      sessionId,
      executablePath,
      argvFingerprint,
      startEvidence: { value: startMs, resolution: 'tick' },
      collisionResistant: true
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ESRCH') return { status: 'gone' };
    return { status: 'ambiguous', reason: `Linux process identity lookup failed: ${error?.message ?? 'unknown error'}` };
  }
}

export function resolveProcessIdentity(pid: number): ProcessIdentityResult {
  if (!Number.isInteger(pid) || pid <= 0) return { status: 'ambiguous', reason: 'invalid pid' };
  if (process.platform === 'darwin') return resolveMacosIdentity(pid);
  if (process.platform === 'linux') return resolveLinuxIdentity(pid);
  return { status: 'ambiguous', reason: `unsupported platform: ${process.platform}` };
}

export function getProcessStartTime(pid: number): number {
  const identity = resolveProcessIdentity(pid);
  if (identity.status !== 'verified') {
    // Some restricted CI sandboxes hide `/proc` and deny `ps` even for the
    // current process. This fallback is only for the current CLI pid; it is
    // never used to authorize a provider or a durable foreign pid.
    if (pid === process.pid) return Date.now() - Math.round(process.uptime() * 1000);
    throw new Error(`unable to resolve process start evidence for pid ${pid}: ${identity.status}`);
  }
  return identity.startEvidence.value;
}

export function getProcessCommand(pid: number): string {
  const identity = resolveProcessIdentity(pid);
  if (identity.status !== 'verified') {
    if (pid === process.pid) return process.execPath;
    throw new Error(`unable to resolve process executable for pid ${pid}: ${identity.status}`);
  }
  return identity.executablePath;
}

/** Resolve a command using the exact environment/cwd that will be spawned. */
export function resolveExecutablePath(
  command: string,
  env: Record<string, string> = process.env as Record<string, string>,
  cwd = process.cwd()
): string {
  if (path.isAbsolute(command)) return command;
  if (command.includes(path.sep)) return path.resolve(cwd, command);
  const pathEntries = (env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    try {
      if (fs.statSync(candidate).isFile() && (process.platform === 'win32' || (fs.statSync(candidate).mode & 0o111) !== 0)) {
        return fs.realpathSync(candidate);
      }
    } catch {
      // Continue through PATH entries.
    }
  }
  return command;
}

export interface IdentityCheckParams {
  recordedPid: number;
  recordedPgid: number;
  recordedSessionId: number;
  recordedExecutablePath: string;
  recordedLeaderStartMs: number;
  recordedArgvFingerprint?: string;
}

/** Durable cleanup predicate: collision-resistant evidence is mandatory. */
export function checkStaleIdentity(recorded: IdentityCheckParams, observed: VerifiedIdentity): boolean {
  if (observed.pid !== recorded.recordedPid) return false;
  if (observed.pgid !== recorded.recordedPgid) return false;
  if (observed.sessionId !== recorded.recordedSessionId) return false;
  if (observed.executablePath !== recorded.recordedExecutablePath) return false;
  if (recorded.recordedArgvFingerprint === undefined || observed.argvFingerprint === undefined) return false;
  if (observed.argvFingerprint !== recorded.recordedArgvFingerprint) return false;
  if (Math.abs(observed.startEvidence.value - recorded.recordedLeaderStartMs) > START_TOLERANCE_MS) return false;
  return observed.collisionResistant;
}
