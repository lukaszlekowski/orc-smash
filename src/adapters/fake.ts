import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentAdapter, RunInput, RunResult, RunError } from './types.js';
import { renderFollowUpOutcomeSection } from '../follow-up-outcome.js';

export const fakeAdapterState = {
  verdicts: [] as ('APPROVED' | 'REJECTED' | 'unknown')[],
  stdout: '',
  exitCode: 0,
  writeVerdictFile: true,
  auditError: undefined as RunError | undefined,
  followUpError: undefined as RunError | undefined,
  stderr: undefined as string | undefined,
  delayMs: undefined as number | undefined,
  lifecycleMessages: [] as Array<{ text: string; toolCalls: number }>,
  failAfterMs: undefined as number | undefined
};

export const fakeAdapter: AgentAdapter = {
  name: 'fake',

  buildRun(input: RunInput) {
    return { command: 'fake', args: [] };
  },

  async run(input: RunInput): Promise<RunResult> {
    const match = input.prompt.match(/Write your output to:\s*([^\r\n]+)/i);
    const relativePath = match?.[1]?.trim() ?? '';
    const isFollowUp = /followup-v\d+-/.test(relativePath);
    const isImplement = /impl-v\d+-/.test(relativePath);


    const emitStart = () => {
      if (input.onLifecycle && input.skillId && input.version !== undefined) {
        input.onLifecycle({
          type: 'started',
          agent: 'fake',
          model: input.model,
          version: input.version,
          skillId: input.skillId,
          message: 'fake spawn',
          atMs: Date.now()
        });
      }
    };

    const emitMessages = () => {
      if (input.onLifecycle && input.version !== undefined && fakeAdapterState.lifecycleMessages.length > 0) {
        for (const msg of fakeAdapterState.lifecycleMessages) {
          input.onLifecycle({
            type: 'message',
            agent: 'fake',
            version: input.version,
            text: msg.text,
            toolCalls: msg.toolCalls,
            atMs: Date.now()
          });
        }
      }
    };

    const emitEnd = (err?: RunError) => {
      if (!input.onLifecycle || input.version === undefined) return;
      if (err) {
        input.onLifecycle({
          type: 'failed',
          agent: 'fake',
          version: input.version,
          errorKind: err.kind,
          atMs: Date.now()
        });
      } else {
        input.onLifecycle({
          type: 'completed',
          agent: 'fake',
          version: input.version,
          atMs: Date.now()
        });
      }
    };

    emitStart();

    if (fakeAdapterState.delayMs) {
      await new Promise(r => setTimeout(r, fakeAdapterState.delayMs));
    }

    if (fakeAdapterState.failAfterMs) {
      if (fakeAdapterState.failAfterMs > 0) {
        await new Promise(r => setTimeout(r, fakeAdapterState.failAfterMs));
      }
      const failErr: RunError = { kind: 'nonzero-exit', message: 'simulated failure' };
      emitEnd(failErr);
      return {
        stdout: fakeAdapterState.stdout ?? '',
        exitCode: 1,
        stderr: fakeAdapterState.stderr,
        error: failErr
      };
    }

    emitMessages();

    const err = isFollowUp ? fakeAdapterState.followUpError : fakeAdapterState.auditError;
    if (err) {
      emitEnd(err);
      return {
        stdout: fakeAdapterState.stdout ?? '',
        exitCode: fakeAdapterState.exitCode,
        stderr: fakeAdapterState.stderr,
        error: err
      };
    }

    if (isImplement) {
      if (relativePath && fakeAdapterState.writeVerdictFile) {
        const absolutePath = resolve(input.cwd, relativePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        writeFileSync(absolutePath,
          `# Implementation Evidence Ledger\n\n` +
          `## Implementation Evidence Ledger\n\n` +
          `| Plan Step | Files Changed | Tests / Verification | Result | Deviation |\n` +
          `| --- | --- | --- | --- | --- |\n` +
          `| Step 1 | src/config.ts | pnpm test | pass | none |\n\n` +
          `## Requirement Coverage\n\n` +
          `| Spec Requirement / Checklist Item | Implemented In | Verified By | Status |\n` +
          `| --- | --- | --- | --- |\n` +
          `| Config-driven timeouts | src/config.ts | tests/config.test.ts | pass |\n\n` +
          `State overall confidence: 1.00\n`
        );
      }
      emitEnd();
      return {
        stdout: fakeAdapterState.stdout || `Fake implementation completed`,
        exitCode: fakeAdapterState.exitCode
      };
    }

    if (!isFollowUp) {
      // --- Audit path: consume exactly one verdict, write the audit artifact. ---
      const verdict = fakeAdapterState.verdicts.shift() || 'APPROVED';
      if (relativePath && fakeAdapterState.writeVerdictFile) {
        const absolutePath = resolve(input.cwd, relativePath);
        mkdirSync(dirname(absolutePath), { recursive: true });
        const heading = verdict === 'unknown' ? 'MALFORMED_OR_MISSING' : verdict;
        writeFileSync(absolutePath, `# Plan Audit\n\n## Verdict\n\n${heading}\n`);
      }
      emitEnd();
      return {
        stdout: fakeAdapterState.stdout || `Fake run completed with verdict ${verdict}`,
        exitCode: fakeAdapterState.exitCode
      };
    }

    // --- Follow-up path ---
    if (relativePath && fakeAdapterState.writeVerdictFile) {
      const absolutePath = resolve(input.cwd, relativePath);
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath,
        `# Plan Follow-up\n\n${renderFollowUpOutcomeSection('patched')}\n\nFiles patched: docs/dev/plan.md\n`);
    }
    const targetMatch = input.prompt.match(/Target document:\s*([^\r\n]+)/i);
    if (targetMatch?.[1]) {
      const relTarget = targetMatch[1].trim();
      if (relTarget !== '.' && relTarget !== 'none') {
        writeFileSync(resolve(input.cwd, relTarget), `\n# Patched by follow-up\n`, { flag: 'a' });
      }
    }
    emitEnd();
    return {
      stdout: fakeAdapterState.stdout || `Fake follow-up completed`,
      exitCode: fakeAdapterState.exitCode
    };
  }
};
