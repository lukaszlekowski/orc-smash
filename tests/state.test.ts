import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scan, resolveApprovedPlanAuditPath, requireApprovedPlanAuditPath, scanForStatus, getLatestSessionId } from '../src/state.js';
import { buildFrontMatter, type ArtifactMeta } from '../src/provenance.js';
import { renderFollowUpOutcomeSection, parseFollowUpOutcome } from '../src/follow-up-outcome.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeInterruptedMarker } from '../src/interrupted-artifact.js';
import { loadConfig } from '../src/config.js';

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
      buildFrontMatter(metaF) + `# Plan Follow-up\n\n${renderFollowUpOutcomeSection('patched')}\n`
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
      buildFrontMatter(metaF) + `# Plan Follow-up\n\n${renderFollowUpOutcomeSection('patched')}\n`
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

describe('Follow-up Outcome Contract', () => {
  it('correctly parses outcome from content', () => {
    expect(parseFollowUpOutcome('## Follow-up Outcome\npatched')).toBe('patched');
    expect(parseFollowUpOutcome('## Follow-up Outcome\n\npatched')).toBe('patched');
    expect(parseFollowUpOutcome('## Follow-up Outcome\nblocked')).toBe('blocked');
    expect(parseFollowUpOutcome('## Follow-up Outcome\n\nblocked')).toBe('blocked');
    expect(parseFollowUpOutcome('some other content')).toBe('patched'); // default
  });

  it('renders section canonical output', () => {
    expect(renderFollowUpOutcomeSection('patched')).toBe('## Follow-up Outcome\n\npatched');
    expect(renderFollowUpOutcomeSection('blocked')).toBe('## Follow-up Outcome\n\nblocked');
  });
});

describe('State-owner approved path resolution', () => {
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

  it('resolves path when plan is APPROVED', () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });
    const meta: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 1, agent: 'fake', model: 'fake-model',
      target: 'docs/dev/plan.md', priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-fake.md'),
      buildFrontMatter(meta) + `# Plan Audit\n\n## Verdict\nAPPROVED\n`
    );

    const path = resolveApprovedPlanAuditPath(tempDir, patterns);
    expect(path).toContain('plan-audit-v1-fake.md');

    const reqPath = requireApprovedPlanAuditPath(tempDir, patterns);
    expect(reqPath).toContain('plan-audit-v1-fake.md');
  });

  it('stale approved plan regression: latest v2 is REJECTED makes approval resolve to null and require throw', () => {
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });

    // Seed v1 APPROVED
    const meta1: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 1, agent: 'fake', model: 'fake-model',
      target: 'docs/dev/plan.md', priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-fake.md'),
      buildFrontMatter(meta1) + `# Plan Audit\n\n## Verdict\nAPPROVED\n`
    );

    // Seed v2 REJECTED
    const meta2: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 2, agent: 'fake', model: 'fake-model',
      target: 'docs/dev/plan.md', priorAudit: 'docs/dev/plan-audit-v1-fake.md', timestamp: '2026-06-26T20:10:00.000Z'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v2-fake.md'),
      buildFrontMatter(meta2) + `# Plan Audit\n\n## Verdict\nREJECTED\n`
    );

    const path = resolveApprovedPlanAuditPath(tempDir, patterns);
    expect(path).toBeNull();

    expect(() => {
      requireApprovedPlanAuditPath(tempDir, patterns);
    }).toThrow(/No approved plan audit found/);
  });
});

