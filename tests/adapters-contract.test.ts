import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';
import { execSync } from 'node:child_process';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import { codexAdapter, createCodexAdapter } from '../src/adapters/codex.js';
import { claudeAdapter, createClaudeAdapter } from '../src/adapters/claude.js';
import type { LifecycleEvent } from '../src/adapter-lifecycle.js';
import { parseVerdict } from '../src/verdict.js';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { createProductionAdapterRegistry } from '../src/adapters/registry.js';
import { isCompleteImplementLedger } from '../src/implement-ledger.js';

describe('Real-provider contract tests', () => {
  const tempDir = join(process.cwd(), 'temp-contract-test');

  beforeEach(() => {
    createTempDir('temp-contract-test');

    // Initialize git repository to keep coding agents relative to this test directory
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'ignore' });
    execSync('git config user.email "test@example.com"', { cwd: tempDir, stdio: 'ignore' });

    // Create dummy project authority files to bypass agent-specific preload rules
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Dummy AGENTS\n');
    writeFileSync(join(tempDir, 'CLAUDE.md'), '# Dummy CLAUDE\n');
    writeFileSync(join(tempDir, 'README.md'), '# Dummy README\n');

    execSync('git add AGENTS.md CLAUDE.md README.md', { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "initial"', { cwd: tempDir, stdio: 'ignore' });
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  describe('opencode', () => {
    it.runIf(process.env['OPENCODE_CONTRACT'] === '1')('spawn contract — lifecycle and file write', async () => {
      const model = process.env['OPENCODE_DEFAULT_MODEL'] || 'opencode-go/deepseek-v4-flash';
      const outputPath = 'docs/dev/plan-audit-v1-opencode.md';
      mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });

      const prompt = `Write exactly the following content to the file "${outputPath}" and nothing else:\n## Verdict\nAPPROVED\n`;

      const lifecycleEvents: LifecycleEvent[] = [];

      const result = await opencodeAdapter.run({
        prompt,
        model,
        cwd: tempDir,
        skillId: 'plan-audit',
        version: 1,
        onLifecycle: (e) => lifecycleEvents.push(e)
      });

      expect(result.error).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(typeof result.stdout).toBe('string');

      const filePath = join(tempDir, outputPath);
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(parseVerdict(content)).toBe('APPROVED');

      const messageEvents = lifecycleEvents.filter(e => e.type === 'message');
      expect(messageEvents.length).toBeGreaterThanOrEqual(1);
      const lastEvent = lifecycleEvents[lifecycleEvents.length - 1];
      expect(lastEvent?.type).toBe('completed');
    }, 60000);

    it.runIf(process.env['OPENCODE_CONTRACT'] === '1')('error contract — bad model returns server error', async () => {
      const model = 'opencode/deepseek-v4-flash';
      const result = await opencodeAdapter.run({
        prompt: 'return hi',
        model,
        cwd: tempDir
      });

      expect(result.error).toBeDefined();
      expect(result.error?.kind).toBe('server');
      expect(result.error?.ref).toBeDefined();
      expect(typeof result.stdout).toBe('string');
      expect(typeof result.exitCode).toBe('number');
    }, 60000);

    it.runIf(process.env['OPENCODE_CONTRACT'] === '1')('continuity contract — resumed session preserves id', async () => {
      const model = process.env['OPENCODE_DEFAULT_MODEL'] || 'opencode-go/deepseek-v4-flash';
      const outputPath1 = 'docs/dev/plan-audit-v1-opencode.md';
      const outputPath2 = 'docs/dev/plan-audit-v2-opencode.md';
      mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });

      const prompt1 = `Write exactly the following content to the file "${outputPath1}" and nothing else:\n## Verdict\nREJECTED\n\nAlso respond to me with "REJECTED".`;
      const result1 = await opencodeAdapter.run({
        prompt: prompt1,
        model,
        cwd: tempDir,
        skillId: 'plan-audit',
        version: 1,
        continuity: { mode: 'fresh' }
      });

      expect(result1.exitCode).toBe(0);
      expect(result1.sessionId).toBeDefined();
      expect(typeof result1.sessionId).toBe('string');
      expect(result1.sessionId!.length).toBeGreaterThan(0);
      expect(result1.stdout).toBeDefined();
      expect(typeof result1.stdout).toBe('string');

      const file1Path = join(tempDir, outputPath1);
      expect(existsSync(file1Path)).toBe(true);
      expect(parseVerdict(readFileSync(file1Path, 'utf-8'))).toBe('REJECTED');
      expect(parseVerdict(null, result1.stdout)).toBe('REJECTED');

      const prompt2 = `Write exactly the following content to the file "${outputPath2}" and nothing else:\n## Verdict\nAPPROVED\n\nAlso respond to me with "APPROVED".`;
      const result2 = await opencodeAdapter.run({
        prompt: prompt2,
        model,
        cwd: tempDir,
        skillId: 'plan-audit',
        version: 2,
        continuity: { mode: 'resumed', sessionId: result1.sessionId }
      });

      expect(result2.exitCode).toBe(0);
      expect(result2.sessionId).toBe(result1.sessionId);
      expect(result2.stdout).toBeDefined();
      expect(typeof result2.stdout).toBe('string');

      const file2Path = join(tempDir, outputPath2);
      expect(existsSync(file2Path)).toBe(true);
      expect(parseVerdict(readFileSync(file2Path, 'utf-8'))).toBe('APPROVED');
      expect(parseVerdict(null, result2.stdout)).toBe('APPROVED');
    }, 120000);
  });

  describe('codex', () => {
    it.runIf(process.env['CODEX_CONTRACT'] === '1')('spawn contract — lifecycle and file write', async () => {
      const model = process.env['CODEX_DEFAULT_MODEL'] || 'gpt-5.4-mini';
      const outputPath = 'docs/dev/plan-audit-v1-codex.md';
      mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });

      const prompt = `Write exactly the following content to the file "${outputPath}" and nothing else:\n## Verdict\nAPPROVED\n`;

      const lifecycleEvents: LifecycleEvent[] = [];

      const result = await codexAdapter.run({
        prompt,
        model,
        cwd: tempDir,
        skillId: 'plan-audit',
        version: 1,
        onLifecycle: (e) => lifecycleEvents.push(e)
      });

      expect(result.exitCode).toBe(0);

      const filePath = join(tempDir, outputPath);
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(parseVerdict(content)).toBe('APPROVED');

      expect(lifecycleEvents[0]?.type).toBe('started');
      expect(lifecycleEvents[lifecycleEvents.length - 1]?.type).toBe('completed');
      expect(lifecycleEvents.some(e => e.type === 'message')).toBe(false);
    }, 60000);

    it.runIf(process.env['CODEX_CONTRACT'] === '1')('continuity contract — resumed session preserves id', async () => {
      const model = process.env['CODEX_DEFAULT_MODEL'] || 'gpt-5.4-mini';
      const outputPath1 = 'docs/dev/plan-audit-v1-codex.md';
      const outputPath2 = 'docs/dev/plan-audit-v2-codex.md';
      mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });

      const prompt1 = `Write exactly the following content to the file "${outputPath1}" and nothing else:\n## Verdict\nREJECTED\n\nAlso respond to me with "REJECTED".`;
      const result1 = await codexAdapter.run({
        prompt: prompt1,
        model,
        cwd: tempDir,
        skillId: 'plan-audit',
        version: 1,
        continuity: { mode: 'fresh' }
      });

      expect(result1.exitCode).toBe(0);
      expect(result1.sessionId).toBeDefined();
      expect(typeof result1.sessionId).toBe('string');
      expect(result1.sessionId?.length).toBeGreaterThan(0);
      expect(result1.stdout).toBeDefined();
      expect(typeof result1.stdout).toBe('string');

      const file1Path = join(tempDir, outputPath1);
      expect(existsSync(file1Path)).toBe(true);
      expect(parseVerdict(readFileSync(file1Path, 'utf-8'))).toBe('REJECTED');
      expect(parseVerdict(null, result1.stdout)).toBe('REJECTED');

      const prompt2 = `Write exactly the following content to the file "${outputPath2}" and nothing else:\n## Verdict\nAPPROVED\n\nAlso respond to me with "APPROVED".`;
      const result2 = await codexAdapter.run({
        prompt: prompt2,
        model,
        cwd: tempDir,
        skillId: 'plan-audit',
        version: 2,
        continuity: { mode: 'resumed', sessionId: result1.sessionId }
      });

      expect(result2.exitCode).toBe(0);
      expect(result2.sessionId).toBe(result1.sessionId);
      expect(result2.stdout).toBeDefined();
      expect(typeof result2.stdout).toBe('string');

      const file2Path = join(tempDir, outputPath2);
      expect(existsSync(file2Path)).toBe(true);
      expect(parseVerdict(readFileSync(file2Path, 'utf-8'))).toBe('APPROVED');
      expect(parseVerdict(null, result2.stdout)).toBe('APPROVED');
      expect(parseVerdict(null, '')).toBe('unknown');
      expect(parseVerdict(null, 'GARBAGE')).toBe('unknown');
    }, 120000);
  });

  describe('claude', () => {
    it.runIf(process.env['CLAUDE_CONTRACT'] === '1')('spawn contract — lifecycle and file write', async () => {
      const model = process.env['CLAUDE_DEFAULT_MODEL'] || 'glm-4.7';
      const outputPath = 'docs/dev/plan-audit-v1-claude.md';
      mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });

      const prompt = `Write exactly the following content to the file "${outputPath}" and nothing else:\n## Verdict\nAPPROVED\n`;

      const lifecycleEvents: LifecycleEvent[] = [];

      const result = await claudeAdapter.run({
        prompt,
        model,
        cwd: tempDir,
        skillId: 'plan-audit',
        version: 1,
        onLifecycle: (e) => lifecycleEvents.push(e)
      });

      expect(result.exitCode).toBe(0);

      const filePath = join(tempDir, outputPath);
      expect(existsSync(filePath)).toBe(true);
      const content = readFileSync(filePath, 'utf-8');
      expect(parseVerdict(content)).toBe('APPROVED');

      expect(lifecycleEvents[0]?.type).toBe('started');
      expect(lifecycleEvents[lifecycleEvents.length - 1]?.type).toBe('completed');
      expect(lifecycleEvents.some(e => e.type === 'message')).toBe(false);
    }, 60000);

    it.runIf(process.env['CLAUDE_CONTRACT'] === '1')('continuity contract — resumed session preserves id', async () => {
      const model = process.env['CLAUDE_DEFAULT_MODEL'] || 'glm-4.7';
      const outputPath1 = 'docs/dev/plan-audit-v1-claude.md';
      const outputPath2 = 'docs/dev/plan-audit-v2-claude.md';
      mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });

      const prompt1 = `Write exactly the following content to the file "${outputPath1}" and nothing else:\n## Verdict\nREJECTED\n\nAlso respond to me with "REJECTED".`;
      const result1 = await claudeAdapter.run({
        prompt: prompt1,
        model,
        cwd: tempDir,
        skillId: 'plan-audit',
        version: 1,
        continuity: { mode: 'fresh' }
      });

      expect(result1.exitCode).toBe(0);
      expect(result1.sessionId).toBeDefined();
      expect(typeof result1.sessionId).toBe('string');
      expect(result1.sessionId!.length).toBeGreaterThan(0);
      expect(result1.stdout).toBeDefined();
      expect(typeof result1.stdout).toBe('string');

      const file1Path = join(tempDir, outputPath1);
      expect(existsSync(file1Path)).toBe(true);
      expect(parseVerdict(readFileSync(file1Path, 'utf-8'))).toBe('REJECTED');
      expect(parseVerdict(null, result1.stdout)).toBe('REJECTED');

      const prompt2 = `Write exactly the following content to the file "${outputPath2}" and nothing else:\n## Verdict\nAPPROVED\n\nAlso respond to me with "APPROVED".`;
      const result2 = await claudeAdapter.run({
        prompt: prompt2,
        model,
        cwd: tempDir,
        skillId: 'plan-audit',
        version: 2,
        continuity: { mode: 'resumed', sessionId: result1.sessionId }
      });

      expect(result2.exitCode).toBe(0);
      expect(result2.sessionId).toBe(result1.sessionId);
      expect(result2.stdout).toBeDefined();
      expect(typeof result2.stdout).toBe('string');

      const file2Path = join(tempDir, outputPath2);
      expect(existsSync(file2Path)).toBe(true);
      expect(parseVerdict(readFileSync(file2Path, 'utf-8'))).toBe('APPROVED');
      expect(parseVerdict(null, result2.stdout)).toBe('APPROVED');
    }, 120000);
  });

  const REAL_PROVIDER_IMPLEMENT_TIMEOUT_MS = 600000;

  const mockOutput = createMockOutput({
    warn: (msg: string) => { console.warn('LOOP WARN:', msg); },
    error: (msg: string) => { console.error('LOOP ERROR:', msg); }
  });

  async function runRealProviderImplementLoopTest(agent: string, model: string) {
    const outputPath = `docs/dev/impl-v1-${agent}.md`;
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });

    // Write a tiny approved plan fixture
    const planContent =
      '---\n' +
      'status: ready\n' +
      'confidence: 0.96\n' +
      'owners: harness-runtime\n' +
      '---\n\n' +
      '# Plan\n\n' +
      '## Step list\n\n' +
      '### Step 1\n' +
      `Write exactly the following content to the file "${outputPath}" and nothing else:\n` +
      '# Implementation Evidence Ledger\n\n' +
      '| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n' +
      '| --- | --- | --- | --- | --- |\n' +
      '| Step 1 | src/x.ts | pnpm test | pass | none |\n\n' +
      '| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n' +
      '| --- | --- | --- | --- |\n' +
      '| Req A | src/x.ts | tests/x.test.ts | pass |\n\n' +
      'State overall confidence: 0.95\n';

    writeFileSync(join(tempDir, 'docs/dev/plan.md'), planContent);

    // Write plan audit approved
    const auditContent =
      '---\n' +
      `loop: plan\n` +
      `skill: plan-audit\n` +
      `kind: audit\n` +
      `role: auditor\n` +
      `version: 1\n` +
      `agent: ${agent}\n` +
      `model: ${model}\n` +
      `target: docs/dev/plan.md\n` +
      `priorAudit: none\n` +
      `timestamp: 2026-06-30T12:00:00.000Z\n` +
      '---\n\n' +
      '# Plan Audit\n\n' +
      '## Verdict\n\n' +
      'APPROVED\n';
    writeFileSync(join(tempDir, `docs/dev/plan-audit-v1-${agent}.md`), auditContent);

    execSync(`git add -f docs/dev/plan.md docs/dev/plan-audit-v1-${agent}.md`, { cwd: tempDir, stdio: 'ignore' });
    execSync('git commit -m "add plan and audit"', { cwd: tempDir, stdio: 'ignore' });

    const config = loadConfig(tempDir);
    const implementSpec = config.manifest.loops['implement']!;

    const result = await runLoop(tempDir, 'implement', implementSpec, config, {}, {
      maxIterations: 1,
      registry: createProductionAdapterRegistry(config.registry),
      output: mockOutput,
      globalOverrides: { agent, model }
    });
    if (!result.success) {
      console.error('RUN_LOOP FAILED:', result.message);
      const filePath = join(tempDir, outputPath);
      if (existsSync(filePath)) {
        console.error('FILE CONTENT:\n', readFileSync(filePath, 'utf-8'));
      } else {
        console.error('FILE DOES NOT EXIST');
      }
    }
    expect(result.success).toBe(true);
    expect(result.lastAuditPath).toContain(outputPath);

    const filePath = join(tempDir, outputPath);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');

    // Verify provenance and ledger verification standards
    expect(content.startsWith('---\nloop:')).toBe(true);
    expect(content).toContain(`priorAudit: docs/dev/plan-audit-v1-${agent}.md`);
    // Pass the actual content past front matter to ledger verification
    const bodyWithoutFrontMatter = content.replace(/^---[\s\S]+?---\r?\n/, '');
    expect(isCompleteImplementLedger(bodyWithoutFrontMatter)).toBe(true);

    // Verify plan status closeout
    const updatedPlan = readFileSync(join(tempDir, 'docs/dev/plan.md'), 'utf-8');
    expect(updatedPlan).toMatch(/^status:\s*done\s*$/m);
    expect(updatedPlan).toMatch(/## Change Log/);
    expect(updatedPlan).toMatch(new RegExp(`### Implementation v1-${agent}`));

    // Verify implement artifact has been properly created with provenance
    const implContent2 = readFileSync(filePath, 'utf-8');
    expect(implContent2.startsWith('---\nloop:')).toBe(true);
    expect(implContent2).toContain(`priorAudit: docs/dev/plan-audit-v1-${agent}.md`);
  }

  describe('implement loop', () => {
    it.runIf(process.env['OPENCODE_CONTRACT'] === '1')('opencode — ledger writing and closeout', async () => {
      const model = process.env['OPENCODE_DEFAULT_MODEL'] || 'opencode-go/deepseek-v4-flash';
      await runRealProviderImplementLoopTest('opencode', model);
    }, REAL_PROVIDER_IMPLEMENT_TIMEOUT_MS);

    it.runIf(process.env['CODEX_CONTRACT'] === '1')('codex — ledger writing and closeout', async () => {
      const model = process.env['CODEX_DEFAULT_MODEL'] || 'gpt-5.4-mini';
      await runRealProviderImplementLoopTest('codex', model);
    }, REAL_PROVIDER_IMPLEMENT_TIMEOUT_MS);

    it.runIf(process.env['CLAUDE_CONTRACT'] === '1')('claude — ledger writing and closeout', async () => {
      const model = process.env['CLAUDE_DEFAULT_MODEL'] || 'glm-4.7';
      await runRealProviderImplementLoopTest('claude', model);
    }, REAL_PROVIDER_IMPLEMENT_TIMEOUT_MS);
  });

  // ---------------------------------------------------------------------
  // Watchdog timeout proof (§1): a real codex/claude run with a tiny
  // configured timeout must fail as error.kind === 'timeout' and emit the
  // failed lifecycle event — proving timeouts.codex / timeouts.claude are
  // live through the production registry-to-adapter-to-run path, not inert.
  // ---------------------------------------------------------------------
  async function runRealProviderTimeoutTest(agent: 'codex' | 'claude', model: string) {
    const lifecycleEvents: LifecycleEvent[] = [];
    const adapter = agent === 'codex'
      ? createCodexAdapter({ defaultTimeoutMs: 1000 })
      : createClaudeAdapter({ defaultTimeoutMs: 1000 });

    const result = await adapter.run({
      // Deliberately long-running prompt so the watchdog deadline fires first.
      prompt: 'Write a very long essay about the history of computing, at least 5000 words, to stdout.',
      model,
      cwd: tempDir,
      skillId: 'plan-audit',
      version: 1,
      onLifecycle: (e) => lifecycleEvents.push(e)
    });

    expect(result.error?.kind).toBe('timeout');
    const failed = lifecycleEvents.find(e => e.type === 'failed');
    expect(failed).toBeDefined();
    if (failed && failed.type === 'failed') {
      expect(failed.errorKind).toBe('timeout');
    }
  }

  describe('timeouts', () => {
    it.runIf(process.env['CODEX_CONTRACT'] === '1')('codex — tiny configured timeout fails as error.kind timeout', async () => {
      const model = process.env['CODEX_DEFAULT_MODEL'] || 'gpt-5.4-mini';
      await runRealProviderTimeoutTest('codex', model);
    }, 60000);

    it.runIf(process.env['CLAUDE_CONTRACT'] === '1')('claude — tiny configured timeout fails as error.kind timeout', async () => {
      const model = process.env['CLAUDE_DEFAULT_MODEL'] || 'glm-4.7';
      await runRealProviderTimeoutTest('claude', model);
    }, 60000);
  });
});
