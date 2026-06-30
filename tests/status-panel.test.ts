import { describe, it, expect, beforeAll } from 'vitest';
import chalk from 'chalk';
import { renderStatusPanel } from '../src/status-panel.js';
import { roleAccent, panelBorderColor } from '../src/status-accent.js';
import type { PanelContext } from '../src/status.js';
import type { StepKind, StepStatus } from '../src/state.js';

// Force chalk to emit ANSI color codes so the role-accent assertion can compare
// raw substrings. Without this, chalk auto-detects the test environment and
// strips color codes, making the "border ↔ row mirror" assertion impossible.
beforeAll(() => {
  chalk.level = 1;
});

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
    message: '...'
  };
}

function makeContext(overrides: Partial<PanelContext>): PanelContext {
  return {
    projectRoot: '/p',
    loopName: 'plan',
    currentIteration: 1,
    maxIterations: 5,
    activeSkillRunner: null,
    timeline: [],
    nextStepMessage: 'next',
    inFlight: null,
    latestVersion: 0,
    readOnly: false,
    ...overrides
  };
}

describe('renderStatusPanel — minimal border treatment + stage-driven color', () => {
  it('uses round border corners (╭, ╰) and not double (╔, ╚)', () => {
    const out = renderStatusPanel(makeContext({ inFlight: makeInFlight('audit') }));
    expect(out).toContain('\u256D'); // ╭
    expect(out).toContain('\u2570'); // ╰
    expect(out).not.toContain('\u2554'); // ╔
    expect(out).not.toContain('\u255A'); // ╚
  });

  it('contains no interior vertical grid char in the timeline region (cli-table3 chars are stripped)', () => {
    const out = renderStatusPanel(makeContext({
      timeline: [
        {
          kind: 'audit', role: 'auditor', version: 1, agent: 'opencode', model: 'm',
          status: 'done', verdict: 'REJECTED', artifactPath: '/x', mtime: 0
        }
      ]
    }));
    // The boxen frame has exactly 2 walls (left + right) per content line.
    // cli-table3's `mid: ''` config strips the column separators, so any
    // line with more than 2 '│' chars indicates a regression that
    // re-introduced the interior grid.
    expect(out).toContain('Timeline:');
    const lines = out.split('\n');
    for (const line of lines) {
      const wallCount = (line.match(/│/g) || []).length;
      expect(wallCount).toBeLessThanOrEqual(2);
    }
  });

  it('empty timeline still renders the header box (does not crash)', () => {
    const out = renderStatusPanel(makeContext({ timeline: [] }));
    expect(out).toContain('ORC SMASH STATUS PANEL');
    expect(out).toContain('Timeline:');
  });

  it('"*" latest-row marker appears exactly once and only on the last historical row', () => {
    const out = renderStatusPanel(makeContext({
      timeline: [
        { kind: 'audit', role: 'auditor', version: 1, agent: 'opencode', model: 'm', status: 'done', verdict: 'REJECTED', artifactPath: '/x', mtime: 0 },
        { kind: 'follow-up', role: 'planner', version: 1, agent: 'opencode', model: 'm', status: 'done', outcome: 'patched', artifactPath: '/y', mtime: 1 },
        { kind: 'audit', role: 'auditor', version: 2, agent: 'opencode', model: 'm', status: 'done', verdict: 'APPROVED', artifactPath: '/z', mtime: 2 }
      ]
    }));
    const matches = out.match(/\*/g) || [];
    expect(matches).toHaveLength(1);
  });
});

