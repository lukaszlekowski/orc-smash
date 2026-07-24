import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAgyAdapter } from '../src/adapters/agy.js';
import { parseAgyInvocationLog } from '../src/adapters/agy-session.js';
import { realProcessRunner, type ProcessRunner } from '../src/adapters/utils.js';

/**
 * This is deliberately disabled unless an operator opts in from an already
 * authenticated shell. Deterministic tests cannot prove AGY's real workspace
 * binding or its 1.1.6 capture-log shape.
 *
 * Exact command (the evidence path must be outside the target repositories):
 * ORC_AGY_AUTHENTICATED_CONTRACT=1 \
 * ORC_AGY_CONTRACT_EVIDENCE=/tmp/orc-smash-agy-evidence.json \
 * pnpm vitest run tests/agy-authenticated.contract.test.ts
 */

const enabled = process.env['ORC_AGY_AUTHENTICATED_CONTRACT'] === '1';
const contractIt = enabled ? it : it.skip;

const targetSentinel = 'orc-smash target/decoy AGY contract sentinel\n';

interface InvocationEvidence {
  args: string[];
  projectMatchesTarget: boolean;
  identity?: { projectId: string; conversationId: string };
}

function redactedArgs(args: string[], target: string, decoy: string): string[] {
  return args.map((arg) => arg
    .replaceAll(target, '<target>')
    .replaceAll(decoy, '<decoy>')
    .replace(/agy-capture-[^/]+\.log$/, `${'<capture-log>'}`)
    .replace(/Write exactly the requested file[\s\S]*/, '<prompt>'));
}

describe('authenticated AGY 1.1.6 target/decoy contract', () => {
  contractIt('binds fresh and resumed writes to the target and archives redacted evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'orc-smash-agy-contract-'));
    const target = join(root, 'target');
    const decoy = join(root, 'decoy');
    mkdirSync(target, { recursive: true });
    mkdirSync(decoy, { recursive: true });
    const sentinelPath = join(decoy, 'AGY_DECOY_SENTINEL.txt');
    writeFileSync(sentinelPath, targetSentinel);
    const sentinelBefore = readFileSync(sentinelPath);
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

      const targetUri = pathToFileURL(target).toString();
      const processRunner: ProcessRunner = async (options) => {
        const result = await realProcessRunner(options);
        const logIndex = options.args.indexOf('--log-file');
        const logPath = options.args[logIndex + 1];
        let identity: InvocationEvidence['identity'];
        let projectMatchesTarget = false;
        if (logPath && existsSync(logPath)) {
          const log = readFileSync(logPath, 'utf8');
          identity = parseAgyInvocationLog(log);
          // AGY 1.1.6 reports the workspace as a file URI in the invocation
          // diagnostics. Keep only this boolean; never archive the raw log.
          projectMatchesTarget = log.includes(targetUri) || log.includes(target);
        }
        invocations.push({
          args: options.args,
          projectMatchesTarget,
          ...(identity ? { identity } : {}),
        });
        return result;
      };

      const adapter = createAgyAdapter({ captureDirectory, processRunner });
      const runWrite = async (fileName: string, effort: string | undefined, sessionId?: string) => {
        const result = await adapter.run({
          prompt: `Write exactly the requested file ${fileName} with the exact content AGY_TARGET_ONLY. Do not modify any other file.`,
          model: 'gemini-3.6-flash',
          ...(effort ? { effort } : {}),
          cwd: target,
          ...(sessionId ? { continuity: { mode: 'resumed' as const, sessionId } } : {}),
        });
        expect(result.error).toBeUndefined();
        expect(result.sessionId).toBeTruthy();
        return result.sessionId!;
      };

      const defaultFresh = await runWrite('AGY_TARGET_DEFAULT_FRESH.txt', undefined);
      const defaultResumed = await runWrite('AGY_TARGET_DEFAULT_RESUMED.txt', undefined, defaultFresh);
      const explicitFresh = await runWrite('AGY_TARGET_EXPLICIT_FRESH.txt', 'low');
      const explicitResumed = await runWrite('AGY_TARGET_EXPLICIT_RESUMED.txt', 'low', explicitFresh);

      expect(defaultResumed).toBe(defaultFresh);
      expect(explicitResumed).toBe(explicitFresh);
      expect(readFileSync(sentinelPath)).toEqual(sentinelBefore);
      for (const fileName of [
        'AGY_TARGET_DEFAULT_FRESH.txt',
        'AGY_TARGET_DEFAULT_RESUMED.txt',
        'AGY_TARGET_EXPLICIT_FRESH.txt',
        'AGY_TARGET_EXPLICIT_RESUMED.txt',
      ]) {
        expect(readFileSync(join(target, fileName), 'utf8')).toBe('AGY_TARGET_ONLY');
        expect(existsSync(join(decoy, fileName))).toBe(false);
      }

      expect(invocations).toHaveLength(4);
      expect(invocations.every((item) => item.projectMatchesTarget && item.identity)).toBe(true);
      expect(invocations[0]!.args).toContain('--new-project');
      expect(invocations[1]!.args).toContain('--project');
      expect(invocations[1]!.args).toContain('--conversation');
      expect(invocations[1]!.args).not.toContain('--new-project');
      expect(invocations[1]!.args).not.toContain('--continue');
      expect(invocations[2]!.args).toContain('--effort');
      expect(invocations[3]!.args).toContain('--effort');
      expect(invocations[0]!.args).not.toContain('--effort');
      expect(invocations[1]!.args).not.toContain('--effort');

      const evidencePath = process.env['ORC_AGY_CONTRACT_EVIDENCE'];
      if (!evidencePath) throw new Error('ORC_AGY_CONTRACT_EVIDENCE must name the redacted evidence archive.');
      const version = execFileSync('agy', ['--version'], { encoding: 'utf8' }).trim();
      const evidence = {
        provider: 'agy',
        version,
        model: 'gemini-3.6-flash',
        efforts: ['provider-default', 'low'],
        target: '<target>',
        decoy: '<decoy>',
        decoySentinelUnchanged: true,
        targetOnlyMutations: true,
        identityStable: defaultFresh === defaultResumed && explicitFresh === explicitResumed,
        invocations: invocations.map((item) => ({
          args: redactedArgs(item.args, target, decoy),
          projectMatchesTarget: item.projectMatchesTarget,
          tokenShape: item.identity ? 'agy:v1:<project-uuid>:<conversation-uuid>' : 'missing',
        })),
        pass: true,
      };
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
