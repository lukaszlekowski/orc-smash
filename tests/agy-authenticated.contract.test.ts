import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createAgyAdapter } from '../src/adapters/agy.js';
import { parseAgyInvocationLog } from '../src/adapters/agy-session.js';
import { encodeAgySession } from '../src/adapters/agy-session.js';
import { realProcessRunner, type ProcessRunner } from '../src/adapters/utils.js';

/**
 * This is deliberately disabled unless an operator opts in from an already
 * authenticated shell. Deterministic tests cannot prove AGY's real workspace
 * binding or its 1.1.6 capture-log shape.
 *
 * Exact command (the evidence path must be outside the target repositories):
 * ORC_AGY_AUTHENTICATED_CONTRACT=1 \
 * ORC_AGY_CONTRACT_EVIDENCE=/tmp/orc-smash-agy-evidence.json \
 * pnpm vitest run tests/agy-authenticated.contract.test.ts --testTimeout=300000
 */

const enabled = process.env['ORC_AGY_AUTHENTICATED_CONTRACT'] === '1';
const contractIt = enabled ? it : it.skip;

const targetSentinel = 'orc-smash target/decoy AGY contract sentinel\n';

interface InvocationEvidence {
  args: string[];
  projectMatchesTarget: boolean;
  identity?: { projectId: string; conversationId: string };
  returnedMatchesSupplied?: boolean;
}

function redactedArgs(args: string[], target: string, decoy: string): string[] {
  return args.map((arg) => arg
    .replaceAll(target, '<target>')
    .replaceAll(decoy, '<decoy>')
    .replace(/agy-capture-[^/]+\.log$/, '<capture-log>')
    .replace(/Write exactly the requested file[\s\S]*/, '<prompt>'));
}

function parseWorkspaceDirPath(log: string): string | undefined {
  const match = log.match(/workspaceDirs=\[([^\]]+)\]/);
  return match ? match[1] : undefined;
}

function checkProjectMatchesTarget(log: string, target: string): boolean {
  const workspacePath = parseWorkspaceDirPath(log);
  if (workspacePath) {
    try {
      return realpathSync(workspacePath) === realpathSync(target);
    } catch {
      return workspacePath === target;
    }
  }
  return log.includes(target);
}

