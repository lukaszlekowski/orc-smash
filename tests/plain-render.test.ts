import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  renderPlainPanel,
  resolveTerminalWidth,
  wrapField
} from '../src/plain-render.js';
import type { PanelContext } from '../src/status.js';
import type { Step } from '../src/state.js';

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

function makeStep(overrides: Partial<Step>): Step {
  return {
    kind: 'audit',
    role: 'auditor',
    agent: 'fake',
    model: 'fake-model',
    version: 1,
    status: 'done',
    artifactPath: '/tmp/audit.md',
    mtime: 0,
    ...overrides
  };
}

describe('resolveTerminalWidth (operator override first)', () => {
  let savedColumns: string | undefined;
  let savedStdoutColumns: number | undefined;

  beforeEach(() => {
    savedColumns = process.env['COLUMNS'];
    savedStdoutColumns = process.stdout.columns;
  });

  afterEach(() => {
    if (savedColumns === undefined) delete process.env['COLUMNS'];
    else process.env['COLUMNS'] = savedColumns;
    Object.defineProperty(process.stdout, 'columns', { value: savedStdoutColumns, configurable: true });
  });

  it('returns 40 when COLUMNS=40 even without stdout.columns (Unix convention override)', () => {
    delete process.env['COLUMNS'];
    Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true });
    process.env['COLUMNS'] = '40';
    expect(resolveTerminalWidth()).toBe(40);
  });

  it('returns 80 when both COLUMNS and stdout.columns are unavailable', () => {
    delete process.env['COLUMNS'];
    Object.defineProperty(process.stdout, 'columns', { value: undefined, configurable: true });
    expect(resolveTerminalWidth()).toBe(80);
  });

  it('prefers COLUMNS over stdout.columns when both are set (operator override wins)', () => {
    process.env['COLUMNS'] = '50';
    Object.defineProperty(process.stdout, 'columns', { value: 200, configurable: true });
    expect(resolveTerminalWidth()).toBe(50);
  });

  it('falls back to stdout.columns when COLUMNS is not set', () => {
    delete process.env['COLUMNS'];
    Object.defineProperty(process.stdout, 'columns', { value: 120, configurable: true });
    expect(resolveTerminalWidth()).toBe(120);
  });

  it('ignores invalid COLUMNS values (non-numeric, < 40) and falls through', () => {
    delete process.env['COLUMNS'];
    Object.defineProperty(process.stdout, 'columns', { value: 100, configurable: true });
    process.env['COLUMNS'] = 'garbage';
    expect(resolveTerminalWidth()).toBe(100);
  });
});

describe('wrapField (pure wrap helper)', () => {
  it('returns single line when label+value fits in width', () => {
    const lines = wrapField('Model', 'foo', 40);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe('Model: foo');
  });

  it('wraps a long value across multiple lines indented under the value column', () => {
    const lines = wrapField('Model', 'opencode-go/deepseek-v4-flash-very-long-name', 40);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // First line: "Model:" with no value
    expect(lines[0]).toBe('Model:');
    // Continuation lines are indented past the value column
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]!.startsWith('  ')).toBe(true);
    }
  });
});

