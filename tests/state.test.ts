import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scan } from '../src/state.js';
import { stampProvenance } from '../src/provenance.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('State Scanner', () => {
  const tempDir = join(process.cwd(), 'temp-state-test');

  beforeEach(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    mkdirSync(tempDir);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('detects fresh state (no audit files)', () => {
    const result = scan(tempDir, 'docs/dev/plan-audit-v{n}-{agent}.md');
    expect(result.latestVersion).toBe(0);
    expect(result.latestVerdict).toBeNull();
    expect(result.history).toHaveLength(0);
    expect(result.proposedNext).toEqual({
      skill: 'audit',
      version: 1,
      priorAuditPath: null
    });
  });

  it('detects restart from rejected state', () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });

    // Seed v1 audit as REJECTED
    const v1Path = join(devDir, 'plan-audit-v1-opencode.md');
    writeFileSync(
      v1Path,
      `# Plan Audit v1\n\n## Verdict\nREJECTED\n` + stampProvenance('opencode', 'opencode/deepseek-v4-flash', 1)
    );

    const result = scan(tempDir, 'docs/dev/plan-audit-v{n}-{agent}.md');
    expect(result.latestVersion).toBe(1);
    expect(result.latestVerdict).toBe('REJECTED');
    expect(result.history).toHaveLength(1);
    expect(result.proposedNext).toEqual({
      skill: 'follow-up',
      version: 2,
      priorAuditPath: v1Path
    });
  });

  it('detects APPROVED state', () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });

    // Seed v1 as REJECTED
    writeFileSync(
      join(devDir, 'plan-audit-v1-opencode.md'),
      `# Plan Audit v1\n\n## Verdict\nREJECTED\n` + stampProvenance('opencode', 'opencode/deepseek-v4-flash', 1)
    );

    // Seed v2 as APPROVED
    const v2Path = join(devDir, 'plan-audit-v2-codex.md');
    writeFileSync(
      v2Path,
      `# Plan Audit v2\n\n## Verdict\nAPPROVED\n` + stampProvenance('codex', 'gpt-5-codex', 2)
    );

    const result = scan(tempDir, 'docs/dev/plan-audit-v{n}-{agent}.md');
    expect(result.latestVersion).toBe(2);
    expect(result.latestVerdict).toBe('APPROVED');
    expect(result.proposedNext.skill).toBe('audit');
    expect(result.proposedNext.version).toBe(3);
    expect(result.proposedNext.priorAuditPath).toBe(v2Path);
  });

  it('ignores archived directory', () => {
    const devDir = join(tempDir, 'docs/dev');
    const archivedDir = join(devDir, 'archived');
    mkdirSync(archivedDir, { recursive: true });

    // Seed v1 as APPROVED inside archived/
    writeFileSync(
      join(archivedDir, 'plan-audit-v1-opencode.md'),
      `# Plan Audit v1\n\n## Verdict\nAPPROVED\n` + stampProvenance('opencode', 'opencode/deepseek-v4-flash', 1)
    );

    const result = scan(tempDir, 'docs/dev/plan-audit-v{n}-{agent}.md');
    expect(result.latestVersion).toBe(0);
    expect(result.history).toHaveLength(0);
  });
});
