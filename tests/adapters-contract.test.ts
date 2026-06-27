import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { opencodeAdapter } from '../src/adapters/opencode.js';
import { codexAdapter } from '../src/adapters/codex.js';
import { claudeAdapter } from '../src/adapters/claude.js';
import { parseVerdict } from '../src/verdict.js';

describe('Real-provider contract tests', () => {
  const tempDir = join(process.cwd(), 'temp-contract-test');

  beforeEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    mkdirSync(tempDir, { recursive: true });

    // Initialize git repository to keep coding agents relative to this test directory
    execSync('git init', { cwd: tempDir, stdio: 'ignore' });

    // Create dummy project authority files to bypass agent-specific preload rules
    writeFileSync(join(tempDir, 'AGENTS.md'), '# Dummy AGENTS\n');
    writeFileSync(join(tempDir, 'CLAUDE.md'), '# Dummy CLAUDE\n');
    writeFileSync(join(tempDir, 'README.md'), '# Dummy README\n');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.runIf(process.env['OPENCODE_CONTRACT'] === '1')('exercises real opencode spawn', async () => {
    const model = process.env['OPENCODE_DEFAULT_MODEL'] || 'opencode-go/deepseek-v4-flash';
    const outputPath = 'docs/dev/plan-audit-v1-opencode.md';
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });

    const prompt = `Write exactly the following content to the file "${outputPath}" and nothing else:\n## Verdict\nAPPROVED\n`;

    const result = await opencodeAdapter.run({
      prompt,
      model,
      cwd: tempDir
    });

    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(typeof result.stdout).toBe('string');

    const filePath = join(tempDir, outputPath);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(parseVerdict(content)).toBe('APPROVED');
  }, 60000);

  it.runIf(process.env['OPENCODE_CONTRACT'] === '1')('exercises real opencode error path', async () => {
    // Known bad model that should prompt server error immediately
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
    // Note: The actual exit code for bad model is recorded here
    expect(typeof result.exitCode).toBe('number');
  }, 60000);

  it.runIf(process.env['CODEX_CONTRACT'] === '1')('exercises real codex spawn', async () => {
    const model = process.env['CODEX_DEFAULT_MODEL'] || 'gpt-5.4';
    const outputPath = 'docs/dev/plan-audit-v1-codex.md';
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });

    const prompt = `Write exactly the following content to the file "${outputPath}" and nothing else:\n## Verdict\nAPPROVED\n`;

    const result = await codexAdapter.run({
      prompt,
      model,
      cwd: tempDir
    });

    expect(result.exitCode).toBe(0);

    const filePath = join(tempDir, outputPath);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(parseVerdict(content)).toBe('APPROVED');
  }, 60000);

  it.runIf(process.env['CLAUDE_CONTRACT'] === '1')('exercises real claude spawn', async () => {
    const model = process.env['CLAUDE_DEFAULT_MODEL'] || 'claude-sonnet-4-6';
    const outputPath = 'docs/dev/plan-audit-v1-claude.md';
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });

    const prompt = `Write exactly the following content to the file "${outputPath}" and nothing else:\n## Verdict\nAPPROVED\n`;

    const result = await claudeAdapter.run({
      prompt,
      model,
      cwd: tempDir
    });

    expect(result.exitCode).toBe(0);

    const filePath = join(tempDir, outputPath);
    expect(existsSync(filePath)).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(parseVerdict(content)).toBe('APPROVED');
  }, 60000);
});
