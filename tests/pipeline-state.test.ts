import { describe, expect, it } from 'vitest';
import { eligibleNextStages, expectedPredecessor, pipelineStageCandidates, type ArtifactRecord } from '../src/pipeline-state.js';
import type { V1Manifest } from '../src/manifest.js';

function manifest(): V1Manifest {
  return {
    schemaVersion: 1,
    roles: {},
    skills: {},
    loops: {
      source: {
        type: 'approval-loop',
        target: { path: 'source.md', kind: 'file' },
        inputs: [],
        evaluate: {
          skill: 'source-skill',
          output: {
            pattern: 'docs/dev/source-v{version}-{provider}.md',
            contract: 'decision-artifact',
            decision: { heading: 'Decision', accepted: 'PASS', retry: 'FAIL' },
          },
        },
        repair: {
          skill: 'source-repair',
          output: {
            pattern: 'docs/dev/source-repair-v{version}-{provider}.md',
            contract: 'completion-artifact',
          },
        },
      },
      alternate: {
        type: 'approval-loop',
        target: { path: 'alternate.md', kind: 'file' },
        inputs: [],
        evaluate: {
          skill: 'alternate-skill',
          output: {
            pattern: 'docs/dev/alternate-v{version}-{provider}.md',
            contract: 'decision-artifact',
            decision: { heading: 'Decision', accepted: 'PASS', retry: 'FAIL' },
          },
        },
        repair: {
          skill: 'alternate-repair',
          output: {
            pattern: 'docs/dev/alternate-repair-v{version}-{provider}.md',
            contract: 'completion-artifact',
          },
        },
      },
    },
    tasks: {
      sink: {
        skill: 'sink-skill',
        target: { path: '.', kind: 'worktree' },
        inputs: [],
        output: {
          pattern: 'docs/dev/sink-v{version}-{provider}.md',
          contract: 'required-artifact',
        },
      },
    },
    pipelines: {
      delivery: {
        stages: [
          { stageId: 'source-stage', loop: 'source' },
          { stageId: 'sink-stage', task: 'sink' },
        ],
      },
    },
  };
}

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactIdentity: 'source-artifact',
    pipelineId: 'delivery',
    pipelineRunId: 'run-1',
    stageId: 'source-stage',
    chainId: 'chain-1',
    chainMode: 'pipeline-start',
    parentArtifactIdentity: null,
    resultFingerprint: 'source-state',
    artifactPath: 'docs/dev/source-v1-fake.md',
    decision: 'accepted',
    version: 1,
    ...overrides,
  };
}

describe('pipeline run identity and eligibility', () => {
  it('resolves the immediate stage predecessor and ignores ad-hoc artifacts', () => {
    const config = manifest();
    expect(expectedPredecessor('delivery', 'sink-stage', config)).toBe('source-stage');
    expect(expectedPredecessor('delivery', 'source-stage', config)).toBeNull();

    const candidates = eligibleNextStages(
      [
        artifact(),
        artifact({ artifactIdentity: 'ad-hoc-artifact', pipelineId: null, pipelineRunId: null, stageId: null, chainMode: 'ad-hoc' }),
      ],
      config,
      new Map([['delivery:source-stage', 'source-state']]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      artifactIdentity: 'source-artifact',
      pipelineRunId: 'run-1',
      predecessorStageId: 'source-stage',
      successorStageId: 'sink-stage',
      stale: false,
    });
  });

  it('requires the predecessor binding target to remain unchanged', () => {
    const config = manifest();
    const allCandidates = pipelineStageCandidates(
      [artifact()],
      config,
      new Map([['delivery:source-stage', 'edited-source-state']]),
    );
    expect(allCandidates).toHaveLength(1);
    expect(allCandidates[0]!.stale).toBe(true);

    const candidates = eligibleNextStages(
      [artifact()],
      config,
      new Map([['delivery:source-stage', 'edited-source-state']]),
    );
    expect(candidates).toEqual([]);
  });

  it('accepts a completed required-artifact predecessor and rejects foreign or wrong-stage evidence', () => {
    const config = manifest();
    const candidates = eligibleNextStages(
      [
        artifact({
          artifactIdentity: 'task-artifact',
          stageId: 'source-stage',
          decision: undefined,
          completionOutcome: 'completed',
          contractValid: true,
        }),
        artifact({ artifactIdentity: 'foreign', pipelineId: 'other', pipelineRunId: 'other-run' }),
        artifact({ artifactIdentity: 'wrong-stage', stageId: 'sink-stage' }),
      ],
      config,
      new Map([['source-stage', 'source-state']]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.artifactIdentity).toBe('task-artifact');
  });
});
