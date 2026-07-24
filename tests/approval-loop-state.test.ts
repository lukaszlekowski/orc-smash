import { describe, expect, it } from 'vitest';
import { reduceApprovalChain, approvalNextPhase, resumableApprovalChain, type ApprovalChainStep } from '../src/approval-loop-state.js';

function step(overrides: Partial<ApprovalChainStep> = {}): ApprovalChainStep {
  return {
    artifactIdentity: 'a1',
    bindingKind: 'loop',
    bindingId: 'quality',
    phase: 'evaluate',
    chainId: 'chain-1',
    chainMode: 'pipeline-start',
    pipelineId: 'default',
    pipelineRunId: 'run-1',
    stageId: 'quality',
    version: 1,
    parentArtifactIdentity: null,
    normalizedResult: 'accepted',
    contractValid: true,
    unclassified: false,
    artifactPath: 'quality-v1-fake.md',
    resultFingerprint: 'target-1',
    ...overrides,
  };
}

describe('approval-loop-state reducer', () => {
  it('reduces empty, accepted, retry, repair, and blocked chains', () => {
    expect(reduceApprovalChain([])).toEqual({ kind: 'not-started' });
    expect(reduceApprovalChain([step()]).kind).toBe('accepted');

    const retry = step({ normalizedResult: 'retry' });
    expect(reduceApprovalChain([retry])).toMatchObject({ kind: 'repair-required', evaluate: retry });

    const completedRepair = step({
      artifactIdentity: 'r1',
      phase: 'repair',
      normalizedResult: 'completed',
      parentArtifactIdentity: 'a1',
    });
    expect(reduceApprovalChain([retry, completedRepair])).toMatchObject({ kind: 'evaluation-required', repair: completedRepair });
    expect(approvalNextPhase(reduceApprovalChain([retry, completedRepair]))).toEqual({
      phase: 'evaluate',
      version: 2,
      parentArtifactIdentity: 'r1',
    });

    const validRepair: ApprovalChainStep = { ...completedRepair, normalizedResult: 'valid', artifactIdentity: 'r2' };
    expect(reduceApprovalChain([retry, validRepair])).toMatchObject({ kind: 'evaluation-required', repair: validRepair });

    const blockedRepair: ApprovalChainStep = { ...completedRepair, normalizedResult: 'blocked', artifactIdentity: 'r3' };
    expect(reduceApprovalChain([retry, blockedRepair])).toMatchObject({ kind: 'blocked', artifact: blockedRepair });
  });

  it('requires accepted evaluation for terminal approval and normalizes arbitrary configured tokens upstream', () => {
    const retry = step({ normalizedResult: 'retry' });
    const repair = step({ artifactIdentity: 'r1', phase: 'repair', normalizedResult: 'completed', parentArtifactIdentity: 'a1' });
    const accepted = step({ artifactIdentity: 'a2', version: 2, parentArtifactIdentity: 'r1', normalizedResult: 'accepted' });
    expect(reduceApprovalChain([retry, repair, accepted])).toMatchObject({ kind: 'accepted', evaluate: accepted });
    expect(approvalNextPhase(reduceApprovalChain([accepted]))).toBeNull();
  });

  it('fails closed for invalid evidence, illegal transitions, duplicates, and legacy phases', () => {
    expect(reduceApprovalChain([step({ normalizedResult: 'unknown' })])).toMatchObject({ kind: 'unknown', reason: 'unknown-evaluation' });
    expect(reduceApprovalChain([step({ normalizedResult: 'retry' }), step({ artifactIdentity: 'a2', version: 2, normalizedResult: 'accepted', parentArtifactIdentity: 'a1' })])).toMatchObject({ kind: 'conflict', reason: 'evaluation-without-repair' });
    expect(reduceApprovalChain([step(), step({ artifactIdentity: 'a2', parentArtifactIdentity: 'a1' })])).toMatchObject({ kind: 'conflict', reason: 'duplicate-position' });
    expect(reduceApprovalChain([step({ phase: 'audit' })])).toMatchObject({ kind: 'unknown', reason: 'legacy-phase' });
    expect(reduceApprovalChain([step(), step({ artifactIdentity: 'r1', phase: 'repair', normalizedResult: 'completed', parentArtifactIdentity: 'a1' })])).toMatchObject({ kind: 'conflict', reason: 'repair-after-accepted' });

    const retry = step({ normalizedResult: 'retry' });
    const unknownRepair = step({ artifactIdentity: 'r1', phase: 'repair', normalizedResult: 'unknown', contractValid: false, parentArtifactIdentity: 'a1' });
    expect(reduceApprovalChain([retry, unknownRepair])).toMatchObject({ kind: 'unknown', reason: 'unknown-repair' });
  });

  it('resumes only repair-required and evaluation-required chains', () => {
    const retry = step({ normalizedResult: 'retry' });
    const repair = step({ artifactIdentity: 'r1', phase: 'repair', normalizedResult: 'completed', parentArtifactIdentity: 'a1' });

    expect(resumableApprovalChain([retry])).toMatchObject({
      state: { kind: 'repair-required' },
      chainId: 'chain-1',
      parentArtifactIdentity: 'a1',
    });
    expect(resumableApprovalChain([retry, repair])).toMatchObject({
      state: { kind: 'evaluation-required' },
      parentArtifactIdentity: 'r1',
    });

    // Terminal states never resume: accepted, blocked, unknown, conflict.
    expect(resumableApprovalChain([step()])).toBeNull();
    expect(resumableApprovalChain([retry, { ...repair, normalizedResult: 'blocked' }])).toBeNull();
    expect(resumableApprovalChain([step({ normalizedResult: 'unknown' })])).toBeNull();
    expect(resumableApprovalChain([step(), step({ artifactIdentity: 'a2', parentArtifactIdentity: 'a1' })])).toBeNull();
    expect(resumableApprovalChain([])).toBeNull();
  });
});
