import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runLoop } from '../src/loop.js';
import { loadConfig } from '../src/config.js';
import { fakeAdapterState } from '../src/adapters/fake.js';
import { createTestAdapterRegistry } from '../src/adapters/testing.js';
import { panelBorderColor } from '../src/status-accent.js';
import type { PanelContext, PanelContextSnapshot } from './helpers/panel-context.js';
import type { LifecycleEvent } from '../src/adapter-lifecycle.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';
import type { RunEvent } from '../src/run-event.js';

const tempWorkspace = join(process.cwd(), 'temp-loop-live-test');

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  const { createTestConfig } = await import('./helpers/test-config.js');
  return {
    ...actual,
    loadConfig: (projectRoot?: string) => createTestConfig({ projectRoot })
  };
});

beforeEach(() => {
  createTempDir('temp-loop-live-test');
  mkdirSync(join(tempWorkspace, 'docs/dev'), { recursive: true });
  writeFileSync(join(tempWorkspace, 'docs/dev/plan.md'),
    '---\nstatus: ready\nconfidence: 0.96\nowners: harness-runtime\n---\n\n# My Plan\n');
  fakeAdapterState.verdicts = [];
  fakeAdapterState.delayMs = undefined;
  fakeAdapterState.lifecycleMessages = [];
  fakeAdapterState.failAfterMs = undefined;
  fakeAdapterState.exitCode = 0;
  fakeAdapterState.stdout = '';
});

afterEach(() => {
  removeTempDir(tempWorkspace);
  vi.restoreAllMocks();
});

/**
 * Snapshot a PanelContext at capture time. The PanelContext's `timeline` is a
 * reference to the loop's `steps` array, which is mutated as the loop
 * progresses. Without snapshotting, every captured context would show the
 * final timeline state, making the "pre-artifact" assertions impossible.
 */
function snapshot(ctx: PanelContext): PanelContextSnapshot {
  return {
    projectRoot: ctx.projectRoot,
    loopName: ctx.loopName,
    currentIteration: ctx.currentIteration,
    maxIterations: ctx.maxIterations,
    activeSkillRunner: ctx.activeSkillRunner,
    timelineKinds: ctx.timeline.map(s => s.kind),
    nextStepMessage: ctx.nextStepMessage,
    inFlightKind: ctx.inFlight?.kind ?? null,
    inFlightRole: ctx.inFlight?.role ?? null,
    inFlightStatus: ctx.inFlight?.status ?? null,
    inFlightStartedAtMs: ctx.inFlight?.startedAtMs ?? null,
    latestVersion: ctx.latestVersion,
    readOnly: ctx.readOnly
  };
}

function makeCapturingPanelOutput(captured: { snapshots: PanelContextSnapshot[]; events: LifecycleEvent[]; rawContexts: PanelContext[] }) {
  let supplierRef: (() => PanelContext) | null = null;
  return {
    ...createMockOutput(),
    renderPanel: (ctx: PanelContext) => { captured.snapshots.push(snapshot(ctx)); captured.rawContexts.push(ctx); },
    attachLiveRegion: (supplier: () => PanelContext) => {
      supplierRef = supplier;
      // Capture the supplier's return value at attach-time. The supplier
      // closes over the runAdapter's `liveInFlight` and `steps`; the
      // snapshot freezes the state at attach-time so subsequent pushes to
      // `steps` do not affect this capture.
      const ctx = supplier();
      captured.snapshots.push(snapshot(ctx));
      captured.rawContexts.push(ctx);
    },
    detachLiveRegion: () => {
      if (supplierRef) {
        // Capture the supplier's return value at detach-time. After a
        // failure lifecycle event, `liveInFlight.status` has been flipped
        // to 'failed'; this snapshot freezes the post-failure state.
        const ctx = supplierRef();
        captured.snapshots.push(snapshot(ctx));
        captured.rawContexts.push(ctx);
      }
    }
  };
}

