import { z } from 'zod';
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import type { ModelRegistry } from './config.js';

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
  kind: z.enum(['audit', 'follow-up', 'implement']),
  runnerProfile: z.string()
}).strict();

export type SkillSpec = z.infer<typeof SkillSchema>;

export const LoopSchema = z.object({
  kind: z.enum(['doc-audit', 'code-review', 'implement']),
  target: z.string(),
  targetKind: z.enum(['file', 'worktree']),
  planPath: z.string().optional(),
  checklistPath: z.string().optional(),
  audit: z.string().optional(),
  'follow-up': z.string().optional(),
  auditPattern: z.string().optional(),
  followUpPattern: z.string().optional(),
  implement: z.string().optional(),
  implementPattern: z.string().optional(),
  inputs: z.array(InputSchema)
});

export type LoopSpec = z.infer<typeof LoopSchema>;

export function buildManifestSchema(registry: ModelRegistry) {
  return z.object({
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

      if (!registry.profiles[skill.runnerProfile]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['skills', skillId, 'runnerProfile'],
          message: `Skill '${skillId}' references unknown runner profile '${skill.runnerProfile}'.`
        });
      }
    }

    // Validate loop references and inputs
    for (const [loopId, loop] of Object.entries(data.loops)) {
      if (loop.kind === 'doc-audit' || loop.kind === 'code-review') {
        if (loop.implement) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['loops', loopId, 'implement'],
            message: `Loop '${loopId}' has kind '${loop.kind}' and therefore must not specify implement.`
          });
        }

        if (!loop.audit) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['loops', loopId, 'audit'],
            message: `Loop '${loopId}' has kind '${loop.kind}' and therefore requires an audit skill.`
          });
        } else {
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
        }

        if (!loop['follow-up']) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['loops', loopId, 'follow-up'],
            message: `Loop '${loopId}' has kind '${loop.kind}' and therefore requires a follow-up skill.`
          });
        } else {
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
        }

        if (!loop.auditPattern || !loop.followUpPattern) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['loops', loopId],
            message: `Loop '${loopId}' has kind '${loop.kind}' and therefore requires both auditPattern and followUpPattern.`
          });
        } else {
          for (const pat of [loop.auditPattern, loop.followUpPattern]) {
            if (!pat.includes('{n}') || !pat.includes('{agent}')) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['loops', loopId],
                message: `Loop '${loopId}' pattern '${pat}' must contain both {n} and {agent}.`
              });
            }
          }
        }

        if (loop.kind === 'code-review' && !loop.planPath) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['loops', loopId, 'planPath'],
            message: `Loop '${loopId}' has kind 'code-review' and therefore requires a planPath.`
          });
        }
      } else if (loop.kind === 'implement') {
        if (loop.audit || loop['follow-up'] || loop.auditPattern || loop.followUpPattern) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['loops', loopId],
            message: `Loop '${loopId}' has kind 'implement' and therefore must not specify audit, follow-up, auditPattern, or followUpPattern.`
          });
        }

        if (!loop.implement) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['loops', loopId, 'implement'],
            message: `Loop '${loopId}' has kind 'implement' and therefore requires an implement skill.`
          });
        } else {
          const implementSkill = data.skills[loop.implement];
          if (!implementSkill) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['loops', loopId, 'implement'],
              message: `Implement skill '${loop.implement}' referenced by loop '${loopId}' does not exist in skills.`
            });
          } else if (implementSkill.kind !== 'implement') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['loops', loopId, 'implement'],
              message: `Implement skill '${loop.implement}' in loop '${loopId}' must have kind 'implement', got '${implementSkill.kind}'.`
            });
          }
        }

        if (!loop.planPath) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['loops', loopId, 'planPath'],
            message: `Loop '${loopId}' has kind 'implement' and therefore requires planPath.`
          });
        }

        if (!loop.implementPattern) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['loops', loopId, 'implementPattern'],
            message: `Loop '${loopId}' has kind 'implement' and therefore requires implementPattern.`
          });
        } else {
          if (!loop.implementPattern.includes('{n}') || !loop.implementPattern.includes('{agent}')) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['loops', loopId, 'implementPattern'],
              message: `Loop '${loopId}' pattern '${loop.implementPattern}' must contain both {n} and {agent}.`
            });
          }
        }
      }

      // Ensure loop inputs only use valid sources that are actually present
      for (let i = 0; i < loop.inputs.length; i++) {
        const input = loop.inputs[i]!;
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
}

export type Manifest = z.infer<ReturnType<typeof buildManifestSchema>>;

export function loadManifest(filePath: string, registry: ModelRegistry): Manifest {
  const content = readFileSync(filePath, 'utf-8');
  const parsed = YAML.parse(content);
  return buildManifestSchema(registry).parse(parsed);
}
