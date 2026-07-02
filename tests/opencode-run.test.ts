import { describe, it, expect } from 'vitest';
import { spawnOpencode } from '../src/adapters/utils.js';
import type { RunInput } from '../src/adapters/types.js';

describe('opencode run execution seam tests', () => {
  const baseInput: RunInput = {
    prompt: 'hello',
    model: 'deepseek-v4-flash',
    cwd: '/fake/cwd',
    skillId: 'plan-audit',
    version: 1
  };

  it('populates RunResult.sessionId from parsed sessionID in stdout stream', async () => {
    const rawStdout = '{"type":"step_start","timestamp":1783011546031,"sessionID":"ses_target123"}\n' +
                      '{"type":"text","part":{"text":"Done."}}\n' +
                      '{"type":"step_finish","part":{"reason":"stop"}}';

    const mockProcessRunner = async () => ({
      stdout: rawStdout,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      signal: null,
      durationMs: 50
    });

    const result = await spawnOpencode(baseInput, [], { processRunner: mockProcessRunner });
    expect(result.sessionId).toBe('ses_target123');
    expect(result.stdout).toBe('Done.');
    expect(result.error).toBeUndefined();
  });

  it('surfaces a structured failure if the resumed sessionID differs from the requested sessionID', async () => {
    const input: RunInput = {
      ...baseInput,
      continuity: {
        mode: 'resumed',
        sessionId: 'ses_expected123'
      }
    };

    const rawStdout = '{"type":"step_start","timestamp":1783011546031,"sessionID":"ses_actual456"}\n' +
                      '{"type":"text","part":{"text":"Done."}}\n' +
                      '{"type":"step_finish","part":{"reason":"stop"}}';

    const mockProcessRunner = async () => ({
      stdout: rawStdout,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      signal: null,
      durationMs: 50
    });

    const result = await spawnOpencode(input, [], { processRunner: mockProcessRunner });
    expect(result.error).toBeDefined();
    expect(result.error?.kind).toBe('server');
    expect(result.error?.message).toContain('Resumed thread ID mismatch: expected ses_expected123, got ses_actual456');
  });
});
