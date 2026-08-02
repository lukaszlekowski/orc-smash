import { describe, it, expect, beforeAll } from 'vitest';
import chalk from 'chalk';
import { renderStatusPanel } from '../src/status-panel.js';
import { resolveTerminalWidth } from '../src/plain-render.js';
import { roleAccent, panelBorderColor } from '../src/terminal-accent.js';
import { resolveStyle } from '../src/theme.js';
import type { PanelContext } from '../src/status.js';
import { roleForKind, type Step, type StepKind, type StepStatus } from '../src/state.js';
import type { TimelineRow } from '../src/timeline-rows.js';

// Force chalk to emit ANSI color codes so the role-accent assertion can compare
// raw substrings. Without this, chalk auto-detects the test environment and
// strips color codes, making the "border ↔ row mirror" assertion impossible.
beforeAll(() => {
  chalk.level = 1;
});

function makeInFlight(kind: StepKind, status: StepStatus = 'running', role?: string) {
  return {
    kind,
    role: role ?? roleForKind(kind),
    skillId: `${kind}-skill`,
    agent: 'opencode',
    model: 'opencode-go/deepseek-v4-flash',
    version: 1,
    iteration: 1,
    startedAtMs: 0,
    status,
    spawnLabel: `Spawning opencode for ${kind}...`,
    toolCallCount: 0,
    progressMessage: null,
    progressCapability: 'structured' as const,
  };
}

function makeContext(overrides: Partial<PanelContext>): PanelContext {
  return {
    projectRoot: '/p',
    loopName: 'plan',
    bindingKind: 'loop',
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

function makeRow(overrides: Partial<Step>, relevance: TimelineRow['relevance'] = 'current-chain'): TimelineRow {
  return {
    relevance,
    step: {
      kind: 'audit', role: 'auditor', agent: 'fake', model: 'fake-model', version: 1,
      status: 'done', artifactPath: '/tmp/audit.md', mtime: 0, ...overrides,
    },
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
        makeRow({ kind: 'audit', role: 'auditor', version: 1, agent: 'opencode', model: 'm',
          status: 'done', verdict: 'REJECTED', artifactPath: '/x', mtime: 0 })
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
        makeRow({ kind: 'audit', role: 'auditor', version: 1, agent: 'opencode', model: 'm', status: 'done', verdict: 'REJECTED', artifactPath: '/x', mtime: 0 }),
        makeRow({ kind: 'follow-up', role: 'planner', version: 1, agent: 'opencode', model: 'm', status: 'done', outcome: 'patched', artifactPath: '/y', mtime: 1 }),
        makeRow({ kind: 'audit', role: 'auditor', version: 2, agent: 'opencode', model: 'm', status: 'done', verdict: 'APPROVED', artifactPath: '/z', mtime: 2 })
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

  it('"Active Step" section content follows the "Timeline" table', () => {
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('follow-up'),
      timeline: [
        makeRow({ kind: 'audit', role: 'auditor', version: 1, agent: 'opencode', model: 'm', status: 'done', verdict: 'REJECTED', artifactPath: '/x', mtime: 0 })
      ]
    }));
    const activeIdx = out.indexOf('Active Step:');
    const timelineIdx = out.indexOf('Timeline:');
    expect(activeIdx).toBeGreaterThan(0);
    expect(activeIdx).toBeGreaterThan(timelineIdx);
  });

  it('border ↔ in-flight-row mirror: the in-flight Role cell is colored with the role accent (v6 M2 / v9 Major #2 / v9 Minor #1 closure)', () => {
    // The timeline contains only an audit step (no follow-up row), so the
    // only way the "planner" stage signal reaches the panel is through the
    // in-flight row's Role cell — the live pre-artifact case.
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('follow-up'),
      timeline: [
        makeRow({ kind: 'audit', role: 'auditor', version: 1, agent: 'opencode', model: 'm', status: 'done', verdict: 'REJECTED', artifactPath: '/x', mtime: 0 })
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
    const expectedRole = resolveStyle('role.implementer', 'status-panel')('implementer');
    expect(out).toContain(expectedRole);
  });

  it('renders the in-flight step as the bottom row of the timeline table', () => {
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('follow-up'),
      timeline: [
        makeRow({ kind: 'audit', role: 'auditor', version: 1, agent: 'opencode', model: 'm', status: 'done', verdict: 'REJECTED', artifactPath: '/x', mtime: 0 })
      ]
    }));
    const rejectedIdx = out.indexOf('REJECTED');
    const runningIdx = out.indexOf('running');
    expect(rejectedIdx).toBeGreaterThan(0);
    expect(runningIdx).toBeGreaterThan(rejectedIdx);
  });

  it('renders spawn, tool-call count, and progress info on separate active-step lines', () => {
    const out = renderStatusPanel(makeContext({
      inFlight: {
        ...makeInFlight('audit'),
        toolCallCount: 13,
        progressMessage: 'Reading audit output'
      }
    }));
    expect(out).toContain('Spawn:');
    expect(out).toContain('Tool calls:');
    expect(out).toContain('13');
    expect(out).toContain('Progress:');
    expect(out).toContain('Reading audit output');
  });
});

