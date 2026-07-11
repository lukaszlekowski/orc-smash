import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import YAML from 'yaml';

export interface PlanMetadataSuccess {
  ok: true;
  body: string;
}

export interface PlanMetadataFailure {
  ok: false;
  error: string;
}

export type PlanMetadataResult = PlanMetadataSuccess | PlanMetadataFailure;

function splitFrontMatter(content: string): { yaml: string; body: string } | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  return match ? { yaml: match[1]!, body: content.slice(match[0].length) } : null;
}

function parseYaml(yaml: string): Record<string, unknown> | PlanMetadataFailure {
  const document = YAML.parseDocument(yaml);
  if (document.errors.length > 0) {
    return { ok: false, error: `plan front matter is malformed: ${document.errors[0]!.message}` };
  }
  const value = document.toJSON();
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'plan front matter must be a YAML mapping' };
  }
  return value as Record<string, unknown>;
}

function isFailure(value: Record<string, unknown> | PlanMetadataFailure): value is PlanMetadataFailure {
  return value.ok === false;
}

function stripLegacyStatus(body: string): string {
  return body.replace(/^(?:\*\*Status:\*\*[^\r\n]*(?:\r?\n){1,2})/i, '');
}

/**
 * Make plan YAML metadata canonical before implementation begins. A legacy
 * leading Markdown status line is migrated away; malformed existing YAML is a
 * preflight error so no provider is started against an ambiguous plan.
 */
export function initializePlanMetadata(planPath: string): PlanMetadataResult {
  if (!existsSync(planPath)) return { ok: false, error: `plan file not found at ${planPath}` };

  let original: string;
  try {
    original = readFileSync(planPath, 'utf-8');
  } catch (error: any) {
    return { ok: false, error: `unable to read plan file at ${planPath}: ${error.message}` };
  }

  const existing = splitFrontMatter(original);
  const metadata = existing ? parseYaml(existing.yaml) : {};
  if (isFailure(metadata)) return metadata;

  const canonical = { ...(metadata as Record<string, unknown>), status: 'ready' };
  const body = stripLegacyStatus(existing ? existing.body : original);
  writeFileSync(planPath, `---\n${YAML.stringify(canonical).trimEnd()}\n---\n${body}`, 'utf-8');
  return { ok: true, body };
}

/** Validate that closeout is operating on the canonical, parseable YAML shape. */
export function validateCanonicalPlanMetadata(planPath: string): PlanMetadataResult {
  if (!existsSync(planPath)) return { ok: false, error: `plan file not found at ${planPath}` };
  try {
    const existing = splitFrontMatter(readFileSync(planPath, 'utf-8'));
    if (!existing) return { ok: false, error: 'plan file has no front matter (missing `---` delimiters)' };
    const metadata = parseYaml(existing.yaml);
    if (isFailure(metadata)) return metadata;
    if (!Object.prototype.hasOwnProperty.call(metadata, 'status')) {
      return { ok: false, error: 'plan front matter has no `status:` field' };
    }
    return { ok: true, body: existing.body };
  } catch (error: any) {
    return { ok: false, error: `unable to read plan file at ${planPath}: ${error.message}` };
  }
}
