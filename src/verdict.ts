export type Verdict = 'APPROVED' | 'REJECTED' | 'unknown';

export function parseVerdict(fileContent: string | null, stdout: string | null = null): Verdict {
  if (fileContent) {
    const lines = fileContent.split('\n');
    const verdictIndex = lines.findIndex(line => /^#+\s*Verdict/i.test(line.trim()));

    if (verdictIndex !== -1) {
      for (let i = verdictIndex + 1; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (line === '') continue;
        const cleanLine = line.replace(/\*/g, '').trim().toUpperCase();
        const hasApproved = /\bAPPROVED\b/.test(cleanLine);
        const hasRejected = /\bREJECTED\b/.test(cleanLine);
        if (hasApproved && !hasRejected) {
          return 'APPROVED';
        }
        if (hasRejected && !hasApproved) {
          return 'REJECTED';
        }
        // If we hit another heading without finding APPROVED/REJECTED, stop
        if (/^#+/.test(line)) {
          break;
        }
      }
    }
  }

  // Fallback to stdout or file content if ## Verdict header was not found
  const fallbackSource = stdout || fileContent;
  if (fallbackSource) {
    const lines = fallbackSource.split('\n');
    for (const line of lines) {
      const cleanLine = line.replace(/\*/g, '').trim().toUpperCase();
      const hasApproved = /\bAPPROVED\b/.test(cleanLine);
      const hasRejected = /\bREJECTED\b/.test(cleanLine);
      if (hasApproved && !hasRejected) {
        return 'APPROVED';
      }
      if (hasRejected && !hasApproved) {
        return 'REJECTED';
      }
    }
  }

  return 'unknown';
}
