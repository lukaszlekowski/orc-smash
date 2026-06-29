export type Verdict = 'APPROVED' | 'REJECTED' | 'unknown';

/**
 * Shared approved/rejected token detection for a single line. Returns the
 * detected verdict, or null when the line carries neither (or both) tokens.
 * Used by both the `## Verdict`-section scan and the fallback scan so the two
 * cannot diverge on token rules.
 */
function detectVerdictInLine(line: string): Verdict | null {
  const cleanLine = line.replace(/\*/g, '').trim().toUpperCase();
  const hasApproved = /\bAPPROVED\b/.test(cleanLine);
  const hasRejected = /\bREJECTED\b/.test(cleanLine);
  if (hasApproved && !hasRejected) {
    return 'APPROVED';
  }
  if (hasRejected && !hasApproved) {
    return 'REJECTED';
  }
  return null;
}

export function parseVerdict(fileContent: string | null, stdout: string | null = null): Verdict {
  if (fileContent) {
    const lines = fileContent.split('\n');
    const verdictIndex = lines.findIndex(line => /^#+\s*Verdict/i.test(line.trim()));

    if (verdictIndex !== -1) {
      for (let i = verdictIndex + 1; i < lines.length; i++) {
        const line = lines[i]!.trim();
        if (line === '') continue;
        const detected = detectVerdictInLine(line);
        if (detected) {
          return detected;
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
    for (const line of fallbackSource.split('\n')) {
      const detected = detectVerdictInLine(line);
      if (detected) {
        return detected;
      }
    }
  }

  return 'unknown';
}
