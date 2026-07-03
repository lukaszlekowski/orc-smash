import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createPanelCliOutput, PANEL_RENDER_INTERVAL_MS } from '../src/cli-output.js';
import type { PanelContext } from '../src/status.js';
import { roleForKind, type StepKind, type StepStatus } from '../src/state.js';
import chalk from 'chalk';
import ora from 'ora';

const mockSpinner = {
  start: vi.fn(() => mockSpinner),
  stop: vi.fn(() => mockSpinner),
  succeed: vi.fn(() => mockSpinner),
  fail: vi.fn(() => mockSpinner)
};

vi.mock('ora', () => ({
  default: vi.fn(() => mockSpinner)
}));

function makeInFlight(kind: StepKind, startedAtMs: number, status: StepStatus = 'running') {
  return {
    kind,
    role: roleForKind(kind),
    skillId: 'plan-audit',
    agent: 'opencode',
    model: 'opencode-go/deepseek-v4-flash',
    version: 1,
    iteration: 1,
    startedAtMs,
    status,
    spawnLabel: 'Spawning opencode for audit v1...',
    toolCallCount: 0,
    progressMessage: null
  };
}

function makeContext(inFlight: PanelContext['inFlight']): PanelContext {
  return {
    projectRoot: '/p',
    loopName: 'plan',
    currentIteration: 1,
    maxIterations: 5,
    activeSkillRunner: inFlight
      ? { skillId: inFlight.skillId, agent: inFlight.agent, model: inFlight.model }
      : null,
    timeline: [],
    nextStepMessage: 'next',
    inFlight,
    latestVersion: 0,
    readOnly: false
  };
}

