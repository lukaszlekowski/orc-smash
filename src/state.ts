import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseProvenance } from './provenance.js';
import { parseVerdict, type Verdict } from './verdict.js';

export interface HistoryEntry {
  version: number;
  agent: string;
  model: string;
  verdict: Verdict;
  filePath: string;
  mtime: number;
}

export interface ScanResult {
  latestVersion: number;
  latestVerdict: Verdict | null;
  history: HistoryEntry[];
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

export function scan(targetRoot: string, auditPattern: string): ScanResult {
  const allFiles = getAllFiles(targetRoot);
  const history: HistoryEntry[] = [];

  // Translate auditPattern to a regex.
  // auditPattern is like: docs/dev/plan-audit-v{n}-{agent}.md
  // We need to match the relative path.
  // Let's escape special regex chars but keep {n} and {agent}
  const escapedPattern = auditPattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace('\\{n\\}', '(\\d+)')
    .replace('\\{agent\\}', '([a-zA-Z0-9_-]+)');
  
  const patternRegex = new RegExp('^' + escapedPattern + '$');

  for (const file of allFiles) {
    const relPath = relative(targetRoot, file);
    const match = relPath.match(patternRegex);
    if (match) {
      const version = parseInt(match[1]!, 10);
      const agent = match[2]!;
      const content = readFileSync(file, 'utf-8');
      const mtime = statSync(file).mtimeMs;
      
      const verdict = parseVerdict(content);
      const prov = parseProvenance(content, agent, version);

      history.push({
        version,
        agent: prov.agent,
        model: prov.model,
        verdict,
        filePath: file,
        mtime
      });
    }
  }

  // Sort history: version ascending, then mtime ascending
  history.sort((a, b) => {
    if (a.version !== b.version) {
      return a.version - b.version;
    }
    return a.mtime - b.mtime;
  });

  const latestEntry = history[history.length - 1];
  const latestVersion = latestEntry ? latestEntry.version : 0;
  const latestVerdict = latestEntry ? latestEntry.verdict : null;

  let skill: 'audit' | 'follow-up' = 'audit';
  let version = 1;
  let priorAuditPath: string | null = null;

  if (latestEntry) {
    if (latestVerdict === 'REJECTED') {
      skill = 'follow-up';
      version = latestVersion + 1;
      priorAuditPath = latestEntry.filePath;
    } else {
      skill = 'audit';
      version = latestVersion + 1;
      priorAuditPath = latestEntry.filePath;
    }
  }

  return {
    latestVersion,
    latestVerdict,
    history,
    proposedNext: {
      skill,
      version,
      priorAuditPath
    }
  };
}
