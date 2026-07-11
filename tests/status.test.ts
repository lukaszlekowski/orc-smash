import { describe, it, expect } from 'vitest';
import { renderStatusPanel } from '../src/status-panel.js';
import { assembleNextStepMessage } from '../src/status.js';
import type { LoopSpec, Manifest } from '../src/manifest.js';

describe('Status panel renderer', () => {
  it('renders box, details, and timeline table correctly from read-only view', () => {
    const output = renderStatusPanel({
      projectRoot: '/my/test/project',
      loopName: 'plan',
      currentIteration: 0,
      maxIterations: 5,
      activeSkillRunner: null,
      timeline: [
        {
          kind: 'audit',
          role: 'auditor',
          version: 1,
          agent: 'opencode',
          model: 'opencode-go/deepseek-v4-flash',
          status: 'done' as const,
          verdict: 'REJECTED' as const,
          artifactPath: '/my/test/project/docs/dev/plan-audit-v1-opencode.md',
          mtime: 12345
        },
        {
          kind: 'follow-up',
          role: 'planner',
          version: 1,
          agent: 'fake',
          model: 'fake-model',
          status: 'done' as const,
          outcome: 'patched' as const,
          artifactPath: '/my/test/project/docs/dev/plan-followup-v1-fake.md',
          mtime: 12346
        }
      ],
      nextStepMessage: 'Smashing version 2...',
      inFlight: null,
      latestVersion: 2,
      readOnly: true
    });

    expect(output).toContain('ORC SMASH STATUS PANEL');
    expect(output).toContain('/my/test/project');
    expect(output).toContain('plan');
    expect(output).toContain('Iteration:        ');
    expect(output).toContain('not running');
    expect(output).not.toContain('2/5');
    expect(output).not.toContain('0/5');
    expect(output).not.toContain('Iteration: 0');
    expect(output).toContain('Latest version:   v2');
    expect(output).toContain('auditor');
    expect(output).toContain('REJECTED');
    expect(output).toContain('planner');
    expect(output).toContain('patched');
    expect(output).toContain('done');
  });
});

describe('assembleNextStepMessage', () => {
  const loopSpec: LoopSpec = {
    kind: 'doc-audit',
    target: 'plan.md',
    targetKind: 'file',
    audit: 'plan-audit',
    'follow-up': 'plan-follow-up',
    auditPattern: 'plan-audit-v{n}.md',
    followUpPattern: 'plan-followup-v{n}.md',
    inputs: []
  };

  const manifest: Manifest = {
    roles: { auditor: 'r.md', planner: 'p.md' },
    skills: {
      'plan-audit': { file: 's.md', role: 'auditor', kind: 'audit', runnerProfile: 'audit' },
      'plan-follow-up': { file: 's2.md', role: 'planner', kind: 'follow-up', runnerProfile: 'follow-up' }
    },
    loops: { plan: loopSpec }
  };

  it('formats fresh decision', () => {
    const msg = assembleNextStepMessage({
      state: 'fresh',
      nextSkill: 'audit',
      followUpVersion: null,
      nextAuditVersion: 1,
      priorAuditPath: null
    }, 0, loopSpec, manifest);
    expect(msg).toBe('Ready to run plan-audit version 1 (fresh)');
  });

  it('formats rejected decision', () => {
    const msg = assembleNextStepMessage({
      state: 'rejected',
      nextSkill: 'follow-up',
      followUpVersion: 1,
      nextAuditVersion: 2,
      priorAuditPath: '/p/1.md'
    }, 1, loopSpec, manifest);
    expect(msg).toBe('Proposed next: plan-follow-up then plan-audit version 2');
  });

  it('formats approved decision', () => {
    const msg = assembleNextStepMessage({
      state: 'approved',
      nextSkill: 'audit',
      followUpVersion: null,
      nextAuditVersion: 2,
      priorAuditPath: '/p/1.md'
    }, 1, loopSpec, manifest);
    expect(msg).toBe('Completed: approved at version 1');
  });

  it('formats implement decision', () => {
    const implementLoopSpec: LoopSpec = {
      kind: 'implement',
      target: '.',
      targetKind: 'worktree',
      planPath: 'plan.md',
      implement: '30-simple-implement',
      implementPattern: 'impl-v{n}.md',
      inputs: []
    };
    const implManifest: Manifest = {
      roles: { implementer: 'r.md' },
      skills: {
        '30-simple-implement': { file: 's.md', role: 'implementer', kind: 'implement', runnerProfile: 'implement' }
      },
      loops: { implement: implementLoopSpec }
    };
    const msg = assembleNextStepMessage({
      state: 'implement',
      nextVersion: 1
    }, 0, implementLoopSpec, implManifest);
    expect(msg).toBe('Ready to run 30-simple-implement version 1');
  });
});
