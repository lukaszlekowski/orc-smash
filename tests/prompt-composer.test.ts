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
    expect(prompt).toContain(`Target document: ${join(tempDir, 'docs/dev/plan.md')}`);
    expect(prompt).toContain('Audit version: 3');
    expect(prompt).toContain(`Prior audit (v2+): ${join(tempDir, 'docs/dev/plan-audit-v2-opencode.md')}`);
    expect(prompt).toContain(`Write your output to: ${join(tempDir, 'docs/dev/plan-audit-v3-opencode.md')}`);
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

    expect(prompt).toContain(`Write your output to: ${join(tempDir, 'docs/dev/plan-followup-v3-opencode.md')}`);
  });

  it('renders every implementation filesystem input as an absolute target-root path', () => {
    const loopSpec: LoopSpec = {
      kind: 'implement',
      target: '.',
      targetKind: 'worktree',
      planPath: 'docs/dev/plan.md',
      implement: '30-simple-implement',
      implementPattern: 'docs/dev/impl-v{n}-{agent}.md',
      inputs: [
        { label: 'Plan document', source: 'planPath' },
        { label: 'Target (working tree)', source: 'target' },
        { label: 'Approved audit (v1+)', source: 'priorAudit' },
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
        version: 1,
        priorAuditPath: join(tempDir, 'docs/dev/plan-audit-v10-codex.md'),
        agentName: 'agy',
        kind: 'implement'
      },
      tempDir
    );

    expect(prompt).toContain(`Plan document: ${join(tempDir, 'docs/dev/plan.md')}`);
    expect(prompt).toContain(`Target (working tree): ${tempDir}`);
    expect(prompt).toContain(`Approved audit (v1+): ${join(tempDir, 'docs/dev/plan-audit-v10-codex.md')}`);
    expect(prompt).toContain(`Write your output to: ${join(tempDir, 'docs/dev/impl-v1-agy.md')}`);
  });

  it('preserves the none sentinel for optional filesystem inputs', () => {
    const loopSpec: LoopSpec = {
      kind: 'code-review',
      target: '.',
      targetKind: 'worktree',
      planPath: 'docs/dev/plan.md',
      checklistPath: 'none',
      audit: 'review',
      'follow-up': 'review-follow-up',
      auditPattern: 'docs/dev/review-v{n}-{agent}.md',
      followUpPattern: 'docs/dev/review-followup-v{n}-{agent}.md',
      inputs: [
        { label: 'Feature checklist', source: 'checklistPath' },
        { label: 'Prior review', source: 'priorAudit' }
      ]
    };

    const prompt = composePrompt(
      'some-skill',
      'roles/auditor.md',
      'skills/some-skill/SKILL.md',
      loopSpec,
      { targetRoot: tempDir, version: 1, priorAuditPath: null, agentName: 'agy', kind: 'audit' },
      tempDir
    );

    expect(prompt).toContain('Feature checklist: none');
    expect(prompt).toContain('Prior review: none');
    expect(prompt).not.toContain(join(tempDir, 'none'));
  });

  it('explicitly authorizes the auditor to create the required audit artifact', () => {
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
        { label: 'Write your output to', source: 'outputPath' }
      ]
    };

    const prompt = composePrompt(
      'plan-audit',
      'roles/auditor.md',
      'skills/21-simple-plans-audit/SKILL.md',
      loopSpec,
      {
        targetRoot: tempDir,
        version: 1,
        priorAuditPath: null,
        agentName: 'codex',
        kind: 'audit'
      }
    );

    expect(prompt).toContain('Do not modify source code or the target plan document.');
    expect(prompt).toContain('explicitly authorized and required to create the audit document');
    expect(prompt).toContain('do not return it only in chat or stdout');
    expect(prompt).toContain(`Write your output to: ${join(tempDir, 'docs/dev/plan-audit-v1-codex.md')}`);
  });
});
