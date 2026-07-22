import { describe, it, expect } from 'vitest';
import { buildTopLevelMenu, buildLoopSubmenu, buildTaskMenu, pipelineLaunchContexts } from '../src/stage-menu.js';
import { formatMenuChoice } from '../src/interactive.js';
import type { V1Manifest } from '../src/manifest.js';

describe('F7 top-level menu', () => {
  const manifestWithEverything: V1Manifest = {
    schemaVersion: 1,
    roles: { implementer: 'roles/impl.md' },
    skills: { '30-simple-implement': { file: 'skills/impl.md', role: 'implementer', runnerProfile: 'default' } },
    loops: { plan: {} as any, review: {} as any },
    tasks: { implement: { skill: '30-simple-implement', target: { path: '.', kind: 'file' }, inputs: [], output: { pattern: 'out.md', contract: 'required-artifact' } } },
    pipelines: { default: { stages: [{ stageId: 'plan', loop: 'plan' }] } },
  };

  const manifestEmpty: V1Manifest = {
    schemaVersion: 1,
    roles: {},
    skills: {},
    loops: {},
    tasks: {},
    pipelines: {},
  };

  const manifestLoopsOnly: V1Manifest = {
    schemaVersion: 1,
    roles: {},
    skills: {},
    loops: { plan: {} as any },
    tasks: {},
    pipelines: {},
  };

  it('shows start-loop, run-task, change-loop, start-suggested-stage, display-status, stop', () => {
    const actions = buildTopLevelMenu(manifestWithEverything, true);
    const ids = actions.map(a => a.id);
    expect(ids).toEqual(['start-loop', 'run-task', 'change-loop', 'start-suggested-stage', 'display-status', 'stop']);
    expect(actions.find(a => a.id === 'start-loop')!.disabledReason).toBeUndefined();
    expect(actions.find(a => a.id === 'run-task')!.disabledReason).toBeUndefined();
    expect(actions.find(a => a.id === 'start-suggested-stage')!.disabledReason).toBeUndefined();
  });

  it('builds task menu choices for configured tasks', () => {
    const taskItems = buildTaskMenu(manifestWithEverything);
    expect(taskItems).toHaveLength(1);
    expect(taskItems[0]!.taskId).toBe('implement');
    expect(taskItems[0]!.skillId).toBe('30-simple-implement');
    expect(taskItems[0]!.role).toBe('implementer');
  });

  it('formats menu choices with explicit (unavailable: reason) label and boolean disabled state', () => {
    const item = { label: 'Start loop', disabledReason: 'no loops configured in manifest' };
    const choice = formatMenuChoice(item, 'start-loop');
    expect(choice.name).toBe('Start loop (unavailable: no loops configured in manifest)');
    expect(choice.disabled).toBe(true);
    expect(choice.value).toBe('start-loop');
  });

  it('recommended and unavailable cannot coexist on the same formatted choice', () => {
    const item = { label: 'Continue loop', recommended: true, disabledReason: 'no active chain' };
    const choice = formatMenuChoice(item, 'continue-loop');
    expect(choice.name).toBe('Continue loop (unavailable: no active chain)');
    expect(choice.name).not.toContain('(recommended)');
    expect(choice.disabled).toBe(true);
  });

  it('disables start-loop and change-loop when no loops exist', () => {
    const actions = buildTopLevelMenu(manifestEmpty);
    expect(actions.find(a => a.id === 'start-loop')!.disabledReason).toEqual(expect.any(String));
    expect(actions.find(a => a.id === 'change-loop')!.disabledReason).toEqual(expect.any(String));
  });

  it('shows run-task disabled when no tasks exist', () => {
    const actions = buildTopLevelMenu(manifestLoopsOnly);
    expect(actions.find(a => a.id === 'run-task')!.disabledReason).toEqual(expect.any(String));
  });

  it('every action stays visible — no action is filtered out', () => {
    const actions = buildTopLevelMenu(manifestEmpty);
    expect(actions.length).toBe(6);
    expect(actions.every(a => a.label.length > 0)).toBe(true);
  });
});

