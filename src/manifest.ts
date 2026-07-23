import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import YAML from 'yaml';
import type { ModelRegistry } from './config.js';
import { BUILT_IN_SOURCES, validateOutputPattern } from './patterns.js';
import { assertDeclaredProjectPath, assertOutputWithinProject } from './paths.js';

// ---- v1 schema types ----

export const TargetKindSchema = z.enum(['file', 'worktree']);
export type TargetKind = z.infer<typeof TargetKindSchema>;

export const TargetSchema = z.object({
  path: z.string(),
  kind: TargetKindSchema,
}).strict();

export type TargetSpec = z.infer<typeof TargetSchema>;

export const OutputContractSchema = z.enum([
  'decision-artifact',
  'completion-artifact',
  'required-artifact',
]);
export type OutputContract = z.infer<typeof OutputContractSchema>;

export const OutputSchema = z.object({
  pattern: z.string(),
  contract: OutputContractSchema,
  decision: z.object({
    heading: z.string(),
    accepted: z.string(),
    retry: z.string(),
  }).strict().optional(),
  validator: z.string().optional(),
}).strict();

export type OutputSpec = z.infer<typeof OutputSchema>;

export const TaskOutputContractSchema = z.enum([
  'completion-artifact',
  'required-artifact',
]);
export type TaskOutputContract = z.infer<typeof TaskOutputContractSchema>;

export const TaskOutputSchema = z.object({
  pattern: z.string(),
  contract: TaskOutputContractSchema,
  validator: z.string().optional(),
}).strict();

export type TaskOutputSpec = z.infer<typeof TaskOutputSchema>;

export const FileMapValueSchema = z.string();
export const FilesSchema = z.record(z.string(), FileMapValueSchema);

export const InputSpecSchema = z.object({
  source: z.string(),
  label: z.string().optional(),
}).strict();

export type InputSpec = z.infer<typeof InputSpecSchema>;

export const SkillSpecSchema = z.object({
  file: z.string(),
  role: z.string(),
  runnerProfile: z.string(),
}).strict();

export type SkillSpec = z.infer<typeof SkillSpecSchema>;

const EvaluateStepSchema = z.object({
  skill: z.string(),
  output: OutputSchema,
}).strict();

export type EvaluateStepSpec = z.infer<typeof EvaluateStepSchema>;

const RepairStepSchema = z.object({
  skill: z.string(),
  output: OutputSchema,
}).strict();

export type RepairStepSpec = z.infer<typeof RepairStepSchema>;

export const LoopBindingSchema = z.object({
  type: z.literal('approval-loop'),
  target: TargetSchema,
  inputs: z.array(InputSpecSchema),
  files: FilesSchema.optional(),
  maxIterations: z.number().int().positive().optional(),
  evaluate: EvaluateStepSchema,
  repair: RepairStepSchema,
}).strict();

export type LoopBinding = z.infer<typeof LoopBindingSchema>;

export const TaskBindingSchema = z.object({
  skill: z.string(),
  target: TargetSchema,
  inputs: z.array(InputSpecSchema),
  files: FilesSchema.optional(),
  output: TaskOutputSchema,
}).strict();

export type TaskBinding = z.infer<typeof TaskBindingSchema>;

const PipelineStageSchema = z.object({
  stageId: z.string(),
  loop: z.string().optional(),
  task: z.string().optional(),
}).strict();

export type PipelineStage = z.infer<typeof PipelineStageSchema>;

const PipelineSpecSchema = z.object({
  stages: z.array(PipelineStageSchema),
}).strict();

export type PipelineSpec = z.infer<typeof PipelineSpecSchema>;

// ---- full v1 manifest ----

export const V1_MANIFEST_SCHEMA_VERSION = 1;

