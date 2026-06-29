import type { ArtifactMeta } from '../../src/provenance.js';

/**
 * Helper to build an override-friendly ArtifactMeta object for tests.
 */
export function makeArtifactMeta(overrides: Partial<ArtifactMeta> = {}): ArtifactMeta {
  return {
    loop: 'plan',
    skill: 'plan-audit',
    kind: 'audit',
    role: 'auditor',
    version: 1,
    agent: 'fake',
    model: 'fake-model',
    target: 'docs/dev/plan.md',
    priorAudit: 'none',
    timestamp: '2026-06-26T20:00:00.000Z',
    ...overrides
  };
}