describe('loop-level live region — runLoop with delayed fake adapter', () => {
  it('emits bounded provider progress and caps rendered tool-call counts', async () => {
    fakeAdapterState.verdicts = ['APPROVED'];
    fakeAdapterState.lifecycleMessages = Array.from({ length: 20 }, (_, index) => ({
      text: `provider progress ${index}`,
      toolCalls: 100
    }));
    const config = loadConfig(tempWorkspace);
    const registry = createTestAdapterRegistry();
    const events: RunEvent[] = [];
    const output = {
      ...createMockOutput(),
      emit: (event: RunEvent) => events.push(event)
    };

    await runLoop(tempWorkspace, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    }, {
      maxIterations: 5,
      registry,
      output,
      interactive: false
    });

    const progress = events.filter((event): event is Extract<RunEvent, { type: 'provider.progress' }> => event.type === 'provider.progress');
    const completed = events.find((event): event is Extract<RunEvent, { type: 'provider.completed' }> => event.type === 'provider.completed');
    expect(progress.length).toBeLessThanOrEqual(8);
    expect(progress.at(-1)?.message).toBe('progress suppressed');
    expect(completed?.toolCalls).toBe('999+');
  });

  it('captures the first pre-spawn renderPanel context with currentIteration === 1 (1-based loop counter, v11 audit Major closure)', async () => {
    fakeAdapterState.verdicts = ['APPROVED'];
    fakeAdapterState.delayMs = 50;
    const config = loadConfig(tempWorkspace);
    const registry = createTestAdapterRegistry();
    const captured = { snapshots: [] as PanelContextSnapshot[], events: [] as LifecycleEvent[], rawContexts: [] as PanelContext[] };
    const output = makeCapturingPanelOutput(captured);

    await runLoop(tempWorkspace, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    }, {
      maxIterations: 5,
      registry,
      output,
      interactive: false
    });

    // The first captured snapshot is the pre-spawn renderPanel for audit v1.
    // It must carry currentIteration === 1 (the 1-based display rule).
    expect(captured.snapshots.length).toBeGreaterThan(0);
    const first = captured.snapshots[0]!;
    expect(first.currentIteration).toBe(1);
    expect(first.maxIterations).toBe(5);
  });

  it('live follow-up spawn carries inFlight.kind === "follow-up" and panelBorderColor === "yellow" (v9 audit Major #2 closure)', async () => {
    fakeAdapterState.verdicts = ['REJECTED', 'APPROVED'];
    fakeAdapterState.delayMs = 50;
    const config = loadConfig(tempWorkspace);
    const registry = createTestAdapterRegistry();
    const captured = { snapshots: [] as PanelContextSnapshot[], events: [] as LifecycleEvent[], rawContexts: [] as PanelContext[] };
    const output = makeCapturingPanelOutput(captured);

    await runLoop(tempWorkspace, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    }, {
      maxIterations: 5,
      registry,
      output,
      interactive: false
    });

    // At least one snapshot must have inFlightKind === 'follow-up'
    // (the live follow-up spawn's in-flight record).
    const followUpSnapshots = captured.snapshots.filter(s => s.inFlightKind === 'follow-up');
    expect(followUpSnapshots.length).toBeGreaterThan(0);
    // The timeline (snapshot) must NOT contain a follow-up step at attach-time
    // (the pre-artifact case — the follow-up hasn't been pushed yet).
    for (const snap of followUpSnapshots) {
      expect(snap.timelineKinds.includes('follow-up')).toBe(false);
    }
    // panelBorderColor during the live follow-up spawn must be 'yellow'
    // (the border mirrors the in-flight kind, not the historical timeline).
    const followUpRaw = captured.rawContexts.filter(ctx => ctx.inFlight?.kind === 'follow-up');
    expect(followUpRaw.length).toBeGreaterThan(0);
    for (const ctx of followUpRaw) {
      expect(panelBorderColor(ctx)).toBe('yellow');
    }
  });

  it('live audit spawn carries inFlight.kind === "audit" with status: "running"', async () => {
    fakeAdapterState.verdicts = ['APPROVED'];
    fakeAdapterState.delayMs = 50;
    const config = loadConfig(tempWorkspace);
    const registry = createTestAdapterRegistry();
    const captured = { snapshots: [] as PanelContextSnapshot[], events: [] as LifecycleEvent[], rawContexts: [] as PanelContext[] };
    const output = makeCapturingPanelOutput(captured);

    await runLoop(tempWorkspace, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    }, {
      maxIterations: 5,
      registry,
      output,
      interactive: false
    });

    const auditLive = captured.snapshots.filter(s => s.inFlightKind === 'audit' && s.inFlightStatus === 'running');
    expect(auditLive.length).toBeGreaterThan(0);
  });

  it('the loop attaches the live region before stepStarted and detaches after the spawn completes (loop-level ordering contract)', async () => {
    fakeAdapterState.verdicts = ['APPROVED'];
    fakeAdapterState.delayMs = 50;
    const config = loadConfig(tempWorkspace);
    const registry = createTestAdapterRegistry();
    let attachOrder = 0;
    let detachOrder = 0;
    let stepStartedOrder = 0;
    let currentOrder = 0;
    const output = {
      ...createMockOutput(),
      stepStarted: () => { if (!stepStartedOrder) { stepStartedOrder = ++currentOrder; } },
      attachLiveRegion: () => { if (!attachOrder) { attachOrder = ++currentOrder; } },
      detachLiveRegion: () => { if (!detachOrder) { detachOrder = ++currentOrder; } }
    };

    await runLoop(tempWorkspace, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    }, {
      maxIterations: 5,
      registry,
      output,
      interactive: false
    });

    expect(attachOrder).toBeGreaterThan(0);
    expect(stepStartedOrder).toBeGreaterThan(0);
    expect(detachOrder).toBeGreaterThan(0);
    expect(attachOrder).toBeLessThan(stepStartedOrder);
    expect(detachOrder).toBeGreaterThan(stepStartedOrder);
  });
});

