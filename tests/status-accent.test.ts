import { describe, it, expect } from 'vitest';
import {
  roleAccent,
  kindAccent,
  statusAccent,
  panelBorderColor
} from '../src/status-accent.js';
import type { PanelContext } from '../src/status.js';
import type { StepKind, StepStatus } from '../src/state.js';

function makeContext(overrides: Partial<PanelContext>): PanelContext {
  return {
    projectRoot: '/tmp/project',
    loopName: 'plan',
    currentIteration: 1,
    maxIterations: 5,
    activeSkillRunner: null,
    timeline: [],
    nextStepMessage: '...',
    inFlight: null,
    latestVersion: 0,
    readOnly: false,
    ...overrides
  };
}

function makeInFlight(kind: StepKind, status: StepStatus = 'running') {
  return {
    kind,
    skillId: `${kind}-skill`,
    agent: 'opencode',
    model: 'opencode-go/deepseek-v4-flash',
    version: 1,
    iteration: 1,
    startedAtMs: 0,
    status,
    spawnLabel: `Spawning opencode for ${kind}...`,
    toolCallCount: 0,
    progressMessage: null
  };
}

function stripAnsi(s: string): string {
  return s.replace(/\u001B\[[0-9;]*m/g, '');
}

describe('status-accent accent map', () => {
  it('roleAccent returns the documented semantic label for every known role', () => {
    expect(roleAccent('auditor').label).toBe('auditor');
    expect(roleAccent('planner').label).toBe('planner');
    expect(roleAccent('reviewer').label).toBe('reviewer');
    expect(roleAccent('implementer').label).toBe('implementer');
  });

  it('roleAccent returns a rendered string equal to its label (sans ANSI)', () => {
    for (const role of ['auditor', 'planner', 'reviewer', 'implementer']) {
      const accent = roleAccent(role);
      const rendered = accent.chalk(accent.label);
      expect(stripAnsi(rendered)).toBe(accent.label);
    }
  });

  it('roleAccent returns a safe default for an unknown role', () => {
    const accent = roleAccent('mystery');
    expect(accent.label).toBe('unknown');
    expect(stripAnsi(accent.chalk(accent.label))).toBe('unknown');
  });

  it('kindAccent returns the documented semantic label for every known kind', () => {
    expect(kindAccent('audit').label).toBe('audit');
    expect(kindAccent('follow-up').label).toBe('follow-up');
    expect(kindAccent('implement').label).toBe('implement');
  });

  it('statusAccent returns the documented semantic label for every known status', () => {
    expect(statusAccent('running').label).toBe('running');
    expect(statusAccent('failed').label).toBe('failed');
    expect(statusAccent('done').label).toBe('done');
    expect(statusAccent('interrupted').label).toBe('interrupted');
  });

  it('does NOT assert chalk object identity (semantic-label contract)', () => {
    const a = roleAccent('auditor');
    expect(a).toHaveProperty('chalk');
    expect(a).toHaveProperty('label');
    expect(typeof a.chalk).toBe('function');
  });
});

describe('panelBorderColor (stage-driven border color)', () => {
  it('audit stage → cyan', () => {
    expect(panelBorderColor(makeContext({ inFlight: makeInFlight('audit') }))).toBe('cyan');
  });

  it('follow-up stage → yellow', () => {
    expect(panelBorderColor(makeContext({ inFlight: makeInFlight('follow-up') }))).toBe('yellow');
  });

  it('implement stage → green', () => {
    expect(panelBorderColor(makeContext({ inFlight: makeInFlight('implement') }))).toBe('green');
  });

  it('failed in-flight override is red regardless of stage', () => {
    expect(panelBorderColor(makeContext({ inFlight: makeInFlight('audit', 'failed') }))).toBe('red');
    expect(panelBorderColor(makeContext({ inFlight: makeInFlight('follow-up', 'failed') }))).toBe('red');
    expect(panelBorderColor(makeContext({ inFlight: makeInFlight('implement', 'failed') }))).toBe('red');
  });

  it('no in-flight + empty timeline → blue (no active stage)', () => {
    expect(panelBorderColor(makeContext({ inFlight: null, timeline: [] }))).toBe('blue');
  });

  it('timeline with last step of a given kind drives border color when inFlight is null', () => {
    expect(panelBorderColor(makeContext({
      inFlight: null,
      timeline: [{
        kind: 'follow-up', role: 'planner', agent: 'opencode', model: 'm',
        version: 1, status: 'done', artifactPath: '/x', mtime: 0
      }]
    }))).toBe('yellow');
  });

  it('timeline last step status === failed → red (historical-failure override)', () => {
    expect(panelBorderColor(makeContext({
      inFlight: null,
      timeline: [{
        kind: 'audit', role: 'auditor', agent: 'opencode', model: 'm',
        version: 1, status: 'failed', artifactPath: '/x', mtime: 0
      }]
    }))).toBe('red');
  });
});