describe('authenticated AGY 1.1.6 target/decoy contract', () => {
  contractIt('binds fresh and resumed writes to the target and archives redacted evidence', { timeout: 300000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'orc-smash-agy-contract-'));
    const target = join(root, 'target');
    const decoy = join(root, 'decoy');
    mkdirSync(target, { recursive: true });
    mkdirSync(decoy, { recursive: true });
    const sentinelPath = join(decoy, 'AGY_DECOY_SENTINEL.txt');
    writeFileSync(sentinelPath, targetSentinel);

    const sentinelHashBefore = createHash('sha256').update(readFileSync(sentinelPath)).digest('hex');
    const captureDirectory = join(root, 'capture');
    mkdirSync(captureDirectory, { recursive: true });
    const invocations: InvocationEvidence[] = [];

    try {
      // Establish the decoy as AGY's most-recently active project without
      // changing the operator's AGY home before the target runs.
      const decoyLog = join(captureDirectory, 'decoy-probe.log');
      execFileSync('agy', [
        '-p', 'Reply with the single word DECOY_PROBE_OK and use no tools.',
        '--model', 'gemini-3.6-flash',
        '--effort', 'low',
        '--new-project',
        '--log-file', decoyLog,
        '--dangerously-skip-permissions',
      ], { cwd: decoy, stdio: ['ignore', 'pipe', 'pipe'] });
      rmSync(decoyLog, { force: true });

      const processRunner: ProcessRunner = async (options) => {
        const result = await realProcessRunner(options);
        const logIndex = options.args.indexOf('--log-file');
        const logPath = options.args[logIndex + 1];
        let identity: InvocationEvidence['identity'];
        let projectMatchesTarget = false;
        if (logPath && existsSync(logPath)) {
          const log = readFileSync(logPath, 'utf8');
          try {
            identity = parseAgyInvocationLog(log);
          } catch {
          }
          projectMatchesTarget = checkProjectMatchesTarget(log, target);
        }
        invocations.push({
          args: options.args,
          projectMatchesTarget,
          ...(identity ? { identity } : {}),
        });
        return result;
      };

      const adapter = createAgyAdapter({ captureDirectory, processRunner });

      const runWrite = async (fileName: string, sessionId?: string) => {
        const result = await adapter.run({
          prompt: `Write exactly the requested file ${fileName} with the exact content AGY_TARGET_ONLY. Do not modify any other file.`,
          model: 'gemini-3.6-flash',
          effort: 'low',
          cwd: target,
          ...(sessionId ? { continuity: { mode: 'resumed' as const, sessionId } } : {}),
        });
        expect(result.error).toBeUndefined();
        expect(result.exitCode).toBe(0);
        expect(result.sessionId).toBeTruthy();
        return result.sessionId!;
      };

      const fresh1 = await runWrite('AGY_TARGET_FRESH_1.txt');
      const resumed1 = await runWrite('AGY_TARGET_RESUMED_1.txt', fresh1);
      const fresh2 = await runWrite('AGY_TARGET_FRESH_2.txt');
      const resumed2 = await runWrite('AGY_TARGET_RESUMED_2.txt', fresh2);

      expect(resumed1).toBe(fresh1);
      expect(resumed2).toBe(fresh2);

      // Decoy sentinel byte-for-byte unchanged
      expect(readFileSync(sentinelPath)).toEqual(Buffer.from(targetSentinel));
      const sentinelHashAfter = createHash('sha256').update(readFileSync(sentinelPath)).digest('hex');
      expect(sentinelHashAfter).toBe(sentinelHashBefore);

      for (const fileName of [
        'AGY_TARGET_FRESH_1.txt',
        'AGY_TARGET_RESUMED_1.txt',
        'AGY_TARGET_FRESH_2.txt',
        'AGY_TARGET_RESUMED_2.txt',
      ]) {
        expect(readFileSync(join(target, fileName), 'utf8').trim()).toBe('AGY_TARGET_ONLY');
        expect(existsSync(join(decoy, fileName))).toBe(false);
      }

      expect(invocations).toHaveLength(4);
      for (const item of invocations) {
        expect(item.projectMatchesTarget).toBe(true);
        expect(item.identity).toBeTruthy();
      }
      expect(invocations[0]!.args).toContain('--new-project');
      expect(invocations[0]!.args).not.toContain('--project');
      expect(invocations[0]!.args).not.toContain('--conversation');
      expect(invocations[1]!.args).toContain('--project');
      expect(invocations[1]!.args).toContain('--conversation');
      expect(invocations[1]!.args).not.toContain('--new-project');
      expect(invocations[1]!.args).not.toContain('--continue');
      for (const item of invocations) {
        expect(item.args).toContain('--effort');
      }

      // --- Verify gemini-3.6-flash no-effort claim ---
      // AGY's Gemini models require --effort. Run a direct no-effort invocation
      // to capture and record the failure in evidence.
      let noEffortOutcome: 'succeeded' | 'failed-closed' = 'failed-closed';
      let noEffortStderr = '';
      try {
        execFileSync('agy', [
          '-p', 'Reply with OK',
          '--model', 'gemini-3.6-flash',
          '--new-project',
          '--log-file', join(captureDirectory, 'no-effort-test.log'),
          '--dangerously-skip-permissions',
        ], { cwd: target, stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 });
        noEffortOutcome = 'succeeded';
      } catch (e: any) {
        noEffortOutcome = 'failed-closed';
        noEffortStderr = (e.stderr ?? '').toString().trim().slice(0, 200);
      }
      expect(noEffortOutcome).toBe('failed-closed');

      // Enrich evidence with returnedMatchesSupplied for resumed invocations
      const invocationsWithEquality = invocations.map((item, i) => {
        let returnedMatchesSupplied: boolean | undefined;
        if (i === 1 || i === 3) {
          const supplied = i === 1 ? fresh1 : fresh2;
          try {
            returnedMatchesSupplied = item.identity
              ? encodeAgySession(item.identity) === supplied
              : false;
          } catch {
            returnedMatchesSupplied = false;
          }
        }
        return {
          args: redactedArgs(item.args, target, decoy),
          projectMatchesTarget: item.projectMatchesTarget,
          tokenShape: item.identity ? 'agy:v1:<project-uuid>:<conversation-uuid>' : 'missing',
          returnedMatchesSupplied,
        };
      });

      const evidencePath = process.env['ORC_AGY_CONTRACT_EVIDENCE'];
      if (!evidencePath) throw new Error('ORC_AGY_CONTRACT_EVIDENCE must name the redacted evidence archive.');
      const version = execSync('agy --version', { encoding: 'utf8' }).trim();
      const targetResolvedPath = realpathSync(target);
      const evidence = {
        provider: 'agy',
        version,
        model: 'gemini-3.6-flash',
        effort: 'low',
        target: '<target>',
        decoy: '<decoy>',
        targetResolvedPath: targetResolvedPath.replace(target, '<target>'),
        decoySentinelSha256: { before: sentinelHashBefore, after: sentinelHashAfter, unchanged: true },
        targetOnlyMutations: true,
        identityStable: resumed1 === fresh1 && resumed2 === fresh2,
        geminiNoEffortOutcome: noEffortOutcome,
        geminiNoEffortStderrPrefix: noEffortStderr.slice(0, 100),
        invocations: invocationsWithEquality,
        pass: true,
      };
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
