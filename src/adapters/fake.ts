import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentAdapter, RunInput, RunResult } from './types.js';

export const fakeAdapterState = {
  verdicts: [] as ('APPROVED' | 'REJECTED' | 'unknown')[],
  stdout: '',
  exitCode: 0,
  writeVerdictFile: true
};

export const fakeAdapter: AgentAdapter = {
  name: 'fake',

  buildRun(input: RunInput) {
    return { command: 'fake', args: [] };
  },

  async run(input: RunInput): Promise<RunResult> {
    const verdict = fakeAdapterState.verdicts.shift() || 'APPROVED';

    // Parse the output path from prompt
    // Write your output to: docs/dev/plan-audit-v1-fake.md
    // OR: Write your output to: docs/dev/review-v1-fake.md
    const match = input.prompt.match(/Write your output to:\s*([^\r\n]+)/i);
    if (match && match[1] && fakeAdapterState.writeVerdictFile) {
      const relativePath = match[1].trim();
      const absolutePath = resolve(input.cwd, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });

      let content = '';
      if (verdict === 'APPROVED') {
        content = `# Plan Audit\n\nAuditor: fake-${input.model}\n\n## Verdict\n\nAPPROVED\n`;
      } else if (verdict === 'REJECTED') {
        content = `# Plan Audit\n\nAuditor: fake-${input.model}\n\n## Verdict\n\nREJECTED\n`;
      } else {
        content = `# Plan Audit\n\nAuditor: fake-${input.model}\n\n## Verdict\n\nMALFORMED_OR_MISSING\n`;
      }
      writeFileSync(absolutePath, content);
    }

    // For follow-up skills (which don't write an output path file, but patch the target file):
    // Let's modify the target file so we show it was patched!
    const isFollowUp = input.prompt.includes('follow-up');
    if (isFollowUp) {
      const targetMatch = input.prompt.match(/Target document:\s*([^\r\n]+)/i);
      if (targetMatch && targetMatch[1]) {
        const relTarget = targetMatch[1].trim();
        if (relTarget !== '.' && relTarget !== 'none') {
          const absTarget = resolve(input.cwd, relTarget);
          writeFileSync(absTarget, `\n# Patched by follow-up\n`, { flag: 'a' });
        }
      }
    }

    return {
      stdout: fakeAdapterState.stdout || `Fake run completed with verdict ${verdict}`,
      exitCode: fakeAdapterState.exitCode
    };
  }
};
