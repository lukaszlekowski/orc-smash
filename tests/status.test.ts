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
          kind: 'evaluate',
          role: 'auditor',
          version: 1,
          agent: 'opencode',
          model: 'opencode-go/deepseek-v4-flash',
          status: 'done' as const,
          decision: 'retry' as const,
          artifactPath: '/my/test/project/docs/dev/plan-audit-v1-opencode.md',
          mtime: 12345
        },
        {
          kind: 'repair',
          role: 'planner',
          version: 1,
          agent: 'fake',
          model: 'fake-model',
          status: 'done' as const,
          completionOutcome: 'completed' as const,
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
    expect(output).toContain('retry');
    expect(output).toContain('planner');
    expect(output).toContain('completed');
    expect(output).toContain('done');
  });
});

describe('assembleNextStepMessage', () => {
  const loopSpec: LoopSpec = {
    type: 'approval-loop',
    target: { path: 'plan.md', kind: 'file' },
    inputs: [],
    evaluate: { skill: 'plan-audit', output: { pattern: 'plan-audit-v{version}.md', contract: 'decision-artifact', decision: { heading: 'Verdict', accepted: 'APPROVED', retry: 'REJECTED' } } },
    repair: { skill: 'plan-follow-up', output: { pattern: 'plan-followup-v{version}.md', contract: 'completion-artifact' } }
  };

  const manifest: Manifest = {
    schemaVersion: 1 as const,
    roles: { auditor: 'r.md', planner: 'p.md' },
    skills: {
      'plan-audit': { file: 's.md', role: 'auditor', runnerProfile: 'audit' },
      'plan-follow-up': { file: 's2.md', role: 'planner', runnerProfile: 'follow-up' }
    },
    loops: { plan: loopSpec },
    tasks: {},
    pipelines: {}
  };

  it('formats fresh decision', () => {
    const msg = assembleNextStepMessage({
      state: 'fresh',
      nextSkill: 'evaluate',
      repairVersion: null,
      nextEvaluateVersion: 1,
      priorArtifactPath: null
    }, 0, loopSpec, manifest);
    expect(msg).toBe('Ready to run plan-audit version 1 (fresh)');
  });

  it('formats rejected decision', () => {
    const msg = assembleNextStepMessage({
      state: 'rejected',
      nextSkill: 'repair',
      repairVersion: 1,
      nextEvaluateVersion: 2,
      priorArtifactPath: '/p/1.md'
    }, 1, loopSpec, manifest);
    expect(msg).toBe('Proposed next: plan-follow-up then plan-audit version 2');
  });

  it('formats accepted decision', () => {
    const msg = assembleNextStepMessage({
      state: 'accepted',
      nextSkill: 'evaluate',
      repairVersion: null,
      nextEvaluateVersion: 2,
      priorArtifactPath: '/p/1.md'
    }, 1, loopSpec, manifest);
    expect(msg).toBe('Completed: accepted at version 1');
  });

  it('formats an unknown decision as terminal', () => {
    const msg = assembleNextStepMessage({
      state: 'unknown-latest-evaluation',
      nextSkill: null,
      nextEvaluateVersion: 2,
      priorArtifactPath: '/p/1.md'
    }, 1, loopSpec, manifest);
    expect(msg).toBe('Terminal error: latest evaluation is unparseable');
  });
});
