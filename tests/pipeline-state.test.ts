import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expectedPredecessor } from '../src/pipeline-state.js';
import { completionEvidenceForStage, eligibleNextStages, pipelineStageCandidates, type ArtifactRecord } from '../src/pipeline-stage-state.js';
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
      taskSource: {
        skill: 'source-skill',
        target: { path: '.', kind: 'worktree' },
        inputs: [],
        output: {
          pattern: 'docs/dev/task-source-v{version}-{provider}.md',
          contract: 'required-artifact',
        },
      },
      completionSource: {
        skill: 'source-skill',
        target: { path: '.', kind: 'worktree' },
        inputs: [],
        output: {
          pattern: 'docs/dev/completion-source-v{version}-{provider}.md',
          contract: 'completion-artifact',
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
      taskDelivery: {
        stages: [
          { stageId: 'task-source-stage', task: 'taskSource' },
          { stageId: 'task-sink-stage', task: 'sink' },
        ],
      },
      completionDelivery: {
        stages: [
          { stageId: 'completion-source-stage', task: 'completionSource' },
          { stageId: 'completion-sink-stage', task: 'sink' },
        ],
      },
      twoLoopDelivery: {
        stages: [
          { stageId: 'source-stage', loop: 'source' },
          { stageId: 'alternate-stage', loop: 'alternate' },
        ],
      },
    },
  };
}

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    artifactIdentity: 'source-artifact',
    bindingKind: 'loop',
    bindingId: 'source',
    phase: 'evaluate',
    contract: 'decision-artifact',
    normalizedResult: 'accepted',
    contractValid: true,
    unclassified: false,
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

  it('accepts a valid required-artifact task predecessor and rejects foreign or wrong-stage evidence', () => {
    const config = manifest();
    const candidates = eligibleNextStages(
      [
        artifact({
          artifactIdentity: 'task-artifact',
          bindingKind: 'task',
          bindingId: 'taskSource',
          phase: 'task',
          contract: 'required-artifact',
          normalizedResult: 'valid',
          pipelineId: 'taskDelivery',
          stageId: 'task-source-stage',
          decision: undefined,
          completionOutcome: undefined,
        }),
        artifact({ artifactIdentity: 'foreign', pipelineId: 'other', pipelineRunId: 'other-run' }),
        artifact({ artifactIdentity: 'wrong-stage', stageId: 'sink-stage' }),
      ],
      config,
      new Map([['taskDelivery:task-source-stage', 'source-state']]),
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.artifactIdentity).toBe('task-artifact');
  });

  it('only treats accepted evaluations as loop completion and never exposes repair artifacts', () => {
    const config = manifest();
    const retry = artifact({ artifactIdentity: 'retry-eval', normalizedResult: 'retry', decision: 'retry', resultFingerprint: 'source-state' });
    const repair = artifact({
      artifactIdentity: 'repair-completed',
      phase: 'repair',
      contract: 'completion-artifact',
      normalizedResult: 'completed',
      decision: undefined,
      completionOutcome: 'completed',
      parentArtifactIdentity: 'retry-eval',
    });
    expect(pipelineStageCandidates([retry, repair], config, new Map([['delivery:source-stage', 'source-state']]))).toEqual([]);
  });

  it('does not unlock a successor after completed repair followed by another retry', () => {
    const config = manifest();
    const retry = artifact({ artifactIdentity: 'retry-v1', normalizedResult: 'retry', decision: 'retry' });
    const repair = artifact({
      artifactIdentity: 'repair-v1',
      phase: 'repair',
      contract: 'completion-artifact',
      normalizedResult: 'completed',
      decision: undefined,
      completionOutcome: 'completed',
      parentArtifactIdentity: 'retry-v1',
    });
    const retryAgain = artifact({
      artifactIdentity: 'retry-v2',
      version: 2,
      normalizedResult: 'retry',
      decision: 'retry',
      parentArtifactIdentity: 'repair-v1',
    });

    expect(pipelineStageCandidates(
      [retry, repair, retryAgain],
      config,
      new Map([['delivery:source-stage', 'source-state']]),
    )).toEqual([]);
  });

  it('unlocks a completed completion-artifact task successor', () => {
    const config = manifest();
    const completed = artifact({
      artifactIdentity: 'completion-task',
      bindingKind: 'task',
      bindingId: 'completionSource',
      phase: 'task',
      contract: 'completion-artifact',
      normalizedResult: 'completed',
      completionOutcome: 'completed',
      decision: undefined,
      pipelineId: 'completionDelivery',
      stageId: 'completion-source-stage',
    });

    const candidates = eligibleNextStages(
      [completed],
      config,
      new Map([['completionDelivery:completion-source-stage', 'source-state']]),
    );
    expect(candidates).toEqual([expect.objectContaining({
      artifactIdentity: 'completion-task',
      reason: 'eligible',
    })]);
  });

  it('does not unlock a blocked completion-artifact task', () => {
    const config = manifest();
    const blocked = artifact({
      artifactIdentity: 'blocked-task',
      bindingKind: 'task',
      bindingId: 'completionSource',
      phase: 'task',
      contract: 'completion-artifact',
      normalizedResult: 'blocked',
      completionOutcome: 'blocked',
      decision: undefined,
      pipelineId: 'completionDelivery',
      stageId: 'completion-source-stage',
    });

    expect(eligibleNextStages(
      [blocked],
      config,
      new Map([['completionDelivery:completion-source-stage', 'source-state']]),
    )).toEqual([]);
  });

  it('does not unlock a validator-failing required-artifact task', () => {
    const config = manifest();
    const invalid = artifact({
      artifactIdentity: 'invalid-required-task',
      bindingKind: 'task',
      bindingId: 'taskSource',
      phase: 'task',
      contract: 'required-artifact',
      normalizedResult: 'valid',
      contractValid: false,
      decision: undefined,
      pipelineId: 'taskDelivery',
      stageId: 'task-source-stage',
    });

    expect(eligibleNextStages(
      [invalid],
      config,
      new Map([['taskDelivery:task-source-stage', 'source-state']]),
    )).toEqual([]);
  });

  it('keeps distinct accepted chains separate and suppresses only an exact consumed edge', () => {
    const config = manifest();
    const first = artifact({ artifactIdentity: 'accepted-one', chainId: 'chain-one' });
    const second = artifact({ artifactIdentity: 'accepted-two', chainId: 'chain-two' });
    const unconsumed = pipelineStageCandidates(
      [first, second],
      config,
      new Map([['delivery:source-stage', 'source-state']]),
    );
    expect(unconsumed.map(candidate => candidate.artifactIdentity)).toEqual(['accepted-one', 'accepted-two']);

    const successor = artifact({
      artifactIdentity: 'successor-root',
      bindingKind: 'task',
      bindingId: 'sink',
      phase: 'task',
      contract: 'required-artifact',
      normalizedResult: 'valid',
      decision: undefined,
      completionOutcome: undefined,
      stageId: 'sink-stage',
      chainId: 'successor-chain',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: 'accepted-one',
    });
    const consumed = pipelineStageCandidates(
      [first, second, successor],
      config,
      new Map([['delivery:source-stage', 'source-state']]),
    );
    expect(consumed).toHaveLength(2);
    expect(consumed.find(candidate => candidate.artifactIdentity === 'accepted-one')?.reason).toBe('exact-edge-consumed');
    expect(consumed.find(candidate => candidate.artifactIdentity === 'accepted-two')?.reason).toBe('eligible');
    expect(eligibleNextStages([first, second, successor], config, new Map([['delivery:source-stage', 'source-state']]))).toEqual([
      expect.objectContaining({ artifactIdentity: 'accepted-two' }),
    ]);
  });

  it('consumes exact predecessor edge when successor is a BLOCKED task root or REJECTED evaluate root', () => {
    const config = manifest();
    const predecessor = artifact({ artifactIdentity: 'predecessor-accepted', chainId: 'chain-one' });

    // 1. Task successor with completion-artifact contract but normalizedResult: 'blocked' (e.g. BLOCKED create-plan)
    const blockedTaskSuccessor = artifact({
      artifactIdentity: 'blocked-task-successor',
      bindingKind: 'task',
      bindingId: 'sink',
      phase: 'task',
      contract: 'completion-artifact',
      normalizedResult: 'blocked',
      completionOutcome: 'blocked',
      decision: undefined,
      contractValid: true,
      stageId: 'sink-stage',
      chainId: 'successor-chain-1',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: 'predecessor-accepted',
    });

    const candidatesWithBlockedTask = pipelineStageCandidates(
      [predecessor, blockedTaskSuccessor],
      config,
      new Map([['delivery:source-stage', 'source-state']]),
    );
    expect(candidatesWithBlockedTask).toHaveLength(1);
    expect(candidatesWithBlockedTask[0].artifactIdentity).toBe('predecessor-accepted');
    expect(candidatesWithBlockedTask[0].reason).toBe('exact-edge-consumed');
    expect(candidatesWithBlockedTask[0].evidence.consumedByArtifactIdentity).toBe('blocked-task-successor');
    expect(eligibleNextStages([predecessor, blockedTaskSuccessor], config, new Map([['delivery:source-stage', 'source-state']]))).toEqual([]);
    expect(completionEvidenceForStage([predecessor, blockedTaskSuccessor], 'delivery', 'sink-stage', config)).toEqual([]);

    // 2. Loop successor evaluate phase with normalizedResult: 'retry' (REJECTED review)
    const predecessorLoop = artifact({ artifactIdentity: 'predecessor-accepted-loop', chainId: 'chain-two', pipelineId: 'twoLoopDelivery' });
    const retryLoopSuccessor = artifact({
      artifactIdentity: 'retry-loop-successor',
      bindingKind: 'loop',
      bindingId: 'alternate',
      phase: 'evaluate',
      contract: 'decision-artifact',
      normalizedResult: 'retry',
      decision: 'retry',
      contractValid: true,
      pipelineId: 'twoLoopDelivery',
      stageId: 'alternate-stage',
      chainId: 'successor-chain-2',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: 'predecessor-accepted-loop',
    });

    const candidatesWithRetryLoop = pipelineStageCandidates(
      [predecessorLoop, retryLoopSuccessor],
      config,
      new Map([['twoLoopDelivery:source-stage', 'source-state']]),
    );
    expect(candidatesWithRetryLoop).toHaveLength(1);
    expect(candidatesWithRetryLoop[0].artifactIdentity).toBe('predecessor-accepted-loop');
    expect(candidatesWithRetryLoop[0].reason).toBe('exact-edge-consumed');
    expect(candidatesWithRetryLoop[0].evidence.consumedByArtifactIdentity).toBe('retry-loop-successor');
    expect(eligibleNextStages([predecessorLoop, retryLoopSuccessor], config, new Map([['twoLoopDelivery:source-stage', 'source-state']]))).toEqual([]);
    expect(completionEvidenceForStage([predecessorLoop, retryLoopSuccessor], 'twoLoopDelivery', 'alternate-stage', config)).toEqual([]);
  });

  it('guards against reintroducing generic completion predicates and routes loop completion through the evidence seam', () => {
    const sourceRoot = join(process.cwd(), 'src');
    const sourceFiles: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const filePath = join(directory, entry);
        if (statSync(filePath).isDirectory()) visit(filePath);
        else if (filePath.endsWith('.ts')) sourceFiles.push(filePath);
      }
    };
    visit(sourceRoot);
    const stripComments = (source: string): string => source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|\s)\/\/.*$/gm, '$1');
    for (const filePath of sourceFiles) {
      if (filePath.endsWith('pipeline-stage-state.ts')) continue;
      const source = stripComments(readFileSync(filePath, 'utf8'));
      expect(source).not.toMatch(/completionOutcome\s*===\s*['"]completed['"]/);
      expect(source).not.toMatch(/contractValid\s*===\s*true\s*&&\s*decision\s*===\s*undefined\s*&&\s*completionOutcome\s*===\s*undefined/);
    }

    const stageStateSource = stripComments(readFileSync(join(sourceRoot, 'pipeline-stage-state.ts'), 'utf8'));
    const evidenceStart = stageStateSource.indexOf('export function completionEvidenceForStage');
    const evidenceEnd = stageStateSource.indexOf('export function validateContinuationParent', evidenceStart);
    const candidateStart = stageStateSource.indexOf('export function pipelineStageCandidates');
    const candidateEnd = stageStateSource.indexOf('export function eligibleNextStages', candidateStart);
    expect(evidenceStart).toBeGreaterThanOrEqual(0);
    expect(evidenceEnd).toBeGreaterThan(evidenceStart);
    expect(candidateStart).toBeGreaterThanOrEqual(0);
    expect(candidateEnd).toBeGreaterThan(candidateStart);
    const evidenceSource = stageStateSource.slice(evidenceStart, evidenceEnd);
    const taskBranchStart = evidenceSource.indexOf("if (binding.kind === 'task')");
    const loopBranchStart = evidenceSource.indexOf('const chains = new Map', taskBranchStart);
    expect(taskBranchStart).toBeGreaterThanOrEqual(0);
    expect(loopBranchStart).toBeGreaterThan(taskBranchStart);
    const loopEligibilitySource = evidenceSource.slice(0, taskBranchStart) + evidenceSource.slice(loopBranchStart)
      + stageStateSource.slice(candidateStart, candidateEnd);
    expect(loopEligibilitySource).not.toMatch(/completionOutcome\s*===\s*['"]completed['"]/);
    expect(loopEligibilitySource).not.toMatch(/contractValid\s*===\s*true\s*&&\s*decision\s*===\s*undefined\s*&&\s*completionOutcome\s*===\s*undefined/);

    const resolver = vi.fn(() => []);
    const candidates = pipelineStageCandidates(
      [artifact()],
      manifest(),
      new Map([['delivery:source-stage', 'source-state']]),
      resolver,
    );
    expect(candidates).toEqual([]);
    expect(resolver).toHaveBeenCalledWith(expect.any(Array), 'delivery', 'source-stage', expect.any(Object));
    expect(completionEvidenceForStage).toBeTypeOf('function');
  });

  it('does not suppress a predecessor consumed by a different pipeline run', () => {
    const config = manifest();
    const predecessor = artifact({ artifactIdentity: 'accepted-run-one', pipelineRunId: 'run-one' });
    const otherRunSuccessor = artifact({
      artifactIdentity: 'successor-run-two',
      bindingKind: 'task',
      bindingId: 'sink',
      phase: 'task',
      contract: 'required-artifact',
      normalizedResult: 'valid',
      decision: undefined,
      pipelineId: 'delivery',
      pipelineRunId: 'run-two',
      stageId: 'sink-stage',
      chainId: 'successor-chain',
      chainMode: 'stage-continuation',
      parentArtifactIdentity: 'accepted-run-one',
    });

    expect(pipelineStageCandidates(
      [predecessor, otherRunSuccessor],
      config,
      new Map([['delivery:source-stage', 'source-state']]),
    )).toEqual([expect.objectContaining({
      artifactIdentity: 'accepted-run-one',
      reason: 'eligible',
    })]);
  });
});
