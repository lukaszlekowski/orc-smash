import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipelineSuggestions } from '../src/next-step.js';
import { loadConfig } from '../src/config.js';
import { captureBindingResultFingerprint } from '../src/target-snapshot.js';
import { writeArtifactWithMeta } from '../src/provenance.js';
import { makeV1ArtifactMeta } from './helpers/v1-artifact.js';

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
    const fingerprint = captureBindingResultFingerprint(fixtureRoot, config.manifest.loops.plan!.target, config.manifest.loops.plan!.files, config.manifest);
    const meta = makeV1ArtifactMeta({
      version: 1,
      agent: 'fake',
      provider: 'fake',
      bindingId: 'plan',
      bindingKind: 'loop',
      kind: 'evaluate',
      pipelineId: 'default',
      pipelineRunId: 'test-run-123',
      stageId: 'plan',
      chainId: 'candidate-chain',
      chainMode: 'pipeline-start',
      resultFingerprint: fingerprint,
    });
    writeArtifactWithMeta(
      join(fixtureRoot, 'docs/dev/audit-v1-fake.md'),
      '# Evaluation\n\n## Verdict\n\nYES\n',
      meta,
    );

    const candidates = pipelineSuggestions(fixtureRoot, config.manifest);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      artifactIdentity: meta.artifactIdentity,
      pipelineId: 'default',
      pipelineRunId: 'test-run-123',
      predecessorStageId: 'plan',
      successorStageId: 'review',
      reason: 'eligible',
      unavailableReason: undefined,
      evidence: {
        bindingKind: 'loop',
        bindingId: 'plan',
        phase: 'evaluate',
        chainId: 'candidate-chain',
        normalizedResult: 'accepted',
      },
    });
  });
});
