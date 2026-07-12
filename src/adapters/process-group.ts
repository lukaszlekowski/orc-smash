import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import type { RawProcessResult } from './utils.js';
import type { SpawnRequest } from './types.js';
import { getProcessStartTime, registerGroup, confirmGroupClosed } from '../run-ownership.js';

export interface ProcessGroupHandle {
  cgroupPath: string;
  pgid: number;
  leaderPid: number;
  leaderStartMs: number;
  command: string;
  cgroupIno?: number;
  cgroupDev?: number;
}

export interface SpawnRuntime {
  spawn(req: SpawnRequest): {
    result: Promise<RawProcessResult>;
    handle?: ProcessGroupHandle;
    ready?: Promise<void>;
  };
}

export interface CgroupV2Capability {
  supported: boolean;
  reason?: string;
  delegatedRoot?: string;
}

export function checkCgroupV2Capability(): CgroupV2Capability {
  if (process.platform !== 'linux') {
    return { supported: false, reason: 'cgroup-v2 is only supported on Linux' };
  }
  try {
    if (!fs.existsSync('/proc/self/cgroup')) {
      return { supported: false, reason: '/proc/self/cgroup does not exist' };
    }
    const cgroupContent = fs.readFileSync('/proc/self/cgroup', 'utf-8');
    const v2Line = cgroupContent.split('\n').find(line => line.startsWith('0::'));
    if (!v2Line) {
      return { supported: false, reason: 'cgroup v2 (0::) line not found in /proc/self/cgroup' };
    }
    const relativePath = v2Line.substring(3).trim();
    const delegatedRoot = path.join('/sys/fs/cgroup', relativePath);
    
    // Test creating a sub-cgroup
    const testCgroup = path.join(delegatedRoot, 'orc-smash-test-cap');
    fs.mkdirSync(testCgroup, { recursive: true });
    
    let helperProcess: ChildProcess | null = null;
    try {
      helperProcess = spawn('sleep', ['10'], { stdio: 'ignore' });
      const helperPid = helperProcess.pid;
      if (!helperPid) throw new Error('Failed to get PID of helper process');
      
      // Write PID to cgroup.procs
      fs.writeFileSync(path.join(testCgroup, 'cgroup.procs'), String(helperPid));
      
      // Verify membership
      const procs = fs.readFileSync(path.join(testCgroup, 'cgroup.procs'), 'utf-8')
        .split('\n')
        .map(l => l.trim())
        .filter(Boolean);
      if (!procs.includes(String(helperPid))) {
        throw new Error('Helper process not found in cgroup.procs after move-in');
      }
      
      const killFile = path.join(testCgroup, 'cgroup.kill');
      if (!fs.existsSync(killFile)) {
        throw new Error('cgroup.kill file is missing');
      }
      
      // Write 1 to cgroup.kill
      fs.writeFileSync(killFile, '1');
      
      // Wait for helper process to die
      let isDead = false;
      const start = Date.now();
      while (Date.now() - start < 1000) {
        try {
          process.kill(helperPid, 0);
          // Block/Wait 10ms
          const loopStart = Date.now();
          while (Date.now() - loopStart < 10) {}
        } catch {
          isDead = true;
          break;
        }
      }
      if (!isDead) {
        throw new Error('Helper process did not die after cgroup.kill');
      }
      
      try {
        helperProcess.kill('SIGKILL');
      } catch {}
    } finally {
      if (helperProcess) {
        try { helperProcess.unref(); } catch {}
      }
      fs.rmdirSync(testCgroup);
    }
    
    return { supported: true, delegatedRoot };
  } catch (err: any) {
    return { supported: false, reason: `Cgroup capability check failed: ${err.message}` };
  }
}

export function validateRunCgroupPath(cgroupPath: string): string {
  const cap = checkCgroupV2Capability();
  if (!cap.supported || !cap.delegatedRoot) {
    throw new Error('cgroup-v2 is not supported or delegated root is not resolved');
  }
  const resolvedPath = path.resolve(cgroupPath);
  const canonicalDelegatedRoot = path.resolve(cap.delegatedRoot);
  
  if (!resolvedPath.startsWith(canonicalDelegatedRoot)) {
    throw new Error(`Cgroup path traversal violation: ${cgroupPath} is outside delegated root ${canonicalDelegatedRoot}`);
  }
  
  // Deterministic check: must be <delegatedRoot>/orc-smash/<runId>
  const relative = path.relative(canonicalDelegatedRoot, resolvedPath);
  const parts = relative.split(path.sep);
  if (parts.length !== 2 || parts[0] !== 'orc-smash') {
    throw new Error(`Cgroup path structure violation: expected <delegatedRoot>/orc-smash/<runId>, got ${cgroupPath}`);
  }
  
  return resolvedPath;
}

