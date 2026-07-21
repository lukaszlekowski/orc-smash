import { describe, it, expect } from 'vitest';
import { resolveNextStep } from '../src/next-step.js';

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
