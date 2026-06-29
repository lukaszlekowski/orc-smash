import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scan } from '../src/state.js';
import { buildFrontMatter, type ArtifactMeta } from '../src/provenance.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('State Scanner', () => {
  const tempDir = join(process.cwd(), 'temp-state-test');
  const auditPattern = 'docs/dev/plan-audit-v{n}-{agent}.md';
  const followUpPattern = 'docs/dev/plan-followup-v{n}-{agent}.md';
  const patterns = { auditPattern, followUpPattern };

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
    const result = scan(tempDir, patterns);
    expect(result.latestVersion).toBe(0);
    expect(result.latestVerdict).toBeNull();
    expect(result.timeline).toHaveLength(0);
    expect(result.auditSteps).toHaveLength(0);
    // state.ts is now a fact-scanning module; the next-step decision derived from
    // these facts is asserted canonically in tests/next-step.test.ts.
  });

  it('detects restart from rejected state', () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });

    // Seed v1 audit as REJECTED
    const v1Path = join(devDir, 'plan-audit-v1-opencode.md');
    const meta: ArtifactMeta = {
      loop: 'plan',
      skill: 'plan-audit',
      kind: 'audit',
      role: 'auditor',
      version: 1,
      agent: 'opencode',
      model: 'deepseek-v4-flash',
      target: 'docs/dev/plan.md',
      priorAudit: 'none',
      timestamp: '2026-06-26T20:00:00.000Z'
    };
    writeFileSync(
      v1Path,
      buildFrontMatter(meta) + `# Plan Audit v1\n\n## Verdict\nREJECTED\n`
    );

    const result = scan(tempDir, patterns);
    expect(result.latestVersion).toBe(1);
    expect(result.latestVerdict).toBe('REJECTED');
    expect(result.timeline).toHaveLength(1);
    expect(result.auditSteps).toHaveLength(1);
    // latest audit path feeds resolveNextStep; the follow-up-version decision
    // itself is asserted in tests/next-step.test.ts.
    expect(result.auditSteps[0]?.artifactPath).toBe(v1Path);
  });

  it('detects APPROVED state', () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });

    // Seed v1 as REJECTED
    const meta1: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 1, agent: 'opencode', model: 'deepseek-v4-flash',
      target: 'docs/dev/plan.md', priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-opencode.md'),
      buildFrontMatter(meta1) + `# Plan Audit v1\n\n## Verdict\nREJECTED\n`
    );

    // Seed v2 as APPROVED
    const v2Path = join(devDir, 'plan-audit-v2-codex.md');
    const meta2: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 2, agent: 'codex', model: 'gpt-5-codex',
      target: 'docs/dev/plan.md', priorAudit: 'docs/dev/plan-audit-v1-opencode.md', timestamp: '2026-06-26T20:10:00.000Z'
    };
    writeFileSync(
      v2Path,
      buildFrontMatter(meta2) + `# Plan Audit v2\n\n## Verdict\nAPPROVED\n`
    );

    const result = scan(tempDir, patterns);
    expect(result.latestVersion).toBe(2);
    expect(result.latestVerdict).toBe('APPROVED');
    // canonical next-round decision (next audit = v3) is asserted in
    // tests/next-step.test.ts; here we assert the scanned facts + latest path.
    expect(result.auditSteps[result.auditSteps.length - 1]?.artifactPath).toBe(v2Path);
  });

  it('ignores archived directory', () => {
    const devDir = join(tempDir, 'docs/dev');
    const archivedDir = join(devDir, 'archived');
    mkdirSync(archivedDir, { recursive: true });

    // Seed v1 as APPROVED inside archived/
    const meta: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 1, agent: 'opencode', model: 'deepseek-v4-flash',
      target: 'docs/dev/plan.md', priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z'
    };
    writeFileSync(
      join(archivedDir, 'plan-audit-v1-opencode.md'),
      buildFrontMatter(meta) + `# Plan Audit v1\n\n## Verdict\nAPPROVED\n`
    );

    const result = scan(tempDir, patterns);
    expect(result.latestVersion).toBe(0);
    expect(result.timeline).toHaveLength(0);
  });

  it('correctly handles follow-up files (item-1 regression)', () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });

    // Seed v1 audit as REJECTED
    const meta1: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 1, agent: 'opencode', model: 'deepseek-v4-flash',
      target: 'docs/dev/plan.md', priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-opencode.md'),
      buildFrontMatter(meta1) + `# Plan Audit v1\n\n## Verdict\nREJECTED\n`
    );

    // Seed v1 follow-up file (no verdict)
    const metaF: ArtifactMeta = {
      loop: 'plan', skill: 'plan-follow-up', kind: 'follow-up', role: 'planner',
      version: 1, agent: 'fake', model: 'fake-model',
      target: 'docs/dev/plan.md', priorAudit: 'docs/dev/plan-audit-v1-opencode.md', timestamp: '2026-06-26T20:05:00.000Z'
    };
    writeFileSync(
      join(devDir, 'plan-followup-v1-fake.md'),
      buildFrontMatter(metaF) + `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`
    );

    const result = scan(tempDir, patterns);
    expect(result.latestVerdict).toBe('REJECTED'); // unchanged, follow-up verdict-less file doesn't affect it
    expect(result.timeline).toHaveLength(2);
    expect(result.auditSteps).toHaveLength(1);
    expect(result.timeline[0]?.kind).toBe('audit');
    expect(result.timeline[1]?.kind).toBe('follow-up');
  });

  it('stray follow-up never flips verdict to unknown', () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });

    // Seed v1 audit as APPROVED
    const meta1: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 1, agent: 'opencode', model: 'deepseek-v4-flash',
      target: 'docs/dev/plan.md', priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-opencode.md'),
      buildFrontMatter(meta1) + `# Plan Audit v1\n\n## Verdict\nAPPROVED\n`
    );

    // Seed a stray v2 follow-up (no verdict)
    const metaF: ArtifactMeta = {
      loop: 'plan', skill: 'plan-follow-up', kind: 'follow-up', role: 'planner',
      version: 2, agent: 'fake', model: 'fake-model',
      target: 'docs/dev/plan.md', priorAudit: 'docs/dev/plan-audit-v1-opencode.md', timestamp: '2026-06-26T20:05:00.000Z'
    };
    writeFileSync(
      join(devDir, 'plan-followup-v2-fake.md'),
      buildFrontMatter(metaF) + `# Plan Follow-up\n\n## Follow-up Outcome\npatched\n`
    );

    const result = scan(tempDir, patterns);
    expect(result.latestVerdict).toBe('APPROVED'); // still APPROVED
  });

  it('parses front matter + verdict consistently from a single read (Step 3 regression)', () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });

    const meta: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 1, agent: 'codex', model: 'gpt-5-codex',
      target: 'docs/dev/plan.md', priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-codex.md'),
      buildFrontMatter(meta) + `# Plan Audit v1\n\n## Verdict\nREJECTED\n`
    );

    const result = scan(tempDir, patterns);
    expect(result.auditSteps).toHaveLength(1);
    const step = result.auditSteps[0]!;
    // Enriched from front matter (metadata fallback works for generated artifacts)...
    expect(step.role).toBe('auditor');
    expect(step.agent).toBe('codex');
    expect(step.model).toBe('gpt-5-codex');
    // ...and the verdict is parsed from the same single read.
    expect(step.verdict).toBe('REJECTED');
    expect(step.version).toBe(1);
  });
});
