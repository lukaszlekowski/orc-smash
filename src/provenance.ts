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

export interface Provenance {
  agent: string;
  model: string;
  version: number;
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
 * Read canonical metadata. Front matter wins; legacy HTML-comment and
 * `Auditor:` header paths survive only as fallbacks for historical artifacts.
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
  const p = parseLegacyProvenance(content, fallback.agent, fallback.version);
  return {
    loop: 'unknown',
    skill: 'unknown',
    kind: fallback.kind ?? 'audit',
    role: 'unknown',
    version: p.version,
    agent: p.agent,
    model: p.model,
    target: 'unknown',
    priorAudit: 'none',
    timestamp: ''
  };
}

/** Back-compat shim: returns just agent/model/version. Delegates to parseArtifactMeta. */
export function parseProvenance(content: string, filenameAgent: string, filenameVersion: number): Provenance {
  const m = parseArtifactMeta(content, { agent: filenameAgent, version: filenameVersion });
  return { agent: m.agent, model: m.model, version: m.version };
}

// --- Legacy parsers (fallback only) ---------------------------------------

function parseLegacyProvenance(content: string, filenameAgent: string, filenameVersion: number): Provenance {
  const comment = content.match(/<!--\s*orc-smash-provenance\s+agent="([^"]+)"\s+model="([^"]+)"\s+version="(\d+)"\s*-->/);
  if (comment) {
    return { agent: comment[1]!, model: comment[2]!, version: parseInt(comment[3]!, 10) };
  }
  const auditor = content.match(/^[#\s]*Auditor:\s*([^\s\r\n]+)/im);
  if (auditor) {
    const raw = auditor[1]!;
    const parts = raw.split('-');
    const parsedAgent = parts[0]!;
    const parsedModel = parts.slice(1).join('-');
    const knownAgents = ['opencode', 'codex', 'claude', 'fake'];
    if (knownAgents.includes(parsedAgent)) {
      return { agent: parsedAgent, model: parsedModel || 'unknown', version: filenameVersion };
    }
    return { agent: filenameAgent, model: raw, version: filenameVersion };
  }
  return { agent: filenameAgent, model: 'unknown', version: filenameVersion };
}
