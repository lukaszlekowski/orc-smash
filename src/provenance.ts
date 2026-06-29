import { writeFileSync, renameSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import YAML from 'yaml';

export type StepKind = 'audit' | 'follow-up';

export interface ArtifactMeta {
  loop: string;
  skill: string;
  kind: StepKind;
  role: string;
  version: number;
  agent: string;
  model: string;
  target: string;
  priorAudit: string;   // relative path or 'none'
  timestamp: string;    // ISO 8601
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

/**
 * Read canonical metadata from harness-owned front matter. When front matter is
 * absent, the result is built ONLY from the caller-supplied fallback values
 * (`agent`, `version`, `kind`); nothing is inferred from document prose. The
 * legacy HTML-comment and `Auditor:` header fallback paths have been removed —
 * the harness only owns the front-matter contract.
 */
export function parseArtifactMeta(
  content: string,
  fallback: { agent: string; version: number; kind?: StepKind }
): ArtifactMeta {
  const fm = extractFrontMatter(content);
  if (fm) {
    const obj = (YAML.parse(fm) ?? {}) as Partial<ArtifactMeta>;
    return {
      loop: obj.loop ?? 'unknown',
      skill: obj.skill ?? 'unknown',
      kind: obj.kind ?? fallback.kind ?? 'audit',
      role: obj.role ?? 'unknown',
      version: typeof obj.version === 'number' ? obj.version : fallback.version,
      agent: obj.agent ?? fallback.agent,
      model: obj.model ?? 'unknown',
      target: obj.target ?? 'unknown',
      priorAudit: obj.priorAudit ?? 'none',
      timestamp: obj.timestamp ?? ''
    };
  }

  // No front matter: use only the caller-supplied fallback values.
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
    timestamp: ''
  };
}
