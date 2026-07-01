import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { createProductionAdapterRegistry, type AgentRegistry } from '../src/adapters/registry.js';
import { createAgyAdapter } from '../src/adapters/agy.js';
import type { AgentAdapter, RunInput, RunResult } from '../src/adapters/types.js';
import type { LifecycleEvent } from '../src/adapter-lifecycle.js';
import { parseVerdict } from '../src/verdict.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

const mockOutput = {
  note: () => {},
  warn: () => {},
  error: () => {},
  iterationStarted: () => {},
  stepStarted: () => {},
  stepSucceeded: () => {},
  stepFailed: () => {},
  renderPanel: () => {},
  finalSummary: () => {}
};

/**
 * Deterministic fake `agy` adapter for the loop-level contract. It mirrors how
 * a real agent obeys the prompt by writing the artifact at the parsed
 * "Write your output to:" path, then returns either:
 *   - authenticated success (valid APPROVED audit, benign auth-substring output), or
 *   - unauthenticated failure (partial artifact + error.kind 'auth').
 *
 * This is the loop-driven contract owner: it exercises src/loop.ts's auth-cleanup
 * branch, which the adapter itself cannot reach (the adapter owns detection only).
 */
function makeFakeAgyAdapter(opts: { authFail: boolean }): AgentAdapter {
  return {
    name: 'agy',
    buildRun(input: RunInput) {
      return { command: 'agy', args: ['-p', input.prompt, '--model', input.model, '--dangerously-skip-permissions'] };
    },
    async run(input: RunInput): Promise<RunResult> {
      const emit = (e: LifecycleEvent) => input.onLifecycle?.(e);
      if (input.onLifecycle && input.version !== undefined && input.skillId !== undefined) {
        emit({ type: 'started', agent: 'agy', model: input.model, version: input.version, skillId: input.skillId, message: 'agy', atMs: Date.now() });
      }
      const match = input.prompt.match(/Write your output to:\s*([^\r\n]+)/i);
      const relPath = match?.[1]?.trim() ?? '';
      if (relPath) {
        const abs = resolve(input.cwd, relPath);
        mkdirSync(dirname(abs), { recursive: true });
        if (opts.authFail) {
          // agy wrote a partial/wrong artifact before the auth fallback was detected.
          writeFileSync(abs, 'PARTIAL UNAUTHENTICATED agy OUTPUT');
        } else {
          writeFileSync(abs, '# Plan Audit\n\n## Verdict\n\nAPPROVED\n');
        }
      }
      // Authenticated success includes benign auth substrings to prove no
      // false-positive classification; unauthenticated returns the structured auth error.
      if (input.onLifecycle && input.version !== undefined) {
        emit({ type: 'completed', agent: 'agy', version: input.version, atMs: Date.now() });
      }
      if (opts.authFail) {
        return {
          stdout: 'ERROR 401 Unauthorized',
          stderr: 'invalid api key',
          exitCode: 0,
          error: { kind: 'auth', message: 'agy authentication failed' }
        };
      }
      return {
        stdout: 'Authentication succeeded. Author verified by certificate authority.',
        stderr: '',
        exitCode: 0
      };
    }
  };
}

