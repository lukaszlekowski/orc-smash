import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentAdapter, RunInput, RunResult, RunError } from './types.js';

export const fakeAdapterState = {
  verdicts: [] as ('APPROVED' | 'REJECTED' | 'unknown')[],
  stdout: '',
  exitCode: 0,
  writeVerdictFile: true,
  auditError: undefined as RunError | undefined,
  followUpError: undefined as RunError | undefined,
  stderr: undefined as string | undefined
};

export const fakeAdapter: AgentAdapter = {
  name: 'fake',

  buildRun(input: RunInput) {
    return { command: 'fake', args: [] };
  },

  async run(input: RunInput): Promise<RunResult> {
    // The harness composes the output path; read it back to (a) know where to write
    // and (b) decide kind. kind comes from the harness-controlled path token
    // (`followup-v{n}-`), NEVER from prompt prose — the old `includes('follow-up')`
    // match was dead-code-by-token + fragile (any audit-skill prose mentioning
    // "follow-up" would have flipped detection) (M1).
    const match = input.prompt.match(/Write your output to:\s*([^\r\n]+)/i);
    const relativePath = match?.[1]?.trim() ?? '';
    const isFollowUp = /followup-v\d+-/.test(relativePath);   // token, not prose

    const err = isFollowUp ? fakeAdapterState.followUpError : fakeAdapterState.auditError;
    if (err) {
      return {
        stdout: fakeAdapterState.stdout ?? '',
        exitCode: fakeAdapterState.exitCode,
        stderr: fakeAdapterState.stderr,
        error: err
      };
    }

    if (!isFollowUp) {
      // --- Audit path: consume exactly one verdict, write the audit artifact. ---
      const verdict = fakeAdapterState.verdicts.shift() || 'APPROVED';   // shift() ONLY here (m6)
      if (relativePath && fakeAdapterState.writeVerdictFile) {
        const absolutePath = resolve(input.cwd, relativePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        const heading = verdict === 'unknown' ? 'MALFORMED_OR_MISSING' : verdict;
        writeFileSync(absolutePath, `# Plan Audit\n\n## Verdict\n\n${heading}\n`);  // no self-reported `Auditor:` line
      }
      return {
        stdout: fakeAdapterState.stdout || `Fake run completed with verdict ${verdict}`,
        exitCode: fakeAdapterState.exitCode
      };
    }

    // --- Follow-up path: shift NO verdict; write the follow-up artifact, then patch the target. ---
    if (relativePath && fakeAdapterState.writeVerdictFile) {
      const absolutePath = resolve(input.cwd, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath,
        `# Plan Follow-up\n\n## Follow-up Outcome\n\npatched\n\nFiles patched: docs/dev/plan.md\n`);
    }
    const targetMatch = input.prompt.match(/Target document:\s*([^\r\n]+)/i);
    if (targetMatch?.[1]) {
      const relTarget = targetMatch[1].trim();
      if (relTarget !== '.' && relTarget !== 'none') {
        writeFileSync(resolve(input.cwd, relTarget), `\n# Patched by follow-up\n`, { flag: 'a' });
      }
    }
    return {
      stdout: fakeAdapterState.stdout || `Fake follow-up completed`,
      exitCode: fakeAdapterState.exitCode
    };
  }
};
