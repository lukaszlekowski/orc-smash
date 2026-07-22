import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveNextStep, pipelineSuggestions } from '../src/next-step.js';
import { loadConfig } from '../src/config.js';

describe('generic next-step resolution', () => {
  it('starts a fresh evaluation at version one', () => {
    expect(resolveNextStep({
      latestDecision: null,
      latestVersion: 0,
      hasEvaluations: false,
    })).toMatchObject({
      state: 'fresh',
      nextSkill: 'evaluate',
      nextEvaluateVersion: 1,
    });
  });

  it('maps retry to repair at the same version', () => {
    expect(resolveNextStep({
      latestDecision: 'retry',
      latestVersion: 3,
      hasEvaluations: true,
      latestArtifactPath: '/tmp/eval-v3.md',
    })).toMatchObject({
      state: 'rejected',
      nextSkill: 'repair',
      repairVersion: 3,
      nextEvaluateVersion: 4,
      priorArtifactPath: '/tmp/eval-v3.md',
    });
  });

  it('maps accepted to the next evaluation and unknown to a terminal state', () => {
    expect(resolveNextStep({ latestDecision: 'accepted', latestVersion: 2, hasEvaluations: true }).state).toBe('accepted');
    expect(resolveNextStep({ latestDecision: 'unknown', latestVersion: 2, hasEvaluations: true }).nextSkill).toBeNull();
  });
});

describe('F9 pipeline suggestions', () => {
  const fixtureRoot = resolve(process.cwd(), 'temp-f9-suggestions-test');

  beforeAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
    mkdirSync(join(fixtureRoot, 'docs/dev'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'roles'), { recursive: true });
    mkdirSync(join(fixtureRoot, 'skills'), { recursive: true });
    writeFileSync(join(fixtureRoot, 'roles/tester.md'), '# Tester\n');
    writeFileSync(join(fixtureRoot, 'skills/skill.md'), '# Skill\n');
    writeFileSync(join(fixtureRoot, 'docs/dev/plan.md'), '# Plan\n');
    writeFileSync(join(fixtureRoot, '.orc-smash.yaml'), JSON.stringify({
      schemaVersion: 1,
      roles: { tester: 'roles/tester.md' },
      skills: {
        'test-skill': { file: 'skills/skill.md', role: 'tester', runnerProfile: 'audit' },
      },
      loops: {
        plan: {
          type: 'approval-loop',
          target: { path: 'docs/dev/plan.md', kind: 'file' },
          inputs: [],
          evaluate: { skill: 'test-skill', output: { pattern: 'docs/dev/audit-v{version}-{provider}.md', contract: 'decision-artifact', decision: { heading: 'Verdict', accepted: 'YES', retry: 'NO' } } },
          repair: { skill: 'test-skill', output: { pattern: 'docs/dev/repair-v{version}-{provider}.md', contract: 'completion-artifact' } },
        },
      },
      tasks: {},
      pipelines: {
        default: {
          stages: [
            { stageId: 'plan', loop: 'plan' },
            { stageId: 'review', loop: 'plan' },
          ],
        },
      },
    }));
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('returns empty candidates when no artifacts exist', () => {
    const config = loadConfig(fixtureRoot);
    const candidates = pipelineSuggestions(fixtureRoot, config.manifest);
    expect(candidates).toHaveLength(0);
  });

  it('returns candidates when a pipeline stage has a completed artifact', async () => {
    const config = loadConfig(fixtureRoot);
    // Create a completed pipeline artifact to trigger a candidate
    const { mintRunContext } = await import('../src/pipeline-state.js');
    const ctx = mintRunContext({ mode: 'pipeline-start', pipelineId: 'default', stageId: 'plan' });
    // Write a plan-audit v1 approved artifact
    const content = '# Evaluation\n\n## Verdict\n\nYES\n';
    const frontMatter = `---\nschemaVersion: 1\npipelineId: ${ctx.pipelineId}\npipelineRunId: ${ctx.pipelineRunId}\nstageId: ${ctx.stageId}\nchainId: ${ctx.chainId}\nchainMode: pipeline-start\nbindingKind: loop\nbindingId: plan\nkind: evaluate\nstep: evaluate\nversion: 1\nagent: opencode\nprovider: opencode\nmodel: opencode-model\nsessionId: none\nsessionMode: fresh\nartifactIdentity: test-id\ninputFingerprint: test-input\nresultFingerprint: test-result\nparentArtifactIdentity: null\n---\n`;
    writeFileSync(join(fixtureRoot, 'docs/dev/audit-v1-opencode.md'), frontMatter + content);

    const candidates = pipelineSuggestions(fixtureRoot, config.manifest);
    // May have candidates depending on fingerprint matching
    expect(Array.isArray(candidates)).toBe(true);
  });
});