describe('renderStatusPanel — in-flight role read from context.inFlight.role', () => {
  it('live audit kind uses context.inFlight.role in the in-flight Role cell', () => {
    // The in-flight role is read directly from context.inFlight.role.
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('audit', 'running', 'reviewer'),
      timeline: []
    }));
    const expectedRole = roleAccent('reviewer').chalk('reviewer');
    expect(out).toContain(expectedRole);
  });

  it('live follow-up kind uses context.inFlight.role in the in-flight Role cell', () => {
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('follow-up', 'running', 'implementer'),
      timeline: []
    }));
    const expectedRole = resolveStyle('role.implementer', 'status-panel')('implementer');
    expect(out).toContain(expectedRole);
  });

  it('plan audit still shows "auditor" (plan-loop regression)', () => {
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('audit'), // defaults to roleForKind('audit') => 'auditor'
      timeline: []
    }));
    const expectedRole = roleAccent('auditor').chalk('auditor');
    expect(out).toContain(expectedRole);
  });

  it('plan follow-up still shows "planner" (plan-loop regression)', () => {
    const out = renderStatusPanel(makeContext({
      inFlight: makeInFlight('follow-up'), // defaults to roleForKind('follow-up') => 'planner'
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
    expect(out).toContain('Iteration:        ');
    expect(out).toContain('not running');
    expect(out).not.toMatch(/0\/5|0 \/ 5/);
    expect(out).not.toContain('Iteration: 0');
  });

  it('live view renders "Iteration: 1/5" (1-based display rule)', () => {
    const out = renderStatusPanel(makeContext({ readOnly: false, currentIteration: 1, maxIterations: 5 }));
    expect(out).toContain('Iteration:        ');
    expect(out).toContain('1/5');
    expect(out).not.toContain('Iteration: not running');
  });

  it('iteration value aligns with the other summary labels', () => {
    const out = renderStatusPanel(makeContext({ readOnly: false, currentIteration: 1, maxIterations: 5 }));
    expect(out).toContain('Loop:             ');
    expect(out).toContain('Iteration:        ');
  });
});

describe('renderStatusPanel — binding vocabulary', () => {
  it('renders a task as one execution without loop iteration vocabulary', () => {
    const out = renderStatusPanel(makeContext({
      bindingKind: 'task',
      providerCalls: 1,
      currentIteration: 0,
      maxIterations: 4,
    }));
    expect(out).toContain('Execution:');
    expect(out).toContain('Single task - provider calls 1');
    expect(out).not.toContain('Round');
    expect(out).not.toContain('0/4');
  });
});

describe('renderStatusPanel — bounded tables and compact identities', () => {
  it('keeps the run configuration inside a narrow panel while preserving headers', () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '40';
    try {
      const out = renderStatusPanel(makeContext({
        resolvedRunners: [{
          skillId: 'very-long-skill-name',
          agent: 'opencode',
          model: 'opencode-go/deepseek-v4-flash',
          role: 'implementer',
          phase: 'task',
          effort: null,
          sessionStrategy: 'fresh-per-invocation',
        }],
      }));
      const plain = out.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
      expect(Math.max(...plain.split('\n').map(line => line.length))).toBeLessThanOrEqual(40);
      expect(plain).toContain('Run configuration');
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });

  it('shows all compact identity columns when a wide table fits', () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '160';
    try {
      const out = renderStatusPanel(makeContext({
        showFingerprints: true,
        timeline: [makeRow({
          artifactIdentity: 'a'.repeat(64),
          parentArtifactIdentity: 'b'.repeat(64),
          inputFingerprint: 'c'.repeat(64),
          resultFingerprint: 'd'.repeat(64),
          decision: 'accepted',
        })],
      }));
      expect(out).toContain('Artifact');
      expect(out).toContain('Parent');
      expect(out).toContain('Input FP');
      expect(out).toContain('Result FP');
      expect(out).toContain('*aaaaa');
      expect(out).toContain('*bbbbb');
      expect(out).toContain('*ccccc');
      expect(out).toContain('*ddddd');
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });

  it('hides diagnostic columns and values by default on a wide terminal', () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '160';
    try {
      const out = renderStatusPanel(makeContext({
        timeline: [makeRow({
          artifactIdentity: 'a'.repeat(64),
          parentArtifactIdentity: 'b'.repeat(64),
          inputFingerprint: 'c'.repeat(64),
          resultFingerprint: 'd'.repeat(64),
          decision: 'accepted',
        })],
      }));
      expect(out).toContain('Ver');
      expect(out).toContain('Status');
      expect(out).not.toContain('Artifact');
      expect(out).not.toContain('Parent');
      expect(out).not.toContain('Input FP');
      expect(out).not.toContain('Result FP');
      expect(out).not.toContain('*aaaaa');
      expect(out).not.toContain('*bbbbb');
      expect(out).not.toContain('*ccccc');
      expect(out).not.toContain('*ddddd');
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });

  it('hides diagnostic columns and compact identity lines by default on a narrow terminal without overflow', () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '80';
    try {
      const out = renderStatusPanel(makeContext({
        timeline: [makeRow({
          artifactIdentity: 'a'.repeat(64),
          parentArtifactIdentity: 'b'.repeat(64),
          inputFingerprint: 'c'.repeat(64),
          resultFingerprint: 'd'.repeat(64),
          decision: 'accepted',
        })],
        inFlight: {
          ...makeInFlight('audit'),
          artifactIdentity: 'e'.repeat(64),
          parentArtifactIdentity: 'f'.repeat(64),
          inputFingerprint: 'g'.repeat(64),
          resultFingerprint: 'h'.repeat(64),
        },
      }));
      const plain = out.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
      expect(plain).not.toContain('Artifact');
      expect(plain).not.toContain('Parent');
      expect(plain).not.toContain('Input FP');
      expect(plain).not.toContain('Result FP');
      expect(plain).not.toContain('artifact *aaaaa');
      expect(plain).not.toContain('artifact *eeeee');
      expect(Math.max(...plain.split('\n').map(line => line.length))).toBeLessThanOrEqual(resolveTerminalWidth());
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });

  it('keeps all four diagnostics in one compact line per row when enabled on a narrow terminal', () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '80';
    try {
      const out = renderStatusPanel(makeContext({
        showFingerprints: true,
        timeline: [makeRow({
          artifactIdentity: 'a'.repeat(64),
          parentArtifactIdentity: 'b'.repeat(64),
          inputFingerprint: 'c'.repeat(64),
          resultFingerprint: 'd'.repeat(64),
          decision: 'accepted',
        })],
        inFlight: {
          ...makeInFlight('audit'),
          artifactIdentity: 'e'.repeat(64),
          parentArtifactIdentity: 'f'.repeat(64),
          inputFingerprint: 'g'.repeat(64),
          resultFingerprint: 'h'.repeat(64),
        },
      }));
      const plain = out.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
      expect(plain).toContain('Ver');
      expect(plain).toContain('Status');
      expect(plain.match(/artifact \*\w{5}  parent/g)).toHaveLength(2);
      expect(plain).toContain('*aaaaa');
      expect(plain).toContain('*bbbbb');
      expect(plain).toContain('*ccccc');
      expect(plain).toContain('*ddddd');
      expect(plain).toContain('*eeeee');
      expect(plain).toContain('*fffff');
      expect(plain).toContain('*ggggg');
      expect(plain).toContain('*hhhhh');
      expect(Math.max(...plain.split('\n').map(line => line.length))).toBeLessThanOrEqual(resolveTerminalWidth());
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });
});

describe('renderStatusPanel — result accenting per-cell (Major #1 closure)', () => {
  it('duplicate outcomes each get their own accented result in wide layout (no double-wrap, no bleed)', () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '160';
    try {
      const out = renderStatusPanel(makeContext({
        timeline: [
          makeRow({
            kind: 'audit', role: 'auditor', version: 1, agent: 'opencode', model: 'm',
            status: 'done', verdict: 'APPROVED', artifactPath: '/x/a.md', mtime: 0,
          }),
          makeRow({
            kind: 'audit', role: 'auditor', version: 2, agent: 'opencode', model: 'm',
            status: 'done', verdict: 'APPROVED', artifactPath: '/x/b.md', mtime: 1,
          }),
          makeRow({
            kind: 'audit', role: 'auditor', version: 3, agent: 'opencode', model: 'm',
            status: 'done', verdict: 'APPROVED', artifactPath: '/x/c.md', mtime: 2,
          }, 'unrelated'),
        ],
      }));
      const greenApproved = out.match(/\u001B\[32mAPPROVED\u001B\[39m/g);
      expect(greenApproved).toHaveLength(2);
      expect(out).not.toContain('\u001B[32m\u001B[32m');
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });

  it('role and status cells carry per-cell accent for current rows and plain text for dimmed rows', () => {
    chalk.level = 1;
    const out = renderStatusPanel(makeContext({
      timeline: [
        makeRow({
          kind: 'audit', role: 'auditor', version: 1, agent: 'opencode', model: 'm',
          status: 'done', verdict: 'APPROVED', artifactPath: '/x/a.md', mtime: 0,
        }),
        makeRow({
          kind: 'audit', role: 'auditor', version: 2, agent: 'opencode', model: 'm',
          status: 'done', verdict: 'REJECTED', artifactPath: '/x/b.md', mtime: 1,
        }, 'unrelated'),
      ],
    }));
    expect(out).toContain('\u001B[36mauditor\u001B[39m');
    const dimmedAuditor = out.match(/\u001B\[2mauditor\u001B\[22m/g);
    expect(dimmedAuditor).not.toBeNull();
    expect(dimmedAuditor!.length).toBeGreaterThanOrEqual(1);
  });
});

describe('renderStatusPanel — interrupted steps render the literal "interrupted" (§3)', () => {
  it('renders an interrupted audit step with the "interrupted" status label', () => {
    const out = renderStatusPanel(makeContext({
      timeline: [
        makeRow({ kind: 'audit', role: 'auditor', version: 3, agent: 'codex', model: 'gpt-5.4', status: 'interrupted', artifactPath: '/x/plan-audit-v3-codex.md', mtime: 0 })
      ]
    }));
    expect(out).toContain('interrupted');
  });

  it('renders an interrupted follow-up step with the "interrupted" status label', () => {
    const out = renderStatusPanel(makeContext({
      timeline: [
        makeRow({ kind: 'follow-up', role: 'planner', version: 2, agent: 'claude', model: 'glm-5.2', status: 'interrupted', artifactPath: '/x/plan-followup-v2-claude.md', mtime: 0 })
      ]
    }));
    expect(out).toContain('interrupted');
  });

  it('renders an interrupted implement step with the "interrupted" status label', () => {
    const out = renderStatusPanel(makeContext({
      loopName: 'implement',
      timeline: [
        makeRow({ kind: 'implement', role: 'implementer', version: 1, agent: 'agy', model: 'gemini-3.6-flash', status: 'interrupted', artifactPath: '/x/impl-v1-agy.md', mtime: 0 })
      ]
    }));
    expect(out).toContain('interrupted');
  });

  it('an interrupted step shows an em-dash result cell, not a misleading "unknown" verdict', () => {
    const out = renderStatusPanel(makeContext({
      timeline: [
        makeRow({ kind: 'audit', role: 'auditor', version: 3, agent: 'codex', model: 'gpt-5.4', status: 'interrupted', artifactPath: '/x', mtime: 0 })
      ]
    }));
    expect(out).toContain('—'); // em dash result cell
    expect(out).not.toMatch(/unknown/i);
  });

  it('renders a Time column with formatted per-step duration (Xm Ys)', () => {
    const out = renderStatusPanel(makeContext({
      timeline: [
        makeRow({ kind: 'audit', role: 'auditor', version: 1, agent: 'codex', model: 'gpt-5.4',
          status: 'done', verdict: 'APPROVED', artifactPath: '/x/a.md', mtime: 0, durationMs: 65000 })
      ]
    }));
    expect(out).toContain('Time');
    expect(out).toContain('1m 5s');
  });

  it('renders a Session ID column with the corresponding sessionId', () => {
    const out = renderStatusPanel(makeContext({
      timeline: [
        makeRow({ kind: 'audit', role: 'auditor', version: 1, agent: 'codex', model: 'gpt-5.4',
          status: 'done', verdict: 'APPROVED', artifactPath: '/x/a.md', mtime: 0, sessionId: 'sess_timeline_123' })
      ]
    }));
    expect(out).toContain('Session');
    expect(out).toContain('*e_123');
  });
});

describe('renderStatusPanel — unavailable progress capability', () => {
  it('renders "Live progress unavailable for this provider" line and suppresses Tool calls and Progress lines', () => {
    const out = renderStatusPanel(makeContext({
      inFlight: {
        ...makeInFlight('audit'),
        agent: 'agy',
        progressCapability: 'unavailable',
        toolCallCount: 0,
        progressMessage: null,
      }
    }));
    expect(out).toContain('Live progress unavailable for this provider');
    expect(out).not.toContain('Tool calls:');
    expect(out).not.toContain('Progress:');
  });
});

describe('renderStatusPanel — content-aware column sizing', () => {
  // The boxen box is always `COLUMNS` wide, so line length does not reflect the
  // table width. Instead, return the rightmost column on the timeline data row
  // that is neither whitespace nor the boxen '│' wall — i.e. where the table
  // content actually ends.
  const dataRowExtent = (out: string, marker: string): number => {
    const line = out.split('\n').find(candidate => candidate.includes(marker));
    if (!line) throw new Error(`no rendered line contains ${marker}`);
    const stripped = line.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
    for (let index = stripped.length - 1; index >= 0; index -= 1) {
      const ch = stripped[index];
      if (ch !== ' ' && ch !== '│') return index + 1;
    }
    return 0;
  };

  it('collapses an empty Result column and grows it when a long result arrives', () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '160';
    try {
      const empty = renderStatusPanel(makeContext({
        timeline: [makeRow({
          kind: 'audit', role: 'auditor', version: 1, agent: 'fake', model: 'fake-model',
          status: 'done', artifactPath: '/x', mtime: 0,
        })],
      }));
      const longResult = renderStatusPanel(makeContext({
        timeline: [makeRow({
          kind: 'audit', role: 'auditor', version: 1, agent: 'fake', model: 'fake-model',
          status: 'done', decision: 'x'.repeat(40), artifactPath: '/x', mtime: 0,
        })],
      }));

      const emptyExtent = dataRowExtent(empty, 'fake-model');
      const longExtent = dataRowExtent(longResult, 'fake-model');

      // Width tracks content: the long-result row extends well past the empty one.
      expect(longExtent - emptyExtent).toBeGreaterThan(20);
      // An empty Result no longer stretches to fill the terminal.
      expect(emptyExtent).toBeLessThan(resolveTerminalWidth() - 20);
      // Both still fit inside the terminal (no row leak).
      expect(longExtent).toBeLessThanOrEqual(resolveTerminalWidth());
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });

  it('closes the implementer background before cli-table3 reaches the next column', () => {
    const previous = process.env.COLUMNS;
    process.env.COLUMNS = '40';
    try {
      const out = renderStatusPanel(makeContext({
        timeline: [makeRow({
          role: 'implementer', agent: 'fake', model: 'fake-model', status: 'done', artifactPath: '/x', mtime: 0,
        })],
      }));
      const rowLine = out.split('\n').find(line => line.includes('fa'));
      expect(rowLine).toBeDefined();
      const line = rowLine!;
      const nextColumn = line.indexOf('fa');
      const backgroundOpen = line.indexOf('\u001B[42m');
      const backgroundClose = line.indexOf('\u001B[49m', backgroundOpen);
      expect(backgroundOpen).toBeGreaterThan(-1);
      expect(backgroundClose).toBeGreaterThan(backgroundOpen);
      expect(backgroundClose).toBeLessThan(nextColumn);
    } finally {
      if (previous === undefined) delete process.env.COLUMNS;
      else process.env.COLUMNS = previous;
    }
  });
});