const BASE_V1_SCHEMA = z.object({
  schemaVersion: z.literal(V1_MANIFEST_SCHEMA_VERSION),
  roles: z.record(z.string(), z.string()),
  skills: z.record(z.string(), SkillSpecSchema),
  loops: z.record(z.string(), LoopBindingSchema),
  tasks: z.record(z.string(), TaskBindingSchema).optional().default({}),
  pipelines: z.record(z.string(), PipelineSpecSchema).optional().default({}),
});

const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

function assertSafeId(ctx: z.RefinementCtx, path: (string | number)[], id: string, name: string): void {
  if (!SAFE_ID_REGEX.test(id)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: `Invalid ${name} '${id}': must contain only letters, numbers, underscores, and hyphens.`,
    });
  }
}

const V1ManifestSchema = BASE_V1_SCHEMA.superRefine((data, ctx) => {
  // 1. Validate roles and skill identifiers
  for (const [roleId] of Object.entries(data.roles)) {
    assertSafeId(ctx, ['roles', roleId], roleId, 'role ID');
  }
  for (const [skillId, skill] of Object.entries(data.skills)) {
    assertSafeId(ctx, ['skills', skillId], skillId, 'skill ID');
    if (!data.roles[skill.role]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['skills', skillId, 'role'],
        message: `Role '${skill.role}' referenced by skill '${skillId}' does not exist in roles.`,
      });
    }
  }

  // 2. Validate loop skill references, identifiers, and output patterns
  for (const [loopId, loop] of Object.entries(data.loops)) {
    assertSafeId(ctx, ['loops', loopId], loopId, 'loop ID');
    for (const stepKind of ['evaluate', 'repair'] as const) {
      const step = loop[stepKind];
      const skill = data.skills[step.skill];
      if (!skill) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['loops', loopId, stepKind, 'skill'],
          message: `Skill '${step.skill}' referenced by loop '${loopId}.${stepKind}' does not exist.`,
        });
      }
      validatePatternForContext(ctx, ['loops', loopId, stepKind, 'output', 'pattern'], step.output.pattern);
      if (step.output.contract === 'decision-artifact') {
        if (!step.output.decision) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['loops', loopId, stepKind, 'output'],
            message: `decision-artifact contract requires a 'decision' config in loop '${loopId}.${stepKind}'.`,
          });
        } else {
          const { accepted, retry } = step.output.decision;
          if (!accepted || accepted.trim() === '') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['loops', loopId, stepKind, 'output', 'decision', 'accepted'],
              message: `decision 'accepted' token in loop '${loopId}.${stepKind}' must be a non-empty string.`,
            });
          }
          if (!retry || retry.trim() === '') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['loops', loopId, stepKind, 'output', 'decision', 'retry'],
              message: `decision 'retry' token in loop '${loopId}.${stepKind}' must be a non-empty string.`,
            });
          }
          if (accepted && retry && accepted.trim().toLowerCase() === retry.trim().toLowerCase()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['loops', loopId, stepKind, 'output', 'decision'],
              message: `decision 'accepted' and 'retry' tokens in loop '${loopId}.${stepKind}' must be case-insensitively distinct.`,
            });
          }
        }
      }
      if (step.output.contract !== 'decision-artifact' && step.output.decision) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['loops', loopId, stepKind, 'output'],
          message: `Contract '${step.output.contract}' must not specify a decision config in loop '${loopId}.${stepKind}'.`,
        });
      }
    }

    // 3. Validate inputs: source must be built-in or files: key
    for (let i = 0; i < loop.inputs.length; i++) {
      const input = loop.inputs[i]!;
      validateInputSource(ctx, ['loops', loopId, 'inputs', i], input.source, loop.files ?? {});
    }
    if (loop.files) {
      validateFilesMap(ctx, ['loops', loopId, 'files'], loop.files, loop.inputs);
    }
  }

  // 4. Validate task skill references, identifiers, and output patterns
  for (const [taskId, task] of Object.entries(data.tasks)) {
    assertSafeId(ctx, ['tasks', taskId], taskId, 'task ID');
    const skill = data.skills[task.skill];
    if (!skill) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tasks', taskId, 'skill'],
        message: `Skill '${task.skill}' referenced by task '${taskId}' does not exist.`,
      });
    }
    validatePatternForContext(ctx, ['tasks', taskId, 'output', 'pattern'], task.output.pattern);
    for (let i = 0; i < task.inputs.length; i++) {
      const input = task.inputs[i]!;
      validateInputSource(ctx, ['tasks', taskId, 'inputs', i], input.source, task.files ?? {});
    }
    if (task.files) {
      validateFilesMap(ctx, ['tasks', taskId, 'files'], task.files, task.inputs);
    }
  }

  // 5. Validate pipeline stage references: each stage must reference a loop or task
  for (const [pipelineId, pipeline] of Object.entries(data.pipelines)) {
    assertSafeId(ctx, ['pipelines', pipelineId], pipelineId, 'pipeline ID');
    const stageIds = new Set<string>();
    for (let i = 0; i < pipeline.stages.length; i++) {
      const stage = pipeline.stages[i]!;
      assertSafeId(ctx, ['pipelines', pipelineId, 'stages', i, 'stageId'], stage.stageId, 'stage ID');
      if (stageIds.has(stage.stageId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pipelines', pipelineId, 'stages', i, 'stageId'],
          message: `Duplicate stageId '${stage.stageId}' in pipeline '${pipelineId}'.`,
        });
      }
      stageIds.add(stage.stageId);
      if (!stage.loop && !stage.task) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pipelines', pipelineId, 'stages', i],
          message: `Stage '${stage.stageId}' in pipeline '${pipelineId}' must reference a loop or task.`,
        });
      }
      if (stage.loop && stage.task) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pipelines', pipelineId, 'stages', i],
          message: `Stage '${stage.stageId}' in pipeline '${pipelineId}' must not reference both a loop and a task.`,
        });
      }
      if (stage.loop && !data.loops[stage.loop]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pipelines', pipelineId, 'stages', i, 'loop'],
          message: `Loop '${stage.loop}' referenced by stage '${stage.stageId}' does not exist.`,
        });
      }
      if (stage.task && !data.tasks[stage.task]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pipelines', pipelineId, 'stages', i, 'task'],
          message: `Task '${stage.task}' referenced by stage '${stage.stageId}' does not exist.`,
        });
      }
    }
  }
});

