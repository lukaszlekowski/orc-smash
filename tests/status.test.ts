import { describe, it, expect } from 'vitest';
import { renderStatusPanel } from '../src/status.js';

describe('Status panel renderer', () => {
  it('renders box, details, and history table correctly', () => {
    const output = renderStatusPanel({
      projectRoot: '/my/test/project',
      loopName: 'plan',
      currentIteration: 2,
      maxIterations: 5,
      activeSkillRunner: {
        skillId: 'plan-audit',
        agent: 'opencode',
        model: 'opencode/deepseek-v4-flash'
      },
      history: [
        {
          version: 1,
          agent: 'opencode',
          model: 'opencode/deepseek-v4-flash',
          verdict: 'REJECTED',
          filePath: '/my/test/project/docs/dev/plan-audit-v1-opencode.md',
          mtime: 12345
        }
      ],
      nextStepMessage: 'Smashing version 2...'
    });

    expect(output).toContain('ORC SMASH STATUS PANEL');
    expect(output).toContain('/my/test/project');
    expect(output).toContain('plan');
    expect(output).toContain('2/5');
    expect(output).toContain('plan-audit');
    expect(output).toContain('REJECTED');
  });
});
