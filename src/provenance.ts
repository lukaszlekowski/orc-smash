import { writeFileSync, renameSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import YAML from 'yaml';

export type StepKind = 'audit' | 'follow-up' | 'implement' | 'evaluate' | 'repair' | 'task';

export type ChainMode = 'pipeline-start' | 'stage-continuation' | 'ad-hoc' | 'second-opinion';

// Legacy fields retained alongside new fields for migration.
export interface ArtifactMeta {
  // legacy fields
  loop: string;
  skill: string;
  kind: StepKind;
  role: string;
  version: number;
  step?: 'evaluate' | 'repair' | 'task';
  agent: string;
  model: string;
  target: string;
  priorAudit: string;
  timestamp: string;
  durationMs?: number;
  sessionMode?: 'fresh' | 'resumed' | 'none';
  sessionId?: string | 'none';

  // v1 identity fields (Pipeline Run Identity)
  schemaVersion?: number;
  bindingKind?: string;
  bindingId?: string;
  chainId?: string;
  chainMode?: ChainMode;
  artifactIdentity?: string;
  inputFingerprint?: string;
  resultFingerprint?: string;
  parentArtifactIdentity?: string | null;
  pipelineId?: string | null;
  pipelineRunId?: string | null;
  stageId?: string | null;
  provider?: string;
  effort?: string;
  sessionStrategy?: string;
}

/**
 * Classified parse: returns unclassified when required identity fields are absent
 * for a pipeline artifact, or when the artifact is incomplete/interrupted.
 */
export function parseArtifactMetaClassified(
  content: string,
  fallback: { agent: string; version: number; kind?: StepKind }
): ParseResult {
  const frontMatter = extractFrontMatter(content);
  const meta = parseArtifactMeta(content, fallback);
  if (!frontMatter) {
    return { status: 'unclassified', reason: 'Artifact has no v1 provenance front matter.', meta };
  }

  let raw: Record<string, unknown>;
  try {
    raw = (YAML.parse(frontMatter) ?? {}) as Record<string, unknown>;
  } catch {
    return { status: 'unclassified', reason: 'Artifact provenance front matter is malformed.', meta };
  }

  const requiredFields = [
    'schemaVersion',
    'pipelineId',
    'pipelineRunId',
    'stageId',
    'bindingKind',
    'bindingId',
    'chainId',
    'chainMode',
    'step',
    'artifactIdentity',
    'inputFingerprint',
    'resultFingerprint',
    'parentArtifactIdentity',
    'version',
    'provider',
    'model',
    'sessionStrategy',
    'sessionMode',
    'sessionId',
  ];
  const missing = requiredFields.filter((field) => {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) return true;
    const value = raw[field];
    return value === undefined || (typeof value === 'string' && value.length === 0);
  });
  if (missing.length > 0) {
    return { status: 'unclassified', reason: `Missing required identity fields: ${missing.join(', ')}`, meta };
  }

  const stringFields = [
    'bindingId',
    'chainId',
    'artifactIdentity',
    'inputFingerprint',
    'resultFingerprint',
    'provider',
    'model',
    'sessionStrategy',
    'sessionMode',
    'sessionId',
  ];
  const invalidStringField = stringFields.find((field) => typeof raw[field] !== 'string');
  if (invalidStringField) {
    return { status: 'unclassified', reason: `Identity field '${invalidStringField}' must be a string.`, meta };
  }
  if (typeof raw.version !== 'number' || !Number.isInteger(raw.version) || raw.version < 0) {
    return { status: 'unclassified', reason: 'Artifact version must be a non-negative integer.', meta };
  }
  if (raw.parentArtifactIdentity !== null && typeof raw.parentArtifactIdentity !== 'string') {
    return { status: 'unclassified', reason: 'parentArtifactIdentity must be a string or null.', meta };
  }
  if (raw.provider !== raw.agent && raw.agent !== undefined) {
    return { status: 'unclassified', reason: 'Artifact provider and agent provenance disagree.', meta };
  }
  const hasFilenameContext = fallback.agent !== 'unknown' || fallback.version !== 0;
  if (hasFilenameContext && (raw.version !== fallback.version || raw.provider !== fallback.agent)) {
    return { status: 'unclassified', reason: 'Artifact filename provider/version does not match provenance.', meta };
  }
  if (raw.schemaVersion !== 1) {
    return { status: 'unclassified', reason: `Unsupported artifact schemaVersion '${String(raw.schemaVersion)}'.`, meta };
  }
  if (raw.bindingKind !== 'loop' && raw.bindingKind !== 'task') {
    return { status: 'unclassified', reason: `Invalid bindingKind '${String(raw.bindingKind)}'.`, meta };
  }
  if (!['evaluate', 'repair', 'task'].includes(String(raw.kind))) {
    return { status: 'unclassified', reason: `Invalid artifact kind '${String(raw.kind)}'.`, meta };
  }
  if (raw.step !== raw.kind) {
    return { status: 'unclassified', reason: 'Artifact step must match its kind.', meta };
  }

  const pipelineId = raw.pipelineId;
  const pipelineRunId = raw.pipelineRunId;
  const stageId = raw.stageId;
  const parent = raw.parentArtifactIdentity;
  if (pipelineId === null) {
    if (pipelineRunId !== null || stageId !== null) {
      return { status: 'unclassified', reason: 'Ad-hoc artifacts must have null pipelineRunId and stageId.', meta };
    }
  } else if (typeof pipelineId !== 'string' || typeof pipelineRunId !== 'string' || typeof stageId !== 'string') {
    return { status: 'unclassified', reason: 'Pipeline artifacts require pipelineId, pipelineRunId, and stageId.', meta };
  }

  const chainMode = raw.chainMode;
  if (!['pipeline-start', 'stage-continuation', 'ad-hoc', 'second-opinion'].includes(String(chainMode))) {
    return { status: 'unclassified', reason: `Invalid chainMode '${String(chainMode)}'.`, meta };
  }
  if (chainMode === 'stage-continuation' && (typeof parent !== 'string' || parent.length === 0)) {
    return { status: 'unclassified', reason: 'stage-continuation requires a non-null parentArtifactIdentity.', meta };
  }
  if (chainMode === 'pipeline-start' && (pipelineId === null || pipelineRunId === null || stageId === null)) {
    return { status: 'unclassified', reason: 'pipeline-start artifacts require pipeline identity fields.', meta };
  }
  if (chainMode === 'stage-continuation' && (pipelineId === null || pipelineRunId === null || stageId === null)) {
    return { status: 'unclassified', reason: 'stage-continuation artifacts require pipeline identity fields.', meta };
  }
  if (raw.bindingKind === 'task' && raw.kind !== 'task') {
    return { status: 'unclassified', reason: 'Task artifacts must use kind task.', meta };
  }
  if (raw.bindingKind === 'loop' && raw.kind === 'task') {
    return { status: 'unclassified', reason: 'Loop artifacts cannot use kind task.', meta };
  }
  if (chainMode === 'ad-hoc' && (pipelineId !== null || pipelineRunId !== null || stageId !== null)) {
    return { status: 'unclassified', reason: 'ad-hoc artifacts must not claim pipeline identity.', meta };
  }

  return { status: 'classified', meta };
}