describe('createPanelCliOutput — live region seam', () => {
  let stdoutWriteSpy: any;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    chalk.level = 1;
    vi.useFakeTimers();
    stdoutWriteSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    originalIsTTY = (process.stdout as any).isTTY;
    (process.stdout as any).isTTY = true;
    vi.mocked(ora).mockClear();
    mockSpinner.start.mockClear();
    mockSpinner.stop.mockClear();
    mockSpinner.succeed.mockClear();
    mockSpinner.fail.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    (process.stdout as any).isTTY = originalIsTTY;
  });

  it('PANEL_RENDER_INTERVAL_MS is 1000ms', () => {
    expect(PANEL_RENDER_INTERVAL_MS).toBe(1000);
  });

  it('attachLiveRegion starts an interval that calls renderStatusPanel on each tick', () => {
    const output = createPanelCliOutput();
    const startedAtMs = Date.now();
    let calls = 0;
    output.attachLiveRegion!(() => {
      calls += 1;
      return makeContext(makeInFlight('audit', startedAtMs));
    });
    expect(output.detachLiveRegion).toBeDefined();

    vi.advanceTimersByTime(PANEL_RENDER_INTERVAL_MS);
    vi.advanceTimersByTime(PANEL_RENDER_INTERVAL_MS);
    vi.advanceTimersByTime(PANEL_RENDER_INTERVAL_MS);
    expect(calls).toBeGreaterThanOrEqual(3);
    output.detachLiveRegion!();
  });

  it('detachLiveRegion stops further ticks', () => {
    const output = createPanelCliOutput();
    let calls = 0;
    output.attachLiveRegion!(() => {
      calls += 1;
      return makeContext(makeInFlight('audit', Date.now()));
    });
    vi.advanceTimersByTime(PANEL_RENDER_INTERVAL_MS);
    expect(calls).toBeGreaterThanOrEqual(1);
    output.detachLiveRegion!();
    const callsAtDetach = calls;
    vi.advanceTimersByTime(PANEL_RENDER_INTERVAL_MS * 5);
    expect(calls).toBe(callsAtDetach);
  });

  it('on each tick the rendered output contains the "Active Step" section and the elapsed token', () => {
    const output = createPanelCliOutput();
    output.attachLiveRegion!(() => makeContext(makeInFlight('follow-up', Date.now())));
    vi.advanceTimersByTime(PANEL_RENDER_INTERVAL_MS);
    const writeChunks = stdoutWriteSpy.mock.calls.map((c: any) => c[0]).join('');
    expect(writeChunks).toContain('Active Step:');
    expect(writeChunks).toMatch(/\(elapsed \d+s\)/);
    output.detachLiveRegion!();
  });

  it('on each tick the elapsed token grows as the clock advances (startedAtMs is captured once)', () => {
    // Use system-time mocking so Date.now() advances with vi.advanceTimersByTime.
    const baseTime = 1700000000000;
    vi.setSystemTime(baseTime);
    const output = createPanelCliOutput();
    const startedAtMs = Date.now();
    output.attachLiveRegion!(() => makeContext(makeInFlight('audit', startedAtMs)));

    vi.advanceTimersByTime(PANEL_RENDER_INTERVAL_MS);
    const writesAfterFirstTick = stdoutWriteSpy.mock.calls.length;
    // Look at the writes produced by the first tick: the elapsed should be 0
    // (200ms in, Math.floor(0.2) = 0).
    // The first tick's last write carries the elapsed value for the first tick.
    let firstSecs: number | null = null;
    for (let i = 0; i < writesAfterFirstTick; i++) {
      const c = stdoutWriteSpy.mock.calls[i]![0] as string;
      const m = c.match(/elapsed (\d+)s/);
      if (m) firstSecs = parseInt(m[1]!, 10);
    }

    vi.advanceTimersByTime(PANEL_RENDER_INTERVAL_MS);
    // The second-tick range ends after PANEL_RENDER_INTERVAL_MS of clock advance; the LAST write
    // in that range carries the largest elapsed value (elapsed grows
    // monotonically because startedAtMs is the closed-over fixed value).
    let secondSecs: number | null = null;
    for (let i = writesAfterFirstTick; i < stdoutWriteSpy.mock.calls.length; i++) {
      const c = stdoutWriteSpy.mock.calls[i]![0] as string;
      const m = c.match(/elapsed (\d+)s/);
      if (m) secondSecs = parseInt(m[1]!, 10);
    }

    expect(firstSecs).not.toBeNull();
    expect(secondSecs).not.toBeNull();
    expect(secondSecs!).toBeGreaterThan(firstSecs!);
    output.detachLiveRegion!();
  });

  it('stepStarted does NOT call ora() when attachLiveRegion is active (spinner is folded into the live region)', () => {
    const output = createPanelCliOutput();
    output.attachLiveRegion!(() => makeContext(makeInFlight('audit', Date.now())));
    output.stepStarted({
      kind: 'audit', skillId: 'plan-audit', agent: 'opencode', model: 'm',
      iteration: 1, version: 1, message: 'live step started'
    });
    // The spinner must NOT be started when the live region is active:
    // attachLiveRegion sets liveActive = true, and stepStarted returns early.
    expect(ora).not.toHaveBeenCalled();
    expect(mockSpinner.start).not.toHaveBeenCalled();
    output.detachLiveRegion!();
  });

  it('detachLiveRegion renders one final frame with the failed "Active Step" state when inFlight.status is "failed" (review v7 Major finding #1 closure)', () => {
    const output = createPanelCliOutput();
    let currentStatus: StepStatus = 'running';
    const startedAtMs = Date.now();

    output.attachLiveRegion!(() => makeContext({
      kind: 'audit',
      role: 'auditor',
      skillId: 'plan-audit',
      agent: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      version: 1,
      iteration: 1,
      startedAtMs,
      status: currentStatus,
      spawnLabel: 'Spawning opencode for audit v1...',
      toolCallCount: 0,
      progressMessage: 'audit v1'
    }));

    // Simulate a lifecycle failure transition (loop.onLifecycle flips status to 'failed')
    currentStatus = 'failed';

    // detachLiveRegion renders one final frame from the live supplier before clearing
    output.detachLiveRegion!();

    const allWrites = stdoutWriteSpy.mock.calls.map((c: any) => c[0]).join('');
    expect(allWrites).toContain('Active Step:');
    expect(allWrites).toContain('failed');
    // Red ANSI escape code (\u001B[31m) must be present for the failed status accent
    expect(allWrites).toMatch(/\u001B\[31m/);
  });

  it('stepStarted calls ora() with the spinner when no live region is attached (backward compat)', () => {
    // Without attachLiveRegion, stepStarted must fall through to the legacy
    // ora(...).start() path.
    const output = createPanelCliOutput();
    output.stepStarted({
      kind: 'audit', skillId: 'plan-audit', agent: 'opencode', model: 'm',
      iteration: 1, version: 1, message: 'legacy step started'
    });
    expect(ora).toHaveBeenCalledWith(expect.stringContaining('legacy step started'));
    expect(mockSpinner.start).toHaveBeenCalled();
  });
});
