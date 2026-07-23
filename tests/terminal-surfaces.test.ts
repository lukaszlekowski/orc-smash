import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { loadConfig } from '../src/config.js';
import { scanGlobalSnapshot } from '../src/artifact-index.js';
import { buildProjectSnapshotView } from '../src/project-snapshot-view.js';
import { renderCompactSnapshot, renderDetailedSnapshot } from '../src/project-snapshot-renderer.js';
import { renderStatusPanel } from '../src/status-panel.js';
import { createPanelCliOutput } from '../src/cli-output.js';
import { renderRunEvent } from '../src/plain-event-renderer.js';
import { renderPlainPanel } from '../src/plain-render.js';
import { formatMenuChoice } from '../src/interactive.js';
import { makeRunEvent } from '../src/run-event.js';
import {
  type ResultState,
  type AvailabilityState,
} from '../src/terminal-accent.js';

describe('Exhaustive Surface Coverage & State-by-Surface ANSI Matrix (Major 5 / M2)', () => {
  let originalLevel: typeof chalk.level;

  beforeEach(() => {
    originalLevel = chalk.level;
    chalk.level = 1; // Force ANSI color codes
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  it('Exhaustive surface coverage: all 7 owned terminal surfaces emit ANSI escape codes and preserve full text', () => {
    const config = loadConfig(process.cwd());
    const snapshot = scanGlobalSnapshot(process.cwd(), config.manifest);
    const view = buildProjectSnapshotView(config, snapshot);

    // 1. Compact snapshot
    const compact = renderCompactSnapshot(view);
    expect(compact).toMatch(/\u001b\[/);
    expect(compact.replace(/\u001b\[\d+m/g, '')).toContain('Bindings:');

    // 2. Detailed snapshot
    const detailed = renderDetailedSnapshot(view);
    expect(detailed).toMatch(/\u001b\[/);
    const plainDetailed = detailed.replace(/\u001b\[\d+m/g, '');
    expect(plainDetailed).toContain('Prompt Contracts:');
    expect(plainDetailed).toContain('Bindings:');

    const promptIdx = plainDetailed.indexOf('Prompt Contracts:');
    const bindIdx = plainDetailed.indexOf('Bindings:');
    expect(promptIdx).toBeGreaterThan(-1);
    expect(bindIdx).toBeGreaterThan(promptIdx);
    expect(plainDetailed.indexOf('Prompt Contracts:', promptIdx + 1)).toBe(-1);
    expect(plainDetailed.indexOf('Bindings:', bindIdx + 1)).toBe(-1);

    // 3. Status panel
    const sampleContext: any = {
      projectRoot: process.cwd(),
      loopName: 'plan',
      currentIteration: 1,
      maxIterations: 3,
      activeSkillRunner: null,
      timeline: snapshot.steps,
      nextStepMessage: 'Ready',
    };
    const statusPanel = renderStatusPanel(sampleContext);
    expect(statusPanel).toMatch(/\u001b\[/);

    // 4. Panel CLI Output (note, warn, error, stepStarted, stepSucceeded, stepFailed, finalSummary success/failure)
    const logs: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    try {
      console.log = (msg: string) => logs.push(msg);
      console.warn = (msg: string) => logs.push(msg);
      console.error = (msg: string) => logs.push(msg);

      const output = createPanelCliOutput(process.cwd());
      output.note('Test Note');
      output.warn('Test Warning');
      output.error('Test Error');
      output.stepSucceeded({ kind: 'audit', skillId: 'plan-audit', version: 1, message: 'Step Success' });
      output.stepFailed({ kind: 'repair', skillId: 'plan-repair', version: 1, message: 'Step Failure' });
      output.finalSummary({ success: true, message: 'Done', verdict: 'APPROVED', lastAuditPath: null });
      output.finalSummary({ success: false, message: 'Failed Run', verdict: 'REJECTED', lastAuditPath: null });

      const outputStarted = createPanelCliOutput(process.cwd());
      outputStarted.stepStarted({ kind: 'implement', skillId: 'implement', agent: 'opencode', model: 'opencode-model', iteration: 1, version: 1, message: 'Step Started' });

      const combined = logs.join('\n');
      expect(combined).toMatch(/\u001b\[/);
      const stripped = combined.replace(/\u001b\[\d+m/g, '');
      expect(stripped).toContain('Test Note');
      expect(stripped).toContain('Warning: Test Warning');
      expect(stripped).toContain('Error: Test Error');
      expect(stripped).toContain('Step Success');
      expect(stripped).toContain('Step Failure');
      expect(stripped).toContain('Done');
      expect(stripped).toContain('Failed Run');
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    // 5. Run Event
    const eventText = renderRunEvent(makeRunEvent({ type: 'note', atMs: Date.now(), message: 'Event test' }));
    expect(eventText).toMatch(/\u001b\[/);
    expect(eventText.replace(/\u001b\[\d+m/g, '')).toContain('Event test');

    // 6. Plain Panel
    const plainPanel = renderPlainPanel(sampleContext);
    expect(plainPanel).toMatch(/\u001b\[/);

    // 7. Format Menu Choice
    const menuChoice = formatMenuChoice({ label: 'Option A', recommended: true }, 'a');
    expect(menuChoice.name).toMatch(/\u001b\[/);
    expect(menuChoice.name.replace(/\u001b\[\d+m/g, '')).toContain('Option A');
  });

  describe('State × Surface Parameterized ANSI Matrix', () => {
    const resultStateCases: Array<{ state: ResultState; colorCode: string }> = [
      { state: 'accepted', colorCode: '\u001b[32m' },   // Green
      { state: 'completed', colorCode: '\u001b[32m' },  // Green
      { state: 'approved', colorCode: '\u001b[32m' },   // Green
      { state: 'retry', colorCode: '\u001b[31m' },      // Red
      { state: 'failed', colorCode: '\u001b[31m' },     // Red
      { state: 'rejected', colorCode: '\u001b[31m' },   // Red
      { state: 'blocked', colorCode: '\u001b[33m' },    // Yellow
      { state: 'unknown', colorCode: '\u001b[33m' },    // Yellow
      { state: 'interrupted', colorCode: '\u001b[33m' },// Yellow
    ];

    for (const { state, colorCode } of resultStateCases) {
      it(`renders ResultState '${state}' through status panel with ANSI code ${JSON.stringify(colorCode)}`, () => {
        const panelCtx: any = {
          projectRoot: process.cwd(),
          loopName: 'plan',
          currentIteration: 1,
          maxIterations: 3,
          activeSkillRunner: null,
          timeline: [
            {
              kind: 'evaluate',
              role: 'auditor',
              agent: 'opencode',
              model: 'opencode-model',
              decision: state,
              version: 1,
              artifactPath: '/path/to/eval.md',
              mtime: Date.now(),
              status: 'done',
            },
          ],
          nextStepMessage: 'Ready',
        };
        const rendered = renderStatusPanel(panelCtx);
        expect(rendered).toContain(colorCode);
        expect(rendered.replace(/\u001b\[\d+m/g, '')).toContain(state);
      });

      it(`renders ResultState '${state}' through plain panel with ANSI code ${JSON.stringify(colorCode)}`, () => {
        const panelCtx: any = {
          projectRoot: process.cwd(),
          loopName: 'plan',
          currentIteration: 1,
          maxIterations: 3,
          readOnly: false,
          activeSkillRunner: null,
          timeline: [
            {
              kind: 'evaluate',
              role: 'auditor',
              agent: 'opencode',
              model: 'opencode-model',
              decision: state,
              version: 1,
              artifactPath: '/path/to/eval.md',
              mtime: Date.now(),
              status: 'done',
            },
          ],
          nextStepMessage: 'Ready',
        };
        const rendered = renderPlainPanel(panelCtx);
        expect(rendered).toContain(colorCode);
        expect(rendered.replace(/\u001b\[\d+m/g, '')).toContain(state);
      });
    }

    const availabilityCases: Array<{ avail: AvailabilityState; colorCheck: (s: string) => boolean }> = [
      { avail: 'available', colorCheck: (s) => !s.includes('\u001b[31m') && !s.includes('\u001b[33m') },
      { avail: 'unavailable', colorCheck: (s) => s.includes('\u001b[2m') },
      { avail: 'missing-inputs', colorCheck: (s) => s.includes('\u001b[33m') },
    ];

    for (const { avail, colorCheck } of availabilityCases) {
      it(`renders AvailabilityState '${avail}' through formatMenuChoice`, () => {
        const choice = formatMenuChoice({ label: 'Test Item', disabledReason: avail !== 'available' ? 'reason' : undefined, availability: avail }, 'test');
        expect(colorCheck(choice.name)).toBe(true);
        expect(choice.name.replace(/\u001b\[\d+m/g, '')).toContain('Test Item');
      });
    }

    const eventLevelCases: Array<{ event: any; colorCode: string; text: string }> = [
      { event: makeRunEvent({ type: 'run.completed', atMs: Date.now(), result: 'success', outcome: 'completed' }), colorCode: '\u001b[32m', text: 'PASS' },
      { event: makeRunEvent({ type: 'run.failed', atMs: Date.now(), reason: 'Failed Run', errorKind: 'unknown' }), colorCode: '\u001b[31m', text: 'FAIL' },
      { event: makeRunEvent({ type: 'error', atMs: Date.now(), message: 'Error Event' }), colorCode: '\u001b[31m', text: 'Error Event' },
      { event: makeRunEvent({ type: 'warning', atMs: Date.now(), message: 'Warning Event' }), colorCode: '\u001b[33m', text: 'Warning Event' },
      { event: makeRunEvent({ type: 'run.started', atMs: Date.now() }), colorCode: '\u001b[36m', text: 'run.started' },
    ];

    for (const { event, colorCode, text } of eventLevelCases) {
      it(`renders EventLevel for '${event.type}' event through renderRunEvent with ANSI code ${JSON.stringify(colorCode)}`, () => {
        const rendered = renderRunEvent(event);
        expect(rendered).toContain(colorCode);
        expect(rendered.replace(/\u001b\[\d+m/g, '')).toContain(text);
      });
    }
  });
});
