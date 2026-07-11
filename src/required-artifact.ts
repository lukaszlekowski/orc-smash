import { existsSync } from 'node:fs';
import type { StepKind } from './provenance.js';

export interface RequiredArtifact {
  agent: string;
  kind: StepKind;
  outputPath: string;
  artifactName?: string;
}

export interface MissingRequiredArtifact {
  errorKind: 'missing_output';
  message: string;
}

/**
 * Enforces the durable-output contract for a clean provider completion.
 * Provider stdout is diagnostic only; a step is not successful until its
 * declared project artifact exists.
 */
export function missingRequiredArtifact(
  absolutePath: string,
  artifact: RequiredArtifact
): MissingRequiredArtifact | null {
  if (existsSync(absolutePath)) return null;

  const artifactName = artifact.artifactName ?? `${artifact.kind} artifact`;
  return {
    errorKind: 'missing_output',
    message: `${artifact.agent} exited cleanly but produced no ${artifactName} at ${artifact.outputPath}`
  };
}
