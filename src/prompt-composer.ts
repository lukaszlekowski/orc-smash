import { readFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LoopSpec } from './manifest.js';
import { renderPattern } from './patterns.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const defaultToolRoot = resolve(__dirname, '..');

export function resolveInput(
  source: string,
  context: {
    targetRoot: string;
    target: string;
    targetKind: 'file' | 'worktree';
    version: number;
    priorAuditPath: string | null;
    agentName: string;
    auditPattern?: string;
    followUpPattern?: string;
    implementPattern?: string;
    kind: 'audit' | 'follow-up' | 'implement';
    planPath?: string;
    checklistPath?: string;
  }
): string {
  switch (source) {
    case 'target':
      return context.targetKind === 'worktree' ? '.' : context.target;
    case 'version':
      return String(context.version);
    case 'priorAudit':
      if (!context.priorAuditPath) return 'none';
      // priorAuditPath might be absolute or relative. Let's make sure it is relative to targetRoot
      if (context.priorAuditPath.startsWith(context.targetRoot)) {
        return relative(context.targetRoot, context.priorAuditPath);
      }
      return context.priorAuditPath;
    case 'outputPath': {
      const pattern =
        context.kind === 'follow-up' ? (context.followUpPattern ?? '') :
        context.kind === 'implement' ? (context.implementPattern ?? '') :
        (context.auditPattern ?? '');
      return renderPattern(pattern, { n: context.version, agent: context.agentName });
    }
    case 'planPath':
      return context.planPath || 'none';
    case 'checklistPath':
      return context.checklistPath || 'none';
    default:
      return 'none';
  }
}

export function composePrompt(
  skillId: string,
  roleFileRelativePath: string,
  skillFileRelativePath: string,
  loopSpec: LoopSpec,
  context: {
    targetRoot: string;
    version: number;
    priorAuditPath: string | null;
    agentName: string;
    kind: 'audit' | 'follow-up' | 'implement';
  },
  toolRoot: string = defaultToolRoot
): string {
  const rolePath = resolve(toolRoot, roleFileRelativePath);
  const skillPath = resolve(toolRoot, skillFileRelativePath);

  const roleContent = readFileSync(rolePath, 'utf-8').trim();
  const skillContent = readFileSync(skillPath, 'utf-8').trim();

  const inputsSection: string[] = [];
  for (const input of loopSpec.inputs) {
    const resolvedValue = resolveInput(input.source, {
      targetRoot: context.targetRoot,
      target: loopSpec.target,
      targetKind: loopSpec.targetKind,
      version: context.version,
      priorAuditPath: context.priorAuditPath,
      agentName: context.agentName,
      auditPattern: loopSpec.auditPattern,
      followUpPattern: loopSpec.followUpPattern,
      implementPattern: loopSpec.implementPattern,
      kind: context.kind,
      planPath: loopSpec.planPath,
      checklistPath: loopSpec.checklistPath
    });
    inputsSection.push(`${input.label}: ${resolvedValue}`);
  }

  return `# Role\n${roleContent}\n\n# Skill: ${skillId}\n${skillContent}\n\n# Inputs\n${inputsSection.join('\n')}\n`;
}