describe('renderStatusPanel — stage-driven border color (item 23 stage-identity)', () => {
  it('audit in-flight → cyan border', () => {
    const out = renderStatusPanel(makeContext({ inFlight: makeInFlight('audit') }));
    // boxen colors 'cyan' produce chalk.cyan codes which are \u001B[36m
    expect(out).toMatch(/\u001B\[36m/);
  });

  it('follow-up in-flight → yellow border', () => {
    const out = renderStatusPanel(makeContext({ inFlight: makeInFlight('follow-up') }));
    expect(out).toMatch(/\u001B\[33m/);
  });

  it('implement in-flight → green border', () => {
    const out = renderStatusPanel(makeContext({ inFlight: makeInFlight('implement') }));
    expect(out).toMatch(/\u001B\[32m/);
  });

  it('failed in-flight → red border, regardless of stage', () => {
    const auditFailed = renderStatusPanel(makeContext({ inFlight: makeInFlight('audit', 'failed') }));
    const followUpFailed = renderStatusPanel(makeContext({ inFlight: makeInFlight('follow-up', 'failed') }));
    const implementFailed = renderStatusPanel(makeContext({ inFlight: makeInFlight('implement', 'failed') }));
    expect(auditFailed).toMatch(/\u001B\[31m/);
    expect(followUpFailed).toMatch(/\u001B\[31m/);
    expect(implementFailed).toMatch(/\u001B\[31m/);
  });

  it('panelBorderColor returns the three distinct color keys for the three stages', () => {
    expect(panelBorderColor(makeContext({ inFlight: makeInFlight('audit') }))).toBe('cyan');
    expect(panelBorderColor(makeContext({ inFlight: makeInFlight('follow-up') }))).toBe('yellow');
    expect(panelBorderColor(makeContext({ inFlight: makeInFlight('implement') }))).toBe('green');
  });
});

describe('renderStatusPanel — Active Step in-flight row (v9 audit Major #2 closure)', () => {
  it('renders the "Active Step" section when inFlight !== null', () => {
    const out = renderStatusPanel(makeContext({ inFlight: makeInFlight('follow-up') }));
    expect(out).toContain('Active Step:');
  });

  it('omits the "Active Step" section when inFlight === null', () => {
    const out = renderStatusPanel(makeContext({ inFlight: null }));
    expect(out).not.toContain('Active Step:');
  });

  it('"Active Step" section content precedes the historical "Timeline" table', () => {
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('follow-up'),
      timeline: [
        { kind: 'audit', role: 'auditor', version: 1, agent: 'opencode', model: 'm', status: 'done', verdict: 'REJECTED', artifactPath: '/x', mtime: 0 }
      ]
    }));
    const activeIdx = out.indexOf('Active Step:');
    const timelineIdx = out.indexOf('Timeline:');
    expect(activeIdx).toBeGreaterThan(0);
    expect(timelineIdx).toBeGreaterThan(activeIdx);
  });

  it('border ↔ in-flight-row mirror: the in-flight Role cell is colored with the role accent (v6 M2 / v9 Major #2 / v9 Minor #1 closure)', () => {
    // The timeline contains only an audit step (no follow-up row), so the
    // only way the "planner" stage signal reaches the panel is through the
    // in-flight row's Role cell — the live pre-artifact case.
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('follow-up'),
      timeline: [
        { kind: 'audit', role: 'auditor', version: 1, agent: 'opencode', model: 'm', status: 'done', verdict: 'REJECTED', artifactPath: '/x', mtime: 0 }
      ]
    }));
    // Compute the expected ANSI-decorated role token (raw chalk output).
    // The in-flight role is derived from kind: follow-up → planner.
    const expectedRole = roleAccent('planner').chalk('planner');
    // The rendered output must contain this exact ANSI-decorated substring.
    // (v9 Minor #1: once ANSI is stripped the color signal is gone, so the
    // assertion must compare raw chalk output, not plain text.)
    expect(out).toContain(expectedRole);
  });

  it('in-flight Role cell mirrors the border color for a live audit (auditor → cyan)', () => {
    const out = renderStatusPanel(makeContext({ inFlight: makeInFlight('audit') }));
    const expectedRole = roleAccent('auditor').chalk('auditor');
    expect(out).toContain(expectedRole);
  });

  it('in-flight Role cell mirrors the border color for a live implement (implementer → green)', () => {
    const out = renderStatusPanel(makeContext({ inFlight: makeInFlight('implement') }));
    const expectedRole = roleAccent('implementer').chalk('implementer');
    expect(out).toContain(expectedRole);
  });
});

describe('renderStatusPanel — in-flight role derived from kind (review v7 Minor closure)', () => {
  it('live audit kind derives "auditor" role in the in-flight Role cell', () => {
    // The in-flight role is derived from kind via inFlightRole(kind).
    // kind: audit → role: 'auditor' (standard mapping, covers review audit too)
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('audit'),
      timeline: []
    }));
    const expectedRole = roleAccent('auditor').chalk('auditor');
    expect(out).toContain(expectedRole);
  });

  it('live follow-up kind derives "planner" role in the in-flight Role cell', () => {
    // kind: follow-up → role: 'planner' (standard mapping, covers review follow-up too)
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('follow-up'),
      timeline: []
    }));
    const expectedRole = roleAccent('planner').chalk('planner');
    expect(out).toContain(expectedRole);
  });

  it('plan audit still shows "auditor" (plan-loop regression)', () => {
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('audit'),
      timeline: []
    }));
    const expectedRole = roleAccent('auditor').chalk('auditor');
    expect(out).toContain(expectedRole);
  });

  it('plan follow-up still shows "planner" (plan-loop regression)', () => {
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('follow-up'),
      timeline: []
    }));
    const expectedRole = roleAccent('planner').chalk('planner');
    expect(out).toContain(expectedRole);
  });
});

describe('renderStatusPanel — read-only non-live label (v9 audit Major #1 closure)', () => {
  it('read-only view renders "Iteration: not running" and no "0/5" / "Iteration: 0"', () => {
    const out = renderStatusPanel(makeContext({
      readOnly: true,
      inFlight: null,
      currentIteration: 0,
      maxIterations: 5
    }));
    expect(out).toContain('Iteration: not running');
    expect(out).not.toMatch(/0\/5|0 \/ 5/);
    expect(out).not.toContain('Iteration: 0');
  });

  it('live view renders "Iteration: 1/5" (1-based display rule)', () => {
    const out = renderStatusPanel(makeContext({ readOnly: false, currentIteration: 1, maxIterations: 5 }));
    expect(out).toContain('Iteration: 1/5');
    expect(out).not.toContain('Iteration: not running');
  });
});