export function validateRunCgroup(
  cgroupPath: string,
  expectedIno?: number,
  expectedDev?: number
): string {
  const validated = validateRunCgroupPath(cgroupPath);
  if (!fs.existsSync(validated)) {
    throw new Error(`Cgroup directory does not exist: ${validated}`);
  }
  const stat = fs.statSync(validated);
  if (expectedIno !== undefined && stat.ino !== expectedIno) {
    throw new Error(`Cgroup directory inode mismatch: expected ${expectedIno}, got ${stat.ino}`);
  }
  if (expectedDev !== undefined && stat.dev !== expectedDev) {
    throw new Error(`Cgroup directory device mismatch: expected ${expectedDev}, got ${stat.dev}`);
  }
  return validated;
}

export function resolveWrapperPath(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, 'process-group-wrapper.sh');
}

export function createCgroup(runId: string): string {
  const cap = checkCgroupV2Capability();
  if (!cap.supported || !cap.delegatedRoot) {
    throw new Error('cgroup-v2 capability check failed before creating cgroup');
  }
  const cgroupPath = path.join(cap.delegatedRoot, 'orc-smash', runId);
  fs.mkdirSync(cgroupPath, { recursive: true });
  return cgroupPath;
}

export function readCgroupProcs(
  cgroupPath: string,
  expectedIno?: number,
  expectedDev?: number
): string[] {
  const validated = validateRunCgroup(cgroupPath, expectedIno, expectedDev);
  const procsFile = path.join(validated, 'cgroup.procs');
  if (!fs.existsSync(procsFile)) return [];
  const content = fs.readFileSync(procsFile, 'utf-8');
  return content.split('\n').map(l => l.trim()).filter(Boolean);
}

export function killCgroup(
  cgroupPath: string,
  expectedIno?: number,
  expectedDev?: number
): { survivors: string[]; unverifiable: boolean } {
  try {
    const validated = validateRunCgroup(cgroupPath, expectedIno, expectedDev);
    const killFile = path.join(validated, 'cgroup.kill');
    if (fs.existsSync(killFile)) {
      fs.writeFileSync(killFile, '1');
    } else {
      throw new Error('cgroup.kill file is missing, cannot kill cgroup');
    }
    const survivors = readCgroupProcs(validated, expectedIno, expectedDev);
    return { survivors, unverifiable: false };
  } catch {
    return { survivors: [], unverifiable: true };
  }
}

export async function terminateProcessGroup(handle: ProcessGroupHandle, graceMs = 2000): Promise<void> {
  let leaderAlive = false;
  try {
    process.kill(handle.leaderPid, 0);
    leaderAlive = true;
  } catch {}

  if (leaderAlive) {
    try {
      process.kill(-handle.pgid, 'SIGTERM');
    } catch {}
  }

  const start = Date.now();
  let empty = false;
  while (Date.now() - start < graceMs) {
    try {
      const procs = readCgroupProcs(handle.cgroupPath, handle.cgroupIno, handle.cgroupDev);
      if (procs.length === 0) {
        empty = true;
        break;
      }
    } catch {
      break;
    }
    const loopStart = Date.now();
    while (Date.now() - loopStart < 50) {}
  }

  if (!empty) {
    killCgroup(handle.cgroupPath, handle.cgroupIno, handle.cgroupDev);
  }
}

