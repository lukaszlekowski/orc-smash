import { z } from 'zod';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';

export const InputSourceSchema = z.enum([
  'target',
  'version',
  'priorAudit',
  'outputPath',
  'planPath',
  'checklistPath'
]);

export type InputSource = z.infer<typeof InputSourceSchema>;

export const InputSchema = z.object({
  label: z.string(),
  source: InputSourceSchema
});

export type InputSpec = z.infer<typeof InputSchema>;

export const SkillSchema = z.object({
  file: z.string(),
  role: z.string(),
  kind: z.enum(['audit', 'follow-up']),
  agent: z.string(),
  model: z.string()
});

export type SkillSpec = z.infer<typeof SkillSchema>;

export const LoopSchema = z.object({
  kind: z.enum(['doc-audit', 'code-review']),
  target: z.string(),
  targetKind: z.enum(['file', 'worktree']),
  planPath: z.string().optional(),
  checklistPath: z.string().optional(),
  audit: z.string(),
  'follow-up': z.string(),
  auditPattern: z.string(),
  inputs: z.array(InputSchema)
});

export type LoopSpec = z.infer<typeof LoopSchema>;

export const ManifestSchema = z.object({
  roles: z.record(z.string(), z.string()),
  skills: z.record(z.string(), SkillSchema),
  loops: z.record(z.string(), LoopSchema)
}).superRefine((data, ctx) => {
  // Validate that all skill roles exist
  for (const [skillId, skill] of Object.entries(data.skills)) {
    if (!data.roles[skill.role]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['skills', skillId, 'role'],
        message: `Role '${skill.role}' referenced by skill '${skillId}' does not exist in roles.`
      });
    }
  }

  // Validate loop references and inputs
  for (const [loopId, loop] of Object.entries(data.loops)) {
    const auditSkill = data.skills[loop.audit];
    if (!auditSkill) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['loops', loopId, 'audit'],
        message: `Audit skill '${loop.audit}' referenced by loop '${loopId}' does not exist in skills.`
      });
    } else if (auditSkill.kind !== 'audit') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['loops', loopId, 'audit'],
        message: `Audit skill '${loop.audit}' in loop '${loopId}' must have kind 'audit', got '${auditSkill.kind}'.`
      });
    }

    const followUpSkill = data.skills[loop['follow-up'] || '']; // handle missing safely or zod catches it
    const followUpSkillActual = data.skills[loop['follow-up']];
    if (!followUpSkillActual) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['loops', loopId, 'follow-up'],
        message: `Follow-up skill '${loop['follow-up']}' referenced by loop '${loopId}' does not exist in skills.`
      });
    } else if (followUpSkillActual.kind !== 'follow-up') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['loops', loopId, 'follow-up'],
        message: `Follow-up skill '${loop['follow-up']}' in loop '${loopId}' must have kind 'follow-up', got '${followUpSkillActual.kind}'.`
      });
    }

    // Code review loop must have planPath
    if (loop.kind === 'code-review' && !loop.planPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['loops', loopId, 'planPath'],
        message: `Loop '${loopId}' has kind 'code-review' and therefore requires a planPath.`
      });
    }

    // Ensure loop inputs only use valid sources that are actually present
    for (let i = 0; i < loop.inputs.length; i++) {
      const input = loop.inputs[i];
      if (input.source === 'planPath' && !loop.planPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['loops', loopId, 'inputs', i],
          message: `Input source 'planPath' is used, but planPath is not specified in loop '${loopId}'.`
        });
      }
      if (input.source === 'checklistPath' && !loop.checklistPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['loops', loopId, 'inputs', i],
          message: `Input source 'checklistPath' is used, but checklistPath is not specified in loop '${loopId}'.`
        });
      }
    }
  }
});

export type Manifest = z.infer<typeof ManifestSchema>;

export function loadManifest(filePath: string): Manifest {
  const content = readFileSync(filePath, 'utf-8');
  const parsed = YAML.parse(content);
  return ManifestSchema.parse(parsed);
}
