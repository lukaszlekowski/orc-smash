export interface Provenance {
  agent: string;
  model: string;
  version: number;
}

export function stampProvenance(agent: string, model: string, version: number): string {
  return `\n<!-- orc-smash-provenance agent="${agent}" model="${model}" version="${version}" -->`;
}

export function parseProvenance(fileContent: string, filenameAgent: string, filenameVersion: number): Provenance {
  // 1. Check for orc-smash-provenance comment
  const commentRegex = /<!--\s*orc-smash-provenance\s+agent="([^"]+)"\s+model="([^"]+)"\s+version="(\d+)"\s*-->/;
  const commentMatch = fileContent.match(commentRegex);
  if (commentMatch) {
    return {
      agent: commentMatch[1]!,
      model: commentMatch[2]!,
      version: parseInt(commentMatch[3]!, 10)
    };
  }

  // 2. Check for Auditor: header
  const auditorRegex = /^[#\s]*Auditor:\s*([^\s\r\n]+)/im;
  const auditorMatch = fileContent.match(auditorRegex);
  if (auditorMatch) {
    const rawAuditor = auditorMatch[1]!;
    const parts = rawAuditor.split('-');
    const parsedAgent = parts[0]!;
    const parsedModel = parts.slice(1).join('-');

    const knownAgents = ['opencode', 'codex', 'claude', 'fake'];
    if (knownAgents.includes(parsedAgent)) {
      return {
        agent: parsedAgent,
        model: parsedModel || 'unknown',
        version: filenameVersion
      };
    } else {
      // If the prefix is not a known agent, let's treat the whole thing as model, and use filenameAgent as agent
      return {
        agent: filenameAgent,
        model: rawAuditor,
        version: filenameVersion
      };
    }
  }

  // 3. Fallback to filename
  return {
    agent: filenameAgent,
    model: 'unknown',
    version: filenameVersion
  };
}
