import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArtifactMeta } from './provenance.js';
import { parseVerdict, type Verdict } from './verdict.js';

export type StepKind = 'audit' | 'follow-up';
export type StepStatus = 'running' | 'done' | 'failed';

export interface Step {
  kind: StepKind;
  role: string;            // 'auditor' | 'planner' | 'reviewer' | 'implementer' | 'unknown'
  agent: string;
  model: string;
  version: number;
  status: StepStatus;
  verdict?: Verdict;                  // audit steps only
  outcome?: 'patched' | 'blocked';    // follow-up steps only
  artifactPath: string;               // absolute path to the artifact file
  mtime: number;
}

export interface ScanResult {
  latestVersion: number;
  latestVerdict: Verdict | null;
  timeline: Step[];      // all steps, ordered
  auditSteps: Step[];    // audit-only (drives latestVerdict/proposedNext)
  proposedNext: {
    skill: 'audit' | 'follow-up';
    version: number;
    priorAuditPath: string | null;
  };
}

function getAllFiles(dir: string, baseDir: string = dir): string[] {
  let results: string[] = [];
  if (!existsSync(dir)) {
    return results;
  }
  const list = readdirSync(dir);
  for (const file of list) {
    const filePath = join(dir, file);
    const stat = statSync(filePath);
    if (stat.isDirectory()) {
      // Ignore archived directory
      if (file === 'archived' || filePath.includes('docs/dev/archived') || filePath.includes('/archived/')) {
        continue;
      }
      results = results.concat(getAllFiles(filePath, baseDir));
    } else {
      results.push(filePath);
    }
  }
  return results;
}

export function scan(
  targetRoot: string,
  patterns: { auditPattern: string; followUpPattern: string }
): ScanResult {
  const allFiles = getAllFiles(targetRoot);
  const timeline: Step[] = [];

  const auditRegex = patternToRegex(patterns.auditPattern);
  const followUpRegex = patternToRegex(patterns.followUpPattern);

  for (const file of allFiles) {
    const relPath = relative(targetRoot, file);
    const m = relPath.match(auditRegex);
    if (m) {
      const version = parseInt(m[1]!, 10);
      const agent = m[2]!;
      const content = readFileSync(file, 'utf-8');
      timeline.push({
        kind: 'audit',
        role: 'unknown',                      // overwritten from front matter if present
        agent, model: 'unknown', version,
        status: 'done',
        verdict: parseVerdict(content),
        artifactPath: file,
        mtime: statSync(file).mtimeMs
      });
      continue;
    }
    const f = relPath.match(followUpRegex);
    if (f) {
      const version = parseInt(f[1]!, 10);
      const agent = f[2]!;
      const content = readFileSync(file, 'utf-8');
      timeline.push({
        kind: 'follow-up',
        role: 'unknown',
        agent, model: 'unknown', version,
        status: 'done',
        outcome: parseOutcome(content),
        artifactPath: file,
        mtime: statSync(file).mtimeMs
      });
    }
  }

  // Enrich role/agent/model from front matter where present.
  for (const s of timeline) {
    const content = readFileSync(s.artifactPath, 'utf-8');
    const meta = parseArtifactMeta(content, { agent: s.agent, version: s.version, kind: s.kind });
    s.role = meta.role === 'unknown' ? s.role : meta.role;
    s.agent = meta.agent;
    s.model = meta.model;
  }

  sortTimeline(timeline);

  const auditSteps = timeline.filter(s => s.kind === 'audit');
  const latestAudit = auditSteps[auditSteps.length - 1];
  const latestVersion = latestAudit ? latestAudit.version : 0;
  const latestVerdict = latestAudit ? (latestAudit.verdict ?? null) : null;

  let skill: 'audit' | 'follow-up' = 'audit';
  let version = 1;
  let priorAuditPath: string | null = null;
  if (latestAudit) {
    priorAuditPath = latestAudit.artifactPath;
    if (latestVerdict === 'REJECTED') {
      skill = 'follow-up';
      version = latestVersion;
    } else {
      skill = 'audit';
      version = latestVersion + 1;
    }
  }

  return {
    latestVersion,
    latestVerdict,
    timeline,
    auditSteps,
    proposedNext: { skill, version, priorAuditPath }
  };
}

function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace('\\{n\\}', '(\\d+)')
    .replace('\\{agent\\}', '([a-zA-Z0-9_-]+)');
  return new RegExp('^' + escaped + '$');
}

function sortTimeline(t: Step[]): void {
  const kindRank = (k: StepKind) => (k === 'audit' ? 0 : 1);
  t.sort((a, b) => {
    if (a.version !== b.version) return a.version - b.version;
    if (a.kind !== b.kind) return kindRank(a.kind) - kindRank(b.kind);
    return a.mtime - b.mtime;
  });
}

/**
 * Single source of truth for follow-up outcome parsing. Called from `scan`
 * (here) AND from `loop.ts` after the follow-up run (Step 5) — do NOT
 * re-implement it inline. Matches the first `patched`/`blocked` token
 * immediately under the `## Follow-up Outcome` heading. (m2)
 */
export function parseOutcome(content: string): 'patched' | 'blocked' {
  const m = content.match(/^##\s*Follow-up Outcome\s*\r?\n\s*\r?\n?\s*(patched|blocked)\b/im);
  return m && m[1] === 'blocked' ? 'blocked' : 'patched';
}
