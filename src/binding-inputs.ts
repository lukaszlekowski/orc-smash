import { sha256 } from './pipeline-state.js';

export interface PriorArtifactSnapshot {
  path: string;
  artifactIdentity: string;
  contentDigest: string;
}

export type PriorArtifactResolution = PriorArtifactSnapshot | { kind: 'none' };

const NONE_RESOLUTION = Object.freeze({ kind: 'none' as const });

export function priorArtifactNone(): PriorArtifactResolution {
  return NONE_RESOLUTION;
}

export function isPriorArtifactNone(r: PriorArtifactResolution): r is { kind: 'none' } {
  return 'kind' in r;
}

export function priorArtifactSnapshot(
  artifactPath: string,
  artifactIdentity: string,
  artifactContent: string | Buffer,
): PriorArtifactSnapshot {
  const contentDigest = sha256(artifactContent);
  return { path: artifactPath, artifactIdentity, contentDigest };
}

export { sha256 };

/**
 * Build the canonical prior-artifact snapshot for a step's provenance.
 * The caller supplies the resolved artifact path (or null for "none"),
 * the parsed artifact identity, and the artifact file bytes.
 */
export function resolvePriorArtifact(
  artifactPath: string | null,
  artifactIdentity: string | null,
  artifactContent: string | Buffer | null,
): PriorArtifactResolution {
  if (artifactPath && artifactIdentity && artifactContent !== null) {
    return priorArtifactSnapshot(artifactPath, artifactIdentity, artifactContent);
  }
  return priorArtifactNone();
}

/**
 * Compute an input fingerprint from the resolved inputs that affect agent
 * semantics: the target snapshot digest, the priorArtifact snapshot, and
 * each resolved files: dependency digest. version and outputPath are
 * allocation-only and deliberately excluded.
 */
export { computeInputFingerprint } from './pipeline-state.js';

/** Default label for an input source. */
export function inputLabelFor(source: string): string {
  switch (source) {
    case 'target':
      return 'Target document';
    case 'version':
      return 'Version';
    case 'priorArtifact':
      return 'Prior artifact';
    case 'outputPath':
      return 'Output path';
    default:
      return source;
  }
}