describe('agy unified contract (loop-driven: authenticated success + unauthenticated failure)', () => {
  const tempDir = join(process.cwd(), 'temp-agy-contract');
  let registry: AgentRegistry;

  beforeEach(() => {
    createTempDir('temp-agy-contract');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
    writeFileSync(
      join(tempDir, 'orc.config.yaml'),
      'providers:\n  opencode:\n    - opencode-go/deepseek-v4-flash\n  agy:\n    - Gemini 3.5 Flash (Medium)\ndefaults:\n  agent: opencode\n  model: opencode-go/deepseek-v4-flash\n'
    );
    registry = createProductionAdapterRegistry(loadConfig(tempDir).registry);
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('authenticated agy run writes the audit artifact, returns success, and does NOT misclassify benign auth substrings', async () => {
    registry.adapters.set('agy', makeFakeAgyAdapter({ authFail: false }));
    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;

    const result = await runLoop(tempDir, 'plan', planSpec, config, {
      'plan-audit': { agent: 'agy', model: 'Gemini 3.5 Flash (Medium)' }
    }, {
      maxIterations: 1,
      registry,
      output: mockOutput
    });

    expect(result.success).toBe(true);
    expect(result.verdict).toBe('APPROVED');
    // The authenticated artifact remains in place (NOT quarantined).
    const artifact = join(tempDir, 'docs/dev/plan-audit-v1-agy.md');
    expect(existsSync(artifact)).toBe(true);
    expect(parseVerdict(readFileSync(artifact, 'utf-8'))).toBe('APPROVED');
  });

  it('unauthenticated agy run: the LOOP quarantines the resolved plan-style artifact (no resumable file left)', async () => {
    registry.adapters.set('agy', makeFakeAgyAdapter({ authFail: true }));
    const config = loadConfig(tempDir);
    const planSpec = config.manifest.loops['plan']!;

    const result = await runLoop(tempDir, 'plan', planSpec, config, {
      'plan-audit': { agent: 'agy', model: 'Gemini 3.5 Flash (Medium)' }
    }, {
      maxIterations: 1,
      registry,
      output: mockOutput
    });

    expect(result.success).toBe(false);
    // Postcondition (owned by the loop): no resumable plan-style artifact remains.
    const artifact = join(tempDir, 'docs/dev/plan-audit-v1-agy.md');
    expect(existsSync(artifact)).toBe(false);
    // The partial artifact was quarantined under docs/dev/archived/.
    const archivedDir = join(tempDir, 'docs/dev/archived');
    expect(existsSync(archivedDir)).toBe(true);
  });

  it('unauthenticated agy run: the LOOP quarantines the resolved implement-style artifact', async () => {
    // Seed an approved plan audit so the implement loop can start.
    const config = loadConfig(tempDir);
    const auditContent =
      '---\nloop: plan\nskill: plan-audit\nkind: audit\nrole: auditor\nversion: 1\n' +
      'agent: agy\nmodel: Gemini 3.5 Flash (Medium)\ntarget: docs/dev/plan.md\npriorAudit: none\n' +
      'timestamp: 2026-07-01T00:00:00.000Z\n---\n\n# Plan Audit\n\n## Verdict\n\nAPPROVED\n';
    writeFileSync(join(tempDir, 'docs/dev/plan-audit-v1-agy.md'), auditContent);

    registry.adapters.set('agy', makeFakeAgyAdapter({ authFail: true }));
    const implementSpec = config.manifest.loops['implement']!;

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 1,
      registry,
      output: mockOutput,
      globalOverrides: { agent: 'agy', model: 'Gemini 3.5 Flash (Medium)' }
    });

    expect(result.success).toBe(false);
    // Postcondition: the partial implement artifact was quarantined, not left resumable.
    const implArtifact = join(tempDir, 'docs/dev/impl-v1-agy.md');
    expect(existsSync(implArtifact)).toBe(false);
    expect(existsSync(join(tempDir, 'docs/dev/archived'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Env-gated REAL agy contract (AGY_CONTRACT=1). Skipped without credentials.
// ---------------------------------------------------------------------------
describe('Real-provider agy contract (AGY_CONTRACT=1)', () => {
  const tempDir = join(process.cwd(), 'temp-agy-real-contract');

  beforeEach(() => {
    createTempDir('temp-agy-real-contract');
    try {
      execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    } catch {
      // git optional for the real contract
    }
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Dummy AGENTS\n');
    writeFileSync(join(tempDir, 'README.md'), '# Dummy README\n');
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
  });
  afterEach(() => {
    removeTempDir(tempDir);
  });

  it.runIf(process.env['AGY_CONTRACT'] === '1')('exercises real agy spawn: writes artifact, lifecycle started→completed, APPROVED', async () => {
    const model = process.env['AGY_DEFAULT_MODEL'] || 'Gemini 3.5 Flash (Medium)';
    const outputPath = 'docs/dev/plan-audit-v1-agy.md';
    const prompt = `Write exactly the following content to the file "${outputPath}" and nothing else:\n## Verdict\nAPPROVED\n`;
    const lifecycleEvents: LifecycleEvent[] = [];

    const adapter = createAgyAdapter();
    const result = await adapter.run({
      prompt,
      model,
      cwd: tempDir,
      skillId: 'plan-audit',
      version: 1,
      onLifecycle: (e) => lifecycleEvents.push(e)
    });

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    const filePath = join(tempDir, outputPath);
    expect(existsSync(filePath)).toBe(true);
    expect(parseVerdict(readFileSync(filePath, 'utf-8'))).toBe('APPROVED');
    expect(lifecycleEvents[0]?.type).toBe('started');
    expect(lifecycleEvents[lifecycleEvents.length - 1]?.type).toBe('completed');
  }, 60000);

  it.runIf(process.env['AGY_CONTRACT'] === '1')('real agy run with a tiny configured timeout fails as error.kind timeout', async () => {
    const model = process.env['AGY_DEFAULT_MODEL'] || 'Gemini 3.5 Flash (Medium)';
    const lifecycleEvents: LifecycleEvent[] = [];
    const adapter = createAgyAdapter({ defaultTimeoutMs: 1000 });

    const result = await adapter.run({
      prompt: 'Write a very long essay about the history of computing, at least 5000 words, to stdout.',
      model,
      cwd: tempDir,
      skillId: 'plan-audit',
      version: 1,
      onLifecycle: (e) => lifecycleEvents.push(e)
    });

    expect(result.error?.kind).toBe('timeout');
    const failed = lifecycleEvents.find((e) => e.type === 'failed');
    expect(failed).toBeDefined();
    if (failed && failed.type === 'failed') {
      expect(failed.errorKind).toBe('timeout');
    }
  }, 60000);
});
