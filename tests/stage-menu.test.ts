import { describe, it, expect } from 'vitest';
import { buildTopLevelMenu, buildLoopSubmenu, pipelineLaunchContexts } from '../src/stage-menu.js';
import type { V1Manifest } from '../src/manifest.js';

describe('F7 top-level menu', () => {
  const manifestWithEverything: V1Manifest = {
    schemaVersion: 1,
    roles: {},
    skills: {},
    loops: { plan: {} as any, review: {} as any },
    tasks: { implement: {} as any },
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

  it('shows start-loop, change-loop, run-task when both exist', () => {
    const actions = buildTopLevelMenu(manifestWithEverything);
    const ids = actions.map(a => a.id);
    expect(ids).toContain('start-loop');
    expect(ids).toContain('change-loop');
    expect(ids).toContain('task:implement');
    expect(ids).toContain('display-status');
    expect(ids).toContain('stop');
    expect(actions.find(a => a.id === 'start-loop')!.disabledReason).toBeUndefined();
    expect(actions.find(a => a.id === 'change-loop')!.disabledReason).toBeUndefined();
    expect(actions.find(a => a.id === 'task:implement')!.disabledReason).toBeUndefined();
  });

  it('disables start-loop and change-loop when no loops exist', () => {
    const actions = buildTopLevelMenu(manifestEmpty);
    expect(actions.find(a => a.id === 'start-loop')!.disabledReason).toEqual(expect.any(String));
    expect(actions.find(a => a.id === 'change-loop')!.disabledReason).toEqual(expect.any(String));
  });

  it('shows run-task disabled when no tasks exist and does not list individual tasks', () => {
    const actions = buildTopLevelMenu(manifestLoopsOnly);
    expect(actions.find(a => a.id === 'run-task')!.disabledReason).toEqual(expect.any(String));
    expect(actions.find(a => a.group === 'run-task' && a.id.startsWith('task:'))).toBeUndefined();
  });

  it('every action stays visible — no action is filtered out', () => {
    const actions = buildTopLevelMenu(manifestEmpty);
    expect(actions.length).toBeGreaterThanOrEqual(4);
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
    expect(item.label).toContain('opencode/opencode-go/model');
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
