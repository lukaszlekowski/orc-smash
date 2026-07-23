import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import {
  roleAccent,
  kindAccent,
  statusAccent,
  panelBorderColor,
  resultAccent,
  toResultState,
  availabilityAccent,
  emphasisAccent,
  unclassifiedAccent,
  staleAccent,
  type ResultState,
  type AvailabilityState,
  type EmphasisState
} from '../src/terminal-accent.js';
import type { PanelContext } from '../src/status.js';
import { roleForKind, type StepKind, type StepStatus } from '../src/state.js';

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
    role: roleForKind(kind),
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

describe('terminal-accent accent map', () => {
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

  it('resultAccent maps all domain result states exhaustively', () => {
    const origLevel = chalk.level;
    chalk.level = 1;
    try {
      const states: ResultState[] = ['accepted', 'completed', 'retry', 'failed', 'blocked', 'unknown', 'interrupted', 'valid'];
      for (const st of states) {
        const fn = resultAccent(st);
        expect(typeof fn).toBe('function');
        expect(stripAnsi(fn(st))).toBe(st);
      }
    } finally {
      chalk.level = origLevel;
    }
  });

  it('availabilityAccent maps available, unavailable, and missing-inputs exhaustively', () => {
    const origLevel = chalk.level;
    chalk.level = 1;
    try {
      const states: AvailabilityState[] = ['available', 'unavailable', 'missing-inputs'];
      for (const st of states) {
        const fn = availabilityAccent(st);
        expect(typeof fn).toBe('function');
        expect(stripAnsi(fn(st))).toBe(st);
      }
    } finally {
      chalk.level = origLevel;
    }
  });

  it('emphasisAccent maps identity, binding-identity, supporting, placeholder, recommended, warning exhaustively', () => {
    const origLevel = chalk.level;
    chalk.level = 1;
    try {
      const states: EmphasisState[] = ['identity', 'binding-identity', 'supporting', 'placeholder', 'recommended', 'warning'];
      for (const st of states) {
        const fn = emphasisAccent(st);
        expect(typeof fn).toBe('function');
        expect(stripAnsi(fn(st))).toBe(st);
      }
    } finally {
      chalk.level = origLevel;
    }
  });

  it('unclassifiedAccent distinguishes 0 vs > 0 counts', () => {
    expect(stripAnsi(unclassifiedAccent(0)('0'))).toBe('0');
    expect(stripAnsi(unclassifiedAccent(3)('3'))).toBe('3');
  });

  it('staleAccent distinguishes true vs false staleness', () => {
    expect(stripAnsi(staleAccent(true)('stale'))).toBe('stale');
    expect(stripAnsi(staleAccent(false)('fresh'))).toBe('fresh');
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

describe('toResultState', () => {
  it('maps known result states accurately', () => {
    expect(toResultState('accepted')).toBe('accepted');
    expect(toResultState('APPROVED')).toBe('approved');
    expect(toResultState('completed')).toBe('completed');
    expect(toResultState('retry')).toBe('retry');
    expect(toResultState('rejected')).toBe('rejected');
    expect(toResultState('failed')).toBe('failed');
    expect(toResultState('blocked')).toBe('blocked');
    expect(toResultState('interrupted')).toBe('interrupted');
    expect(toResultState('valid')).toBe('valid');
  });

  it('maps undefined, null, or unmapped strings safely to valid/unknown defaults without throwing', () => {
    expect(toResultState(undefined)).toBe('valid');
    expect(toResultState(null)).toBe('valid');
    expect(toResultState('')).toBe('valid');
    expect(toResultState('unmapped_custom_state')).toBe('unknown');
  });
});
