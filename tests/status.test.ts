import { describe, it, expect } from 'vitest';
import { renderStatusPanel } from '../src/status-panel.js';

describe('Status panel renderer', () => {
  it('renders box, details, and timeline table correctly', () => {
    const output = renderStatusPanel({
      projectRoot: '/my/test/project',
      loopName: 'plan',
      currentIteration: 2,
      maxIterations: 5,
      activeSkillRunner: {
        skillId: 'plan-audit',
        agent: 'opencode',
        model: 'opencode-go/deepseek-v4-flash'
      },
      timeline: [
        {
          kind: 'audit',
          role: 'auditor',
          version: 1,
          agent: 'opencode',
          model: 'opencode-go/deepseek-v4-flash',
          status: 'done',
          verdict: 'REJECTED',
          artifactPath: '/my/test/project/docs/dev/plan-audit-v1-opencode.md',
          mtime: 12345
        },
        {
          kind: 'follow-up',
          role: 'planner',
          version: 1,
          agent: 'fake',
          model: 'fake-model',
          status: 'done',
          outcome: 'patched',
          artifactPath: '/my/test/project/docs/dev/plan-followup-v1-fake.md',
          mtime: 12346
        }
      ],
      nextStepMessage: 'Smashing version 2...'
    });

    expect(output).toContain('ORC SMASH STATUS PANEL');
    expect(output).toContain('/my/test/project');
    expect(output).toContain('plan');
    expect(output).toContain('2/5');
    expect(output).toContain('plan-audit');
    expect(output).toContain('auditor');
    expect(output).toContain('REJECTED');
    expect(output).toContain('planner');
    expect(output).toContain('patched');
    expect(output).toContain('done');
  });
});