describe('F7 loop submenu', () => {
  it('recommends continue when there is an in-progress chain', () => {
    const items = buildLoopSubmenu('plan', true, false);
    expect(items.find(i => i.id === 'continue-current-loop')!.recommended).toBe(true);
    expect(items.find(i => i.id === 'continue-current-loop')!.disabledReason).toBeUndefined();
    expect(items.find(i => i.id === 'start-fresh-loop')!.recommended).toBe(false);
  });

  it('recommends fresh when there is no in-progress chain', () => {
    const items = buildLoopSubmenu('plan', false, true);
    expect(items.find(i => i.id === 'continue-current-loop')!.disabledReason).toEqual(expect.any(String));
    expect(items.find(i => i.id === 'start-fresh-loop')!.recommended).toBe(true);
  });

  it('disables second opinion when no completed acceptance exists', () => {
    const items = buildLoopSubmenu('plan', false, false);
    expect(items.find(i => i.id === 'run-second-opinion')!.disabledReason).toEqual(expect.any(String));
  });

  it('enables second opinion when a completed acceptance exists', () => {
    const items = buildLoopSubmenu('plan', false, true);
    expect(items.find(i => i.id === 'run-second-opinion')!.disabledReason).toBeUndefined();
  });

  it('back is always visible and enabled', () => {
    const items = buildLoopSubmenu('plan', false, false);
    expect(items.find(i => i.id === 'back')!.disabledReason).toBeUndefined();
  });

  it('every action is visible, no action filtered out', () => {
    const items = buildLoopSubmenu('plan', false, false);
    expect(items.length).toBe(4);
  });
});

describe('F7 pipeline launch contexts', () => {
  const manifest: V1Manifest = {
    schemaVersion: 1,
    roles: {},
    skills: {},
    loops: { plan: {} as any, review: {} as any },
    tasks: { implement: {} as any },
    pipelines: {
      default: { stages: [{ stageId: 'plan', loop: 'plan' }, { stageId: 'review', loop: 'review' }] },
      alt: { stages: [{ stageId: 'start', loop: 'plan' }] },
    },
  };

  it('finds pipeline contexts where the binding is the first stage', () => {
    const contexts = pipelineLaunchContexts(manifest, 'plan', 'loop');
    expect(contexts).toHaveLength(2);
    expect(contexts[0]!.pipelineId).toBe('default');
    expect(contexts[1]!.pipelineId).toBe('alt');
  });

  it('returns empty for a non-first-stage binding', () => {
    const contexts = pipelineLaunchContexts(manifest, 'review', 'loop');
    expect(contexts).toHaveLength(0);
  });

  it('returns empty for a task not in any pipeline', () => {
    const contexts = pipelineLaunchContexts(manifest, 'implement', 'task');
    expect(contexts).toHaveLength(0);
  });
});

describe('F7 Continue label detail', () => {
  it('renders sessionStrategy when continueDetail includes it', () => {
    const items = buildLoopSubmenu('plan', true, false, undefined, {
      phase: 'repair',
      version: 3,
      skillId: 'plan-audit',
      agent: 'opencode',
      model: 'opencode-go/model',
      effort: 'high',
      sessionStrategy: 'resume-per-skill',
    });
    const item = items.find(i => i.id === 'continue-current-loop')!;
    expect(item.label).toContain('resume-per-skill');
    expect(item.label).toContain('opencode-go/model');
    expect(item.label).toContain('plan-audit');
    expect(item.label).toContain('repair v3');
  });

  it('omits sessionStrategy from label when not provided', () => {
    const items = buildLoopSubmenu('plan', true, false, undefined, {
      phase: 'evaluate',
      version: 2,
      skillId: 'plan-audit',
      agent: 'opencode',
      model: 'opencode-go/model',
    });
    const item = items.find(i => i.id === 'continue-current-loop')!;
    expect(item.label).not.toContain('undefined');
  });
});