/** Build the canonical front-matter block (with trailing blank line). */
export function buildFrontMatter(meta: ArtifactMeta): string {
  const yaml = YAML.stringify(meta).trimEnd();
  return `---\n${yaml}\n---\n\n`;
}

/** Write body with harness-owned front matter, atomically (temp + rename). */
export function writeArtifactWithMeta(absPath: string, body: string, meta: ArtifactMeta): void {
  const full = buildFrontMatter(meta) + body;
  const tmp = join(dirname(absPath), `.${basename(absPath)}.${process.pid}.tmp`);
  writeFileSync(tmp, full, 'utf-8');
  renameSync(tmp, absPath);
}

/** Extract the first leading ---\n...\n--- block, or null. */
function extractFrontMatter(content: string): string | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return m ? m[1]! : null;
}

export type ParseResult =
  | { status: 'classified'; meta: ArtifactMeta }
  | { status: 'unclassified'; reason: string; meta: Partial<ArtifactMeta> }
  | { status: 'interrupted'; reason: string; meta: Partial<ArtifactMeta> };

/**
 * Read canonical metadata from harness-owned front matter.
 * Returns `unclassified` when required identity fields are absent for the
 * artifact's claimed invocation mode (pipeline artifacts with missing fields,
 * or any artifact with inconsistent identity).
 */
export function parseArtifactMeta(
  content: string,
  fallback: { agent: string; version: number; kind?: StepKind }
): ArtifactMeta {
  const fm = extractFrontMatter(content);
  if (fm) {
    const obj = (YAML.parse(fm) ?? {}) as Partial<ArtifactMeta>;
    const meta: ArtifactMeta = {
      loop: obj.loop ?? 'unknown',
      skill: obj.skill ?? 'unknown',
      kind: obj.kind ?? fallback.kind ?? 'audit',
      role: obj.role ?? 'unknown',
      version: typeof obj.version === 'number' ? obj.version : fallback.version,
      agent: obj.agent ?? fallback.agent,
      model: obj.model ?? 'unknown',
      target: obj.target ?? 'unknown',
      priorAudit: obj.priorAudit ?? 'none',
      timestamp: obj.timestamp ?? '',
    };

    // Preserve the compact legacy shape when a pre-v1 artifact is parsed, but
    // retain every explicitly serialized v1 field (including explicit nulls).
    // This makes round-tripping lossless without manufacturing undefined keys.
    const optionalKeys: (keyof ArtifactMeta)[] = [
      'durationMs', 'sessionMode', 'sessionId', 'schemaVersion', 'bindingKind',
      'bindingId', 'chainId', 'chainMode', 'artifactIdentity',
      'inputFingerprint', 'resultFingerprint', 'parentArtifactIdentity',
      'pipelineId', 'pipelineRunId', 'stageId', 'provider', 'effort',
      'sessionStrategy', 'step',
    ];
    for (const key of optionalKeys) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        (meta as any)[key] = obj[key];
      }
    }
    if (typeof obj.durationMs !== 'number' && Object.prototype.hasOwnProperty.call(obj, 'durationMs')) {
      delete (meta as any).durationMs;
    }
    if (typeof obj.schemaVersion !== 'number' && Object.prototype.hasOwnProperty.call(obj, 'schemaVersion')) {
      delete (meta as any).schemaVersion;
    }
    if (obj.chainMode !== undefined) {
      meta.chainMode = obj.chainMode as ChainMode;
    }
    return meta;
  }

  return {
    loop: 'unknown',
    skill: 'unknown',
    kind: fallback.kind ?? 'audit',
    role: 'unknown',
    version: fallback.version,
    agent: fallback.agent,
    model: 'unknown',
    target: 'unknown',
    priorAudit: 'none',
    timestamp: '',
    durationMs: undefined,
  };
}