describe('renderPlainPanel — multiline blocks + separators + timestamps', () => {
  it('emits Loop:/Iteration:/Active:/Next: on four distinct lines', () => {
    const out = renderPlainPanel(makeContext({
      activeSkillRunner: { skillId: 'plan-audit', agent: 'opencode', model: 'm' }
    }));
    const loopIdx = out.indexOf('Loop:');
    const iterIdx = out.indexOf('Iteration:');
    const activeIdx = out.indexOf('Active:');
    const nextIdx = out.indexOf('Next:');
    expect(loopIdx).toBeGreaterThan(0);
    expect(iterIdx).toBeGreaterThan(loopIdx);
    expect(activeIdx).toBeGreaterThan(iterIdx);
    expect(nextIdx).toBeGreaterThan(activeIdx);
  });

  it('two timeline entries produce two "── v" header lines and exactly one "---" separator', () => {
    const out = renderPlainPanel(makeContext({
      timeline: [
        makeStep({ kind: 'audit', version: 1, role: 'auditor', verdict: 'REJECTED', mtime: 1000 }),
        makeStep({ kind: 'audit', version: 2, role: 'auditor', verdict: 'APPROVED', mtime: 2000 })
      ]
    }));
    const headerMatches = out.match(/\u2500\u2500 v/g) || [];
    expect(headerMatches).toHaveLength(2);
    const separators = (out.match(/^---$/gm) || []).length;
    expect(separators).toBe(1);
  });

  it('each timeline detail line carries a timestamp token', () => {
    const out = renderPlainPanel(makeContext({
      timeline: [
        makeStep({ kind: 'audit', version: 1, role: 'auditor', verdict: 'REJECTED', mtime: 1700000000000 })
      ]
    }));
    // The detail line has hh:mm:ss timestamp after the leading spaces.
    expect(out).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it('does NOT produce the legacy pipe-delimited single line (the dense [Panel] format)', () => {
    const out = renderPlainPanel(makeContext({ timeline: [makeStep({})] }));
    expect(out).not.toMatch(/^\[Panel\].*\|.*Timeline:/m);
  });

  it('empty timeline renders header block + Timeline: and does not crash', () => {
    const out = renderPlainPanel(makeContext({ timeline: [] }));
    expect(out).toContain('Loop:');
    expect(out).toContain('Iteration:');
    expect(out).toContain('Active:');
    expect(out).toContain('Next:');
    expect(out).toContain('Timeline:');
  });
});

describe('renderPlainPanel — read-only non-live label (v9 audit Major #1 closure)', () => {
  it('read-only view renders "Iteration: not running" and does NOT contain "0/5" or "Iteration: 0"', () => {
    const out = renderPlainPanel(makeContext({
      readOnly: true,
      inFlight: null,
      currentIteration: 0,
      maxIterations: 5
    }));
    expect(out).toMatch(/Iteration:\s+not running/);
    expect(out).not.toMatch(/0\/5|0 \/ 5/);
    expect(out).not.toMatch(/Iteration:\s+0\b/);
  });

  it('live view renders the literal "Iteration: 1/5" (1-based loop counter)', () => {
    const out = renderPlainPanel(makeContext({
      readOnly: false,
      currentIteration: 1,
      maxIterations: 5
    }));
    expect(out).toMatch(/Iteration:\s+1\/5/);
  });
});

describe('renderPlainPanel — wrapField integration and Latest version (review v2 fix)', () => {
  it('wraps a long Active value across multiple lines via wrapField', () => {
    const out = renderPlainPanel(makeContext({
      activeSkillRunner: {
        skillId: 'x'.repeat(50),
        agent: 'y'.repeat(30),
        model: 'z'.repeat(30)
      }
    }));
    const lines = out.split('\n');
    const activeIdx = lines.findIndex(l => l.startsWith('Active'));
    expect(activeIdx).toBeGreaterThanOrEqual(0);
    expect(lines[activeIdx]).toBe('Active:');
    const continuation = lines[activeIdx + 1];
    expect(continuation).toBeDefined();
    expect(continuation!.startsWith(' '.repeat(8))).toBe(true);
  });

  it('wraps a long Next value across multiple lines via wrapField', () => {
    const out = renderPlainPanel(makeContext({
      nextStepMessage: 'Ready to run a very long next step message that should wrap at width ' + 'x'.repeat(50)
    }));
    const lines = out.split('\n');
    const nextIdx = lines.findIndex(l => l.startsWith('Next'));
    expect(nextIdx).toBeGreaterThanOrEqual(0);
    expect(lines[nextIdx]).toBe('Next:');
    expect(lines[nextIdx + 1]).toBeDefined();
  });

  it('renders Latest version: v<N> when latestVersion > 0', () => {
    const out = renderPlainPanel(makeContext({
      latestVersion: 2,
      timeline: []
    }));
    expect(out).toContain('Latest version:');
    expect(out).toContain('v2');
  });

  it('does NOT render Latest version: when latestVersion is 0', () => {
    const out = renderPlainPanel(makeContext({
      latestVersion: 0,
      timeline: []
    }));
    expect(out).not.toContain('Latest version:');
  });

  it('wraps timeline header line when agent/model combo exceeds terminal width', () => {
    const out = renderPlainPanel(makeContext({
      timeline: [
        makeStep({
          kind: 'audit',
          role: 'auditor',
          agent: 'x'.repeat(40),
          model: 'y'.repeat(40),
          version: 1,
          verdict: 'APPROVED'
        })
      ]
    }));
    const lines = out.split('\n');
    const headerIdx = lines.findIndex(l => l.includes('\u2500\u2500 v1 auditor \u2500'));
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(lines[headerIdx]).toMatch(/^\u2500\u2500 v1 auditor \u2500/);
    const continuation = lines[headerIdx + 1];
    expect(continuation).toBeDefined();
    expect(continuation!.length).toBeGreaterThan(0);
  });
});

describe('renderPlainPanel — plain mode is non-live (v10 audit Critical closure)', () => {
  it('does NOT render "── IN-FLIGHT" or "Active Step:" under any circumstance, even with inFlight set', () => {
    const out = renderPlainPanel(makeContext({
      inFlight: {
        kind: 'follow-up', skillId: 'plan-follow-up', agent: 'opencode', model: 'opencode-go/deepseek-v4-flash',
        version: 1,
        iteration: 1,
        startedAtMs: 0,
        status: 'running',
        spawnLabel: 'Spawning opencode for follow-up...',
        toolCallCount: 0,
        progressMessage: 'audit v1'
      },
      timeline: [
        makeStep({ kind: 'audit', role: 'auditor', version: 1, verdict: 'REJECTED' })
      ]
    }));
    expect(out).not.toContain('\u2500\u2500 IN-FLIGHT');
    expect(out).not.toContain('Active Step:');
  });

  it('also does NOT render "── IN-FLIGHT" when inFlight is null (read-only view)', () => {
    const out = renderPlainPanel(makeContext({ inFlight: null, readOnly: true }));
    expect(out).not.toContain('\u2500\u2500 IN-FLIGHT');
    expect(out).not.toContain('Active Step:');
  });
});

describe('renderPlainPanel — interrupted steps render the literal "interrupted" (§3)', () => {
  it('renders an interrupted audit step with the "interrupted" status', () => {
    const out = renderPlainPanel(makeContext({
      timeline: [
        makeStep({ kind: 'audit', role: 'auditor', version: 3, status: 'interrupted', artifactPath: '/x/plan-audit-v3-codex.md' })
      ]
    }));
    expect(out).toContain('interrupted');
  });

  it('renders an interrupted follow-up step with the "interrupted" status', () => {
    const out = renderPlainPanel(makeContext({
      timeline: [
        makeStep({ kind: 'follow-up', role: 'planner', version: 2, status: 'interrupted', artifactPath: '/x/plan-followup-v2-claude.md' })
      ]
    }));
    expect(out).toContain('interrupted');
  });

  it('renders an interrupted implement step with the "interrupted" status', () => {
    const out = renderPlainPanel(makeContext({
      loopName: 'implement',
      timeline: [
        makeStep({ kind: 'implement', role: 'implementer', version: 1, status: 'interrupted', artifactPath: '/x/impl-v1-agy.md' })
      ]
    }));
    expect(out).toContain('interrupted');
  });
});