describe('loop-level live region — failure transition (v8 audit M1 closure)', () => {
  it('failed in-flight status appears in a captured snapshot after a failAfterMs transition (status flips to "failed")', async () => {
    fakeAdapterState.verdicts = ['APPROVED'];
    fakeAdapterState.delayMs = 50;
    fakeAdapterState.failAfterMs = 20;
    const config = loadConfig(tempWorkspace);
    const registry = createTestAdapterRegistry();
    const captured = { snapshots: [] as PanelContextSnapshot[], events: [] as LifecycleEvent[], rawContexts: [] as PanelContext[] };
    const output = makeCapturingPanelOutput(captured);

    await runLoop(tempWorkspace, 'plan', config.manifest.loops['plan']!, config, {
      'plan-audit': { agent: 'fake', model: 'fake-model' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model' }
    }, {
      maxIterations: 5,
      registry,
      output,
      interactive: false
    });

    // The attach-time snapshot has status='running'. After the failure
    // lifecycle event fires (failAfterMs), the loop's onLifecycle handler
    // flips liveInFlight.status to 'failed'. The detachLiveRegion snapshot
    // captures this post-failure state.
    const failedSnapshots = captured.snapshots.filter(s => s.inFlightStatus === 'failed');
    expect(failedSnapshots.length).toBeGreaterThan(0);

    // startedAtMs is the same fixed value across the transition (captured
    // once at the top of runAdapter, never recomputed by the supplier).
    const startedAtValues = new Set(captured.snapshots.map(s => s.inFlightStartedAtMs).filter(Boolean));
    expect(startedAtValues.size).toBe(1);

    // At least one snapshot retains the 'running' status (the attach-time
    // capture before the failure event fires).
    const runningSnapshots = captured.snapshots.filter(s => s.inFlightStatus === 'running');
    expect(runningSnapshots.length).toBeGreaterThan(0);
  });
});

describe('loop-level live region — implement loop (v9 audit Major #2 closure)', () => {
  it('live implement spawn captures pre-artifact state and panelBorderColor === "green"', async () => {
    // Write an approved plan audit artifact so requireApprovedPlanAuditPath succeeds
    const devDir = join(tempWorkspace, 'docs/dev');
    mkdirSync(devDir, { recursive: true });
    writeFileSync(join(devDir, 'plan-audit-v1-fake.md'),
      '# Plan Audit\n\n## Verdict\n\nAPPROVED\n');

    // plan.md with proper front matter (needed by implement closeout)
    writeFileSync(join(devDir, 'plan.md'),
      '---\nstatus: ready\nconfidence: 0.96\n---\n\n# My Plan\n');

    const config = loadConfig(tempWorkspace);
    const registry = createTestAdapterRegistry();
    const captured = { snapshots: [] as PanelContextSnapshot[], events: [] as LifecycleEvent[], rawContexts: [] as PanelContext[] };
    const output = makeCapturingPanelOutput(captured);

    fakeAdapterState.verdicts = [];
    fakeAdapterState.delayMs = 50;

    const implementLoopSpec = config.manifest.loops['implement']!;

    await runLoop(tempWorkspace, 'implement', implementLoopSpec, config, {
      '30-simple-implement': { agent: 'fake', model: 'fake-model' }
    }, {
      maxIterations: 1,
      registry,
      output,
      interactive: false
    });

    // At least one snapshot must have inFlightKind === 'implement'
    const implementSnapshots = captured.snapshots.filter(s => s.inFlightKind === 'implement');
    expect(implementSnapshots.length).toBeGreaterThan(0);

    // Pre-artifact case: timeline must NOT contain an implement step at attach-time
    // (the implement hasn't been pushed yet).
    for (const snap of implementSnapshots) {
      expect(snap.timelineKinds.includes('implement')).toBe(false);
    }

    // At least one snapshot has inFlightStatus === 'running'
    const runningImplement = captured.snapshots.filter(s => s.inFlightKind === 'implement' && s.inFlightStatus === 'running');
    expect(runningImplement.length).toBeGreaterThan(0);

    // panelBorderColor during the live implement spawn must be 'green'
    const implementRaw = captured.rawContexts.filter(ctx => ctx.inFlight?.kind === 'implement');
    expect(implementRaw.length).toBeGreaterThan(0);
    for (const ctx of implementRaw) {
      expect(panelBorderColor(ctx)).toBe('green');
    }
  });

  it('review loop live panel contains reviewer and implementer roles in inFlightRole and has loop-aware nextStepMessages', async () => {
    const config = loadConfig(tempWorkspace);
    const registry = createTestAdapterRegistry();
    const captured = { snapshots: [] as PanelContextSnapshot[], events: [] as LifecycleEvent[], rawContexts: [] as PanelContext[] };
    const output = makeCapturingPanelOutput(captured);

    fakeAdapterState.verdicts = ['REJECTED'];
    fakeAdapterState.delayMs = 20;

    const reviewLoopSpec = config.manifest.loops['review']!;

    await runLoop(tempWorkspace, 'review', reviewLoopSpec, config, {
      'review': { agent: 'fake', model: 'fake-model' },
      'review-follow-up': { agent: 'fake', model: 'fake-model' }
    }, {
      maxIterations: 2,
      registry,
      output,
      interactive: false
    });

    // Check snapshots captured during the audit phase (kind: audit)
    const auditSnapshots = captured.snapshots.filter(s => s.inFlightKind === 'audit');
    expect(auditSnapshots.length).toBeGreaterThan(0);
    for (const snap of auditSnapshots) {
      expect(snap.inFlightRole).toBe('reviewer');
      expect(snap.nextStepMessage).toContain('review');
    }

    // Check snapshots captured during the follow-up phase (kind: follow-up)
    const followUpSnapshots = captured.snapshots.filter(s => s.inFlightKind === 'follow-up');
    expect(followUpSnapshots.length).toBeGreaterThan(0);
    for (const snap of followUpSnapshots) {
      expect(snap.inFlightRole).toBe('implementer');
      expect(snap.nextStepMessage).toContain('review-follow-up');
    }
  });
});
