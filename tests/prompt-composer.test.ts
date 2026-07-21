import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { composePrompt } from '../src/prompt-composer.js';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { InputSpec } from '../src/manifest.js';

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

  const auditInputs: InputSpec[] = [
    { label: 'Target document', source: 'target' },
    { label: 'Audit version', source: 'version' },
    { label: 'Prior audit (v2+)', source: 'priorArtifact' },
    { label: 'Output path', source: 'outputPath' }
  ];

  it('correctly assembles role, skill, and inputs for audit kind', () => {
    const prompt = composePrompt(
      'some-skill',
      'roles/auditor.md',
      'skills/some-skill/SKILL.md',
      auditInputs,
      {
        projectRoot: tempDir,
        target: { path: 'docs/dev/plan.md', kind: 'file' },
        version: 3,
        provider: 'opencode',
        priorArtifact: { path: join(tempDir, 'docs/dev/plan-audit-v2-opencode.md'), artifactIdentity: 'v2-audit', contentDigest: 'abc' },
        outputPattern: 'docs/dev/plan-audit-v{version}-{provider}.md',
      },
      tempDir
    );

    expect(prompt).toContain('# Role\nRole: Auditor instructions here.');
    expect(prompt).toContain('# Skill: some-skill\nSkill: Skill instructions here.');
    expect(prompt).toContain('# Inputs');
    expect(prompt).toContain(`Target document: ${join(tempDir, 'docs/dev/plan.md')}`);
    expect(prompt).toContain('Audit version: 3');
    expect(prompt).toContain(`Prior audit (v2+): ${join(tempDir, 'docs/dev/plan-audit-v2-opencode.md')}`);
    expect(prompt).toContain(`Output path: ${join(tempDir, 'docs/dev/plan-audit-v3-opencode.md')}`);
  });

  it('correctly assembles role, skill, and inputs for follow-up kind', () => {
    const prompt = composePrompt(
      'some-skill',
      'roles/auditor.md',
      'skills/some-skill/SKILL.md',
      auditInputs,
      {
        projectRoot: tempDir,
        target: { path: 'docs/dev/plan.md', kind: 'file' },
        version: 3,
        provider: 'opencode',
        priorArtifact: { path: join(tempDir, 'docs/dev/plan-audit-v2-opencode.md'), artifactIdentity: 'v2-audit', contentDigest: 'abc' },
        outputPattern: 'docs/dev/plan-followup-v{version}-{provider}.md',
      },
      tempDir
    );

    expect(prompt).toContain(`Output path: ${join(tempDir, 'docs/dev/plan-followup-v3-opencode.md')}`);
  });

  it('renders every implementation filesystem input as an absolute target-root path', () => {
    const implInputs: InputSpec[] = [
      { label: 'Plan document', source: 'planPath' },
      { label: 'Target (working tree)', source: 'target' },
      { label: 'Approved audit (v1+)', source: 'priorArtifact' },
      { label: 'Output path', source: 'outputPath' }
    ];

    const prompt = composePrompt(
      'some-skill',
      'roles/auditor.md',
      'skills/some-skill/SKILL.md',
      implInputs,
      {
        projectRoot: tempDir,
        target: { path: '.', kind: 'worktree' },
        version: 1,
        provider: 'agy',
        priorArtifact: { path: join(tempDir, 'docs/dev/plan-audit-v10-codex.md'), artifactIdentity: 'v10-audit', contentDigest: 'xyz' },
        outputPattern: 'docs/dev/impl-v{version}-{provider}.md',
        files: { planPath: 'docs/dev/plan.md' },
      },
      tempDir
    );

    expect(prompt).toContain(`Plan document: ${join(tempDir, 'docs/dev/plan.md')}`);
    expect(prompt).toContain(`Target (working tree): ${tempDir}`);
    expect(prompt).toContain(`Approved audit (v1+): ${join(tempDir, 'docs/dev/plan-audit-v10-codex.md')}`);
    expect(prompt).toContain(`Output path: ${join(tempDir, 'docs/dev/impl-v1-agy.md')}`);
  });

  it('preserves the none sentinel for optional filesystem inputs', () => {
    const reviewInputs: InputSpec[] = [
      { label: 'Feature checklist', source: 'checklistPath' },
      { label: 'Prior review', source: 'priorArtifact' }
    ];

    const prompt = composePrompt(
      'some-skill',
      'roles/auditor.md',
      'skills/some-skill/SKILL.md',
      reviewInputs,
      {
        projectRoot: tempDir,
        target: { path: '.', kind: 'worktree' },
        version: 1,
        provider: 'agy',
        priorArtifact: { kind: 'none' },
        outputPattern: 'docs/dev/review-v{version}-{provider}.md',
        files: { checklistPath: 'none' },
      },
      tempDir
    );

    expect(prompt).toContain('Feature checklist: none');
    expect(prompt).toContain('Prior review: none');
    expect(prompt).not.toContain(join(tempDir, 'none'));
  });

  it('explicitly authorizes the auditor to create the required audit artifact', () => {
    const authInputs: InputSpec[] = [
      { label: 'Target document', source: 'target' },
      { label: 'Output path', source: 'outputPath' }
    ];

    const prompt = composePrompt(
      'plan-audit',
      'roles/auditor.md',
      'skills/21-simple-plans-audit/SKILL.md',
      authInputs,
      {
        projectRoot: tempDir,
        target: { path: 'docs/dev/plan.md', kind: 'file' },
        version: 1,
        provider: 'codex',
        priorArtifact: { kind: 'none' },
        outputPattern: 'docs/dev/plan-audit-v{version}-{provider}.md',
      },
      process.cwd()
    );

    expect(prompt).toContain('Do not modify source code or the target plan document.');
    expect(prompt).toContain('explicitly authorized and required to create the audit document');
    expect(prompt).toContain('do not return it only in chat or stdout');
    expect(prompt).toContain(`Output path: ${join(tempDir, 'docs/dev/plan-audit-v1-codex.md')}`);
  });
});