describe('scanForStatus — display-only interrupted scan (§3)', () => {
  const tempDir = join(process.cwd(), 'temp-state-status-scan');

  beforeEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(join(tempDir, 'docs/dev'), { recursive: true });
  });
  afterEach(() => {
    if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
  });

  function manifest() {
    return loadConfig(tempDir).manifest;
  }

  it('decision-path scan() never includes a synthetic interrupted step', () => {
    // A partial artifact + marker exist, but scan() (the decision path) must
    // report only filesystem facts — never a synthesized interrupted step.
    writeFileSync(join(tempDir, 'docs/dev/plan-audit-v3-codex.md'), '# partial\n');
    writeInterruptedMarker(tempDir, {
      loop: 'plan', kind: 'audit', version: 3, agent: 'codex', model: 'gpt-5.4',
      skillId: 'plan-audit', interruptedAtMs: 123
    });
    const result = scan(tempDir, {
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    });
    expect(result.timeline.every((s) => s.status !== 'interrupted')).toBe(true);
  });

  it('scanForStatus synthesizes the interrupted step for the matching loop', () => {
    writeInterruptedMarker(tempDir, {
      loop: 'plan', kind: 'audit', version: 3, agent: 'codex', model: 'gpt-5.4',
      skillId: 'plan-audit', interruptedAtMs: 123
    });
    const m = manifest();
    const result = scanForStatus(tempDir, 'plan', m.loops['plan']!, m);
    expect(result.interruptedStep).not.toBeNull();
    expect(result.interruptedStep!.status).toBe('interrupted');
    expect(result.interruptedStep!.kind).toBe('audit');
    expect(result.timeline.some((s) => s.status === 'interrupted')).toBe(true);
  });

  it('scanForStatus suppresses the matching partial artifact row (one interrupted step, not a duplicate)', () => {
    // Partial artifact at the marker's resolved path, plus the marker.
    const partialPath = join(tempDir, 'docs/dev/plan-audit-v3-codex.md');
    writeFileSync(partialPath, '# partial\n');
    writeInterruptedMarker(tempDir, {
      loop: 'plan', kind: 'audit', version: 3, agent: 'codex', model: 'gpt-5.4',
      skillId: 'plan-audit', interruptedAtMs: 123
    });
    const m = manifest();
    const result = scanForStatus(tempDir, 'plan', m.loops['plan']!, m);
    // Exactly one row for that artifact path — the interrupted step — and no
    // duplicate 'done'/'unknown' row for the partial.
    const rowsForPath = result.timeline.filter((s) => s.artifactPath === partialPath);
    expect(rowsForPath).toHaveLength(1);
    expect(rowsForPath[0]!.status).toBe('interrupted');
  });

  it('scanForStatus returns no interrupted step when the marker is for a different loop', () => {
    writeInterruptedMarker(tempDir, {
      loop: 'review', kind: 'audit', version: 1, agent: 'codex', model: 'gpt-5.4',
      skillId: 'review', interruptedAtMs: 123
    });
    const m = manifest();
    const result = scanForStatus(tempDir, 'plan', m.loops['plan']!, m);
    expect(result.interruptedStep).toBeNull();
  });

  it('scanForStatus returns no interrupted step when no marker exists', () => {
    const m = manifest();
    const result = scanForStatus(tempDir, 'plan', m.loops['plan']!, m);
    expect(result.interruptedStep).toBeNull();
  });

  it('getLatestSessionId returns the latest session ID or none', () => {
    const patterns = {
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md'
    };
    // 1. empty state
    expect(getLatestSessionId(tempDir, patterns)).toBe('none');

    // 2. non-codex audit
    const devDir = join(tempDir, 'docs/dev');
    mkdirSync(devDir, { recursive: true });
    const metaOpencode: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 1, agent: 'opencode', model: 'deepseek-v4-flash',
      target: 'docs/dev/plan.md', priorAudit: 'none', timestamp: '2026-06-26T20:00:00.000Z'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v1-opencode.md'),
      buildFrontMatter(metaOpencode) + `## Verdict\nREJECTED\n`
    );
    expect(getLatestSessionId(tempDir, patterns)).toBe('none');

    // 3. codex audit with session Mode/id
    const metaCodex: ArtifactMeta = {
      loop: 'plan', skill: 'plan-audit', kind: 'audit', role: 'auditor',
      version: 2, agent: 'codex', model: 'gpt-5-codex',
      target: 'docs/dev/plan.md', priorAudit: 'docs/dev/plan-audit-v1-opencode.md', timestamp: '2026-06-26T20:10:00.000Z',
      sessionMode: 'fresh', sessionId: 'sess_codex123'
    };
    writeFileSync(
      join(devDir, 'plan-audit-v2-codex.md'),
      buildFrontMatter(metaCodex) + `## Verdict\nREJECTED\n`
    );
    expect(getLatestSessionId(tempDir, patterns)).toBe('sess_codex123');
  });
});
