import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { composePrompt } from '../src/prompt-composer.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { LoopSpec } from '../src/manifest.js';

describe('Prompt Composer', () => {
  const tempDir = join(process.cwd(), 'temp-prompt-composer-test');

  beforeEach(() => {
    if (!existsSync(tempDir)) {
      mkdirSync(tempDir);
    }
    mkdirSync(join(tempDir, 'roles'), { recursive: true });
    mkdirSync(join(tempDir, 'skills/some-skill'), { recursive: true });

    writeFileSync(join(tempDir, 'roles/auditor.md'), 'Role: Auditor instructions here.');
    writeFileSync(join(tempDir, 'skills/some-skill/SKILL.md'), 'Skill: Skill instructions here.');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('correctly assembles role, skill, and inputs for audit kind', () => {
    const loopSpec: LoopSpec = {
      kind: 'doc-audit',
      target: 'docs/dev/plan.md',
      targetKind: 'file',
      audit: 'plan-audit',
      'follow-up': 'plan-follow-up',
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md',
      inputs: [
        { label: 'Target document', source: 'target' },
        { label: 'Audit version', source: 'version' },
        { label: 'Prior audit (v2+)', source: 'priorAudit' },
        { label: 'Write your output to', source: 'outputPath' }
      ]
    };

    const prompt = composePrompt(
      'some-skill',
      'roles/auditor.md',
      'skills/some-skill/SKILL.md',
      loopSpec,
      {
        targetRoot: tempDir,
        version: 3,
        priorAuditPath: join(tempDir, 'docs/dev/plan-audit-v2-opencode.md'),
        agentName: 'opencode',
        kind: 'audit'
      },
      tempDir
    );

    expect(prompt).toContain('# Role\nRole: Auditor instructions here.');
    expect(prompt).toContain('# Skill: some-skill\nSkill: Skill instructions here.');
    expect(prompt).toContain('# Inputs');
    expect(prompt).toContain('Target document: docs/dev/plan.md');
    expect(prompt).toContain('Audit version: 3');
    expect(prompt).toContain('Prior audit (v2+): docs/dev/plan-audit-v2-opencode.md');
    expect(prompt).toContain('Write your output to: docs/dev/plan-audit-v3-opencode.md');
  });

  it('correctly assembles role, skill, and inputs for follow-up kind', () => {
    const loopSpec: LoopSpec = {
      kind: 'doc-audit',
      target: 'docs/dev/plan.md',
      targetKind: 'file',
      audit: 'plan-audit',
      'follow-up': 'plan-follow-up',
      auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md',
      inputs: [
        { label: 'Target document', source: 'target' },
        { label: 'Audit version', source: 'version' },
        { label: 'Prior audit (v2+)', source: 'priorAudit' },
        { label: 'Write your output to', source: 'outputPath' }
      ]
    };

    const prompt = composePrompt(
      'some-skill',
      'roles/auditor.md',
      'skills/some-skill/SKILL.md',
      loopSpec,
      {
        targetRoot: tempDir,
        version: 3,
        priorAuditPath: join(tempDir, 'docs/dev/plan-audit-v2-opencode.md'),
        agentName: 'opencode',
        kind: 'follow-up'
      },
      tempDir
    );

    expect(prompt).toContain('Write your output to: docs/dev/plan-followup-v3-opencode.md');
  });
});