export class ProcessGroupRuntime {
  static createGroup(
    runId: string,
    runDir: string,
    command: string,
    providerArgs: string[],
    ownedEnv: Record<string, string>,
    cwd?: string
  ): {
    child: ChildProcess;
    handle: ProcessGroupHandle;
    ready: Promise<void>;
  } {
    const cgroupPath = createCgroup(runId);
    
    const cgroupStat = fs.statSync(cgroupPath);
    const cgroupIno = cgroupStat.ino;
    const cgroupDev = cgroupStat.dev;
    
    const wrapperPath = resolveWrapperPath();
    
    const child = spawn(
      'sh',
      [wrapperPath, cgroupPath, command, ...providerArgs],
      {
        detached: true,
        env: ownedEnv,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe']
      }
    );
    
    const handle: ProcessGroupHandle = {
      cgroupPath,
      pgid: child.pid!,
      leaderPid: child.pid!,
      leaderStartMs: 0,
      command,
      cgroupIno,
      cgroupDev
    };

    const ready = new Promise<void>((resolveReady, rejectReady) => {
      const stream = child.stdio[3] as any;
      if (!stream) {
        rejectReady(new Error('Child stdio[3] is not set up'));
        return;
      }
      let data = '';
      const onData = (chunk: Buffer) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          stream.off('data', onData);
          const line = data.split('\n')[0]!.trim();
          try {
            const parts = line.split('\t');
            if (parts[0] !== 'READY' || parts.length < 5) {
              throw new Error(`Malformed readiness record: ${line}`);
            }
            const reportedPid = parseInt(parts[1]!, 10);
            const reportedPgid = parseInt(parts[2]!, 10);
            const reportedSid = parseInt(parts[3]!, 10);
            const reportedCgroup = parts[4]!;
            
            if (reportedPid !== child.pid || reportedPgid !== child.pid || reportedSid !== child.pid) {
              throw new Error(`Identity mismatch in readiness record: child.pid ${child.pid}, reported ${reportedPid}/${reportedPgid}/${reportedSid}`);
            }
            if (reportedCgroup !== cgroupPath) {
              throw new Error(`Cgroup path mismatch: expected ${cgroupPath}, got ${reportedCgroup}`);
            }
            
            // Verify membership
            const procs = readCgroupProcs(cgroupPath, cgroupIno, cgroupDev);
            if (!procs.includes(String(child.pid))) {
              throw new Error(`Child pid ${child.pid} is not a member of cgroup ${cgroupPath}`);
            }
            
            handle.leaderStartMs = getProcessStartTime(child.pid!);
            registerGroup(runDir, handle);
            
            // Write ACK
            const ackStream = child.stdio[4] as any;
            ackStream.write('ACK\n');
            resolveReady();
          } catch (err: any) {
            killCgroup(cgroupPath, cgroupIno, cgroupDev);
            rejectReady(err);
          }
        }
      };
      stream.on('data', onData);
      
      child.on('error', (err) => {
        killCgroup(cgroupPath, cgroupIno, cgroupDev);
        rejectReady(err);
      });
      child.on('exit', (code, signal) => {
        killCgroup(cgroupPath, cgroupIno, cgroupDev);
        rejectReady(new Error(`Child exited early before registration with code ${code}, signal ${signal}`));
      });
    });
    
    return { child, handle, ready };
  }
}

export class OwnedSpawnRuntime implements SpawnRuntime {
  constructor(
    private runId: string,
    private runDir: string
  ) {}

  spawn(req: SpawnRequest): {
    result: Promise<RawProcessResult>;
    handle?: ProcessGroupHandle;
    ready?: Promise<void>;
  } {
    const startedAt = Date.now();
    let resolveResult: (res: RawProcessResult) => void;
    const resultPromise = new Promise<RawProcessResult>((resolve) => {
      resolveResult = resolve;
    });

    const { child, handle, ready } = ProcessGroupRuntime.createGroup(
      this.runId,
      this.runDir,
      req.command,
      req.args || [],
      req.env || {},
      req.cwd
    );

    // Register active child for cleanup
    const registerPromise = (async () => {
      const { registerActiveChild } = await import('./utils.js');
      registerActiveChild(child, handle);
    })();

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      req.onStdoutChunk?.(chunk);
    });
    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', async (code, signal) => {
      await registerPromise;
      const durationMs = Date.now() - startedAt;
      let confirmError: Error | null = null;
      try {
        await confirmGroupClosed(this.runDir, handle);
      } catch (err: any) {
        confirmError = err;
      }
      
      if (confirmError) {
        // Ownership-control failure (cgroup close verification), NOT a spawn
        // failure: the provider actually ran. Surface it as an ownership failure
        // so the result builders classify `error.kind === 'ownership'` and the
        // operator gets the recovery procedure instead of "CLI missing from PATH".
        resolveResult({
          stdout,
          stderr,
          exitCode: -1,
          timedOut: false,
          signal,
          durationMs,
          ownershipFailure: { message: `Ownership verification failed: ${confirmError.message}` }
        });
      } else {
        resolveResult({
          stdout,
          stderr,
          exitCode: code !== null ? code : (signal ? -1 : 0),
          timedOut: false,
          signal,
          durationMs
        });
      }
    });

    child.on('error', async (err) => {
      await registerPromise;
      const durationMs = Date.now() - startedAt;
      let confirmError: Error | null = null;
      try {
        await confirmGroupClosed(this.runDir, handle);
      } catch (e: any) {
        confirmError = e;
      }
      resolveResult({
        stdout,
        stderr,
        exitCode: -1,
        timedOut: false,
        signal: null,
        durationMs,
        // If ownership verification also failed, that ownership-control failure
        // is the actionable signal — classify as ownership, not spawn. Otherwise
        // this is a genuine spawn failure (e.g. ENOENT).
        ownershipFailure: confirmError
          ? { message: `spawn error: ${err.message}. Ownership verification also failed: ${confirmError.message}` }
          : undefined,
        spawnErrorMessage: confirmError ? undefined : err.message
      });
    });

    return {
      result: resultPromise,
      handle,
      ready
    };
  }
}
