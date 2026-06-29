import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArtifactMeta } from './provenance.js';
import { parseVerdict, type Verdict } from './verdict.js';
import { patternToRegex } from './patterns.js';
import { parseFollowUpOutcome, type FollowUpOutcome } from './follow-up-outcome.js';

// Canonical StepKind lives in src/provenance.ts (single source of truth);
// state.ts imports + re-exports it instead of redeclaring.
import type { StepKind } from './provenance.js';
export type { StepKind };

export type StepStatus = 'running' | 'done' | 'failed';

export interface Step {
  kind: StepKind;
  role: string;            // 'auditor' | 'planner' | 'reviewer' | 'implementer' | 'unknown'
  agent: string;
  model: string;
  version: number;
  status: StepStatus;
  verdict?: Verdict;                  // audit steps only
  outcome?: FollowUpOutcome;    // follow-up steps only
  artifactPath: string;               // absolute path to the artifact file
  mtime: number;
}

export interface ScanResult {
  latestVersion: number;
  latestVerdict: Verdict | null;
  timeline: Step[];      // all steps, ordered
  auditSteps: Step[];    // audit-only (drives latestVerdict)
}

function getAllFiles(dir: string): string[] {
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
      results = results.concat(getAllFiles(filePath));
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
    const auditMatch = relPath.match(auditRegex);
    const match = auditMatch ?? relPath.match(followUpRegex);
    if (!match) continue;

    const version = parseInt(match[1]!, 10);
    const agent = match[2]!;
    const kind: StepKind = auditMatch ? 'audit' : 'follow-up';

    // Read each artifact exactly once and reuse the same content for verdict/outcome
    // parsing AND front-matter metadata enrichment (previously read twice).
    const content = readFileSync(file, 'utf-8');
    const meta = parseArtifactMeta(content, { agent, version, kind });
    const stat = statSync(file);

    if (kind === 'audit') {
      timeline.push({
        kind: 'audit',
        role: meta.role,                      // front matter where present, else 'unknown'
        agent: meta.agent,
        model: meta.model,
        version,
        status: 'done',
        verdict: parseVerdict(content),
        artifactPath: file,
        mtime: stat.mtimeMs
      });
    } else {
      timeline.push({
        kind: 'follow-up',
        role: meta.role,
        agent: meta.agent,
        model: meta.model,
        version,
        status: 'done',
        outcome: parseFollowUpOutcome(content),
        artifactPath: file,
        mtime: stat.mtimeMs
      });
    }
  }

  sortTimeline(timeline);

  const auditSteps = timeline.filter(s => s.kind === 'audit');
  const latestAudit = auditSteps[auditSteps.length - 1];
  const latestVersion = latestAudit ? latestAudit.version : 0;
  const latestVerdict = latestAudit ? (latestAudit.verdict ?? null) : null;

  // state.ts is a fact-scanning module only: it normalizes filesystem facts.
  // Restart / next-step policy lives in src/next-step.ts (resolveNextStep), not here.

  return {
    latestVersion,
    latestVerdict,
    timeline,
    auditSteps
  };
}

function sortTimeline(t: Step[]): void {
  const kindRank = (k: StepKind) => {
    if (k === 'audit') return 0;
    if (k === 'follow-up') return 1;
    return 2;
  };
  t.sort((a, b) => {
    if (a.version !== b.version) return a.version - b.version;
    if (a.kind !== b.kind) return kindRank(a.kind) - kindRank(b.kind);
    return a.mtime - b.mtime;
  });
}

function relativize(targetRoot: string, p: string): string {
  if (p === 'none') return 'none';
  if (p.startsWith(targetRoot)) {
    return relative(targetRoot, p);
  }
  return p;
}

export function resolveApprovedPlanAuditPath(
  targetRoot: string,
  planSpec: { auditPattern: string; followUpPattern: string }
): string | null {
  const s = scan(targetRoot, { auditPattern: planSpec.auditPattern, followUpPattern: planSpec.followUpPattern });
  return s.latestVerdict === 'APPROVED'
    ? (s.auditSteps.at(-1)?.artifactPath ?? null)
    : null;
}

export function scanImplementArtifacts(
  targetRoot: string,
  implementPattern: string
): { version: number; priorAudit: string; agent: string }[] {
  const allFiles = getAllFiles(targetRoot);
  const regex = patternToRegex(implementPattern);
  const results: { version: number; priorAudit: string; agent: string }[] = [];

  for (const file of allFiles) {
    const relPath = relative(targetRoot, file);
    const match = relPath.match(regex);
    if (!match) continue;

    const version = parseInt(match[1]!, 10);
    const agent = match[2]!;

    const content = readFileSync(file, 'utf-8');
    const meta = parseArtifactMeta(content, { agent, version, kind: 'implement' });
    results.push({
      version,
      priorAudit: meta.priorAudit,
      agent: meta.agent
    });
  }
  return results;
}

export function resolveImplementFacts(
  targetRoot: string,
  planSpec: { auditPattern: string; followUpPattern: string },
  implementSpec: { implementPattern: string }
): { approvedPlanAuditPath: string | null; nextVersion: number; currentPlanImplemented: boolean } {
  const approvedPlanAuditPath = resolveApprovedPlanAuditPath(targetRoot, planSpec);
  const impls = scanImplementArtifacts(targetRoot, implementSpec.implementPattern);

  const maxVersion = impls.reduce((max, impl) => Math.max(max, impl.version), 0);
  const nextVersion = maxVersion + 1;

  let currentPlanImplemented = false;
  if (approvedPlanAuditPath) {
    const relApproved = relativize(targetRoot, approvedPlanAuditPath);
    currentPlanImplemented = impls.some(impl => relativize(targetRoot, impl.priorAudit) === relApproved);
  }

  return {
    approvedPlanAuditPath,
    nextVersion,
    currentPlanImplemented
  };
}

export function requireApprovedPlanAuditPath(
  targetRoot: string,
  planSpec: { auditPattern: string; followUpPattern: string }
): string {
  const approvedPath = resolveApprovedPlanAuditPath(targetRoot, planSpec);
  if (!approvedPath) {
    throw new Error('No approved plan audit found; implementation requires an APPROVED plan.');
  }
  return approvedPath;
}