function validatePatternForContext(
  ctx: z.RefinementCtx,
  path: (string | number)[],
  pattern: string,
): void {
  try {
    validateOutputPattern(pattern);
  } catch (err: any) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path,
      message: err.message,
    });
  }
}

function validateInputSource(
  ctx: z.RefinementCtx,
  path: (string | number)[],
  source: string,
  files: Record<string, string>,
): void {
  if ((BUILT_IN_SOURCES as readonly string[]).includes(source)) return;
  if (Object.prototype.hasOwnProperty.call(files, source)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path,
    message: `Input source '${source}' is not a built-in (target, version, priorArtifact, outputPath) or a declared files: key.`,
  });
}

function validateFilesMap(
  ctx: z.RefinementCtx,
  path: (string | number)[],
  files: Record<string, string>,
  inputs: InputSpec[],
): void {
  const referencedSources = new Set(inputs.map(i => i.source));
  for (const key of Object.keys(files)) {
    if ((BUILT_IN_SOURCES as readonly string[]).includes(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: `Files key '${key}' shadows built-in input name; choose a different key.`,
      });
    }
    if (!referencedSources.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, key],
        message: `Files key '${key}' is defined in files: but not referenced as a source in inputs.`,
      });
    }
  }
}

export interface ManifestDeclarationOrder {
  loops: string[];
  tasks: string[];
  pipelines: string[];
}

