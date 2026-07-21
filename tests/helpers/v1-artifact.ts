import type { ArtifactMeta, StepKind } from '../../src/provenance.js';

/**
 * Construct a complete v1 artifact header for index/status tests. These
 * fixtures intentionally use arbitrary stable identities; identity hashing is
 * covered by pipeline-state tests and the executor integration tests.
 */
export function makeV1ArtifactMeta(
  overrides: Partial<ArtifactMeta> & {
    bindingId?: string;
    bindingKind?: 'loop' | 'task';
    pipelineId?: string | null;
    pipelineRunId?: string | null;
    stageId?: string | null;
    chainMode?: ArtifactMeta['chainMode'];
    parentArtifactIdentity?: string | null;
  } = {},
): ArtifactMeta {
  const rawKind = overrides.kind ?? 'evaluate';
  const kind: StepKind = rawKind === 'audit'
    ? 'evaluate'
    : rawKind === 'follow-up'
      ? 'repair'
      : rawKind === 'implement'
        ? 'task'
        : rawKind;
  const bindingKind = overrides.bindingKind ?? (kind === 'task' ? 'task' : 'loop');
  const bindingId = overrides.bindingId ?? overrides.loop ?? 'plan';
  const pipelineId = overrides.pipelineId ?? null;
  const pipelineRunId = overrides.pipelineRunId ?? null;
  const stageId = overrides.stageId ?? null;
  const chainMode = overrides.chainMode ?? 'ad-hoc';
  const step = kind === 'evaluate' || kind === 'repair' || kind === 'task' ? kind : 'evaluate';
  const version = overrides.version ?? 1;
  const agent = overrides.agent ?? 'fake';

  return {
    loop: bindingId,
    skill: overrides.skill ?? (kind === 'task' ? '30-simple-implement' : 'plan-audit'),
    role: overrides.role ?? (kind === 'task' ? 'implementer' : 'auditor'),
    version,
    agent,
    provider: overrides.provider ?? agent,
    model: overrides.model ?? 'fake-model',
    effort: overrides.effort ?? 'medium',
    target: overrides.target ?? (kind === 'task' ? '.' : 'docs/dev/plan.md'),
    priorAudit: overrides.priorAudit ?? 'none',
    timestamp: overrides.timestamp ?? '2026-07-20T00:00:00.000Z',
    sessionMode: overrides.sessionMode ?? 'fresh',
    sessionId: overrides.sessionId ?? 'none',
    sessionStrategy: overrides.sessionStrategy ?? 'fresh',
    chainId: overrides.chainId ?? 'chain-' + bindingId,
    artifactIdentity: overrides.artifactIdentity ?? 'artifact-' + bindingId + '-' + version + '-' + agent,
    inputFingerprint: overrides.inputFingerprint ?? 'input-' + version,
    resultFingerprint: overrides.resultFingerprint ?? 'result-' + version,
    parentArtifactIdentity: overrides.parentArtifactIdentity ?? null,
    ...overrides,
    kind,
    step,
    schemaVersion: 1,
    bindingKind,
    bindingId,
    pipelineId,
    pipelineRunId,
    stageId,
    chainMode,
  };
}
