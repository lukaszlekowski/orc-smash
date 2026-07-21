import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderPattern } from './patterns.js';
import {
  isPriorArtifactNone,
  inputLabelFor,
  type PriorArtifactResolution,
} from './binding-inputs.js';
import type { InputSpec, TargetSpec } from './manifest.js';

export interface PromptContext {
  /** Project root for resolving targets, files, and outputs */
  projectRoot: string;
  /** Target info from the binding */
  target: TargetSpec;
  /** The version number for this step */
  version: number;
  /** Provider/agent name (for output path rendering) */
  provider: string;
  /** Resolved prior-artifact snapshot from binding-inputs */
  priorArtifact: PriorArtifactResolution;
  /** The output pattern to render */
  outputPattern: string;
  /** Additional project-file inputs (key -> relative path) */
  files?: Record<string, string>;
}

function resolveFileValue(projectRoot: string, value: string | null | undefined): string {
  return !value || value === 'none' ? 'none' : resolve(projectRoot, value);
}

export function resolveInput(
  source: string,
  context: PromptContext,
): string {
  switch (source) {
    case 'target':
      return context.target.kind === 'worktree'
        ? context.projectRoot
        : resolve(context.projectRoot, context.target.path);
    case 'version':
      return String(context.version);
    case 'priorArtifact':
      return isPriorArtifactNone(context.priorArtifact)
        ? 'none'
        : resolveFileValue(context.projectRoot, context.priorArtifact.path);
    case 'outputPath':
      return resolve(
        context.projectRoot,
        renderPattern(context.outputPattern, {
          version: context.version,
          provider: context.provider,
        }),
      );
    default:
      if (context.files && Object.prototype.hasOwnProperty.call(context.files, source)) {
        return resolveFileValue(context.projectRoot, context.files[source]!);
      }
      return 'none';
  }
}

/**
 * Compose a prompt from a skill's role, skill file, and declared inputs.
 * Role/skill files are resolved from `manifestRoot`; targets, files, and
 * outputs are resolved from `projectRoot`.
 */
export function composePrompt(
  skillId: string,
  roleFile: string,
  skillFile: string,
  inputs: InputSpec[],
  context: PromptContext,
  manifestRoot: string,
): string {
  const rolePath = resolve(manifestRoot, roleFile);
  const skillPath = resolve(manifestRoot, skillFile);

  const roleContent = readFileSync(rolePath, 'utf-8').trim();
  const skillContent = readFileSync(skillPath, 'utf-8').trim();

  const inputsSection: string[] = [];
  for (const input of inputs) {
    const resolvedValue = resolveInput(input.source, context);
    const label = input.label ?? inputLabelFor(input.source);
    inputsSection.push(`${label}: ${resolvedValue}`);
  }

  return `# Role\n${roleContent}\n\n# Skill: ${skillId}\n${skillContent}\n\n# Inputs\n${inputsSection.join('\n')}\n`;
}