export function extractDeclarationOrder(content: string): ManifestDeclarationOrder {
  const doc = YAML.parseDocument(content);
  const getKeys = (sectionKey: string): string[] => {
    const node = doc.get(sectionKey);
    if (YAML.isMap(node)) {
      return node.items.map((item: any) => String(item.key));
    }
    return [];
  };
  return {
    loops: getKeys('loops'),
    tasks: getKeys('tasks'),
    pipelines: getKeys('pipelines'),
  };
}

export type V1Manifest = z.infer<typeof V1ManifestSchema>;

export interface LoadedManifest {
  manifest: V1Manifest;
  declarationOrder: ManifestDeclarationOrder;
}

export function buildManifestSchema(_registry: ModelRegistry) {
  return V1ManifestSchema;
}

export type Manifest = V1Manifest;

/** @deprecated Only for legacy callers; prefer `V1Manifest` directly. */
export type LoopSpec = LoopBinding;
export { LoopBindingSchema as LoopSchema };

export interface ManifestPathOptions {
  manifestRoot: string;
  projectRoot: string;
}

export function loadManifest(
  filePath: string,
  registry: ModelRegistry,
  pathOptions?: ManifestPathOptions,
): LoadedManifest {
  const content = readFileSync(filePath, 'utf-8');
  const parsed = YAML.parse(content);
  const declarationOrder = extractDeclarationOrder(content);
  const version = validateSchemaVersion(parsed);
  if (version !== null && version !== V1_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Invalid manifest at ${filePath}: unsupported schemaVersion ${version} (expected ${V1_MANIFEST_SCHEMA_VERSION})`);
  }
  const schema = buildManifestSchema(registry);
  try {
    const manifest = schema.parse(parsed) as V1Manifest;
    if (pathOptions) validateManifestPaths(manifest, pathOptions);
    return { manifest, declarationOrder };
  } catch (err: any) {
    if (err instanceof z.ZodError || err?.issues) {
      const msg = err instanceof z.ZodError ? err.message : String(err);
      throw new Error(`Invalid manifest at ${filePath}: ${msg}`);
    }
    throw err;
  }
}

function validateManifestPaths(manifest: V1Manifest, paths: ManifestPathOptions): void {
  for (const [roleId, roleFile] of Object.entries(manifest.roles)) {
    const path = resolve(paths.manifestRoot, roleFile);
    if (!existsSync(path)) {
      throw new Error(`Invalid manifest: role '${roleId}' definition file not found at ${path}`);
    }
  }
  for (const [skillId, skill] of Object.entries(manifest.skills)) {
    const path = resolve(paths.manifestRoot, skill.file);
    if (!existsSync(path)) {
      throw new Error(`Invalid manifest: skill '${skillId}' definition file not found at ${path}`);
    }
  }

  const validateBinding = (bindingId: string, binding: LoopBinding | TaskBinding): void => {
    assertDeclaredProjectPath(paths.projectRoot, binding.target.path, `Binding '${bindingId}' target`);
    for (const [key, file] of Object.entries(binding.files ?? {})) {
      assertDeclaredProjectPath(paths.projectRoot, file, `Binding '${bindingId}' files.${key}`);
    }
    const outputs = 'type' in binding
      ? [binding.evaluate.output.pattern, binding.repair.output.pattern]
      : [binding.output.pattern];
    for (const pattern of outputs) {
      assertOutputWithinProject(paths.projectRoot, pattern, `Binding '${bindingId}' output pattern`);
    }
  };

  for (const [id, binding] of Object.entries(manifest.loops)) validateBinding(id, binding);
  for (const [id, binding] of Object.entries(manifest.tasks ?? {})) validateBinding(id, binding);
}

export function validateSchemaVersion(parsed: unknown): number | null {
  if (parsed && typeof parsed === 'object' && 'schemaVersion' in parsed) {
    const v = (parsed as Record<string, unknown>).schemaVersion;
    if (typeof v === 'number') return v;
  }
  return null;
}
