import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { executeLoopStep, type LoopExecutionDeps, type ExecuteLoopStep } from '../src/loops/execution.js';
import { runBinding } from '../src/loops/binding-engine.js';
import { writeArtifactWithMeta } from '../src/provenance.js';
import { type RunContext } from '../src/pipeline-state.js';
import { makeV1ArtifactMeta } from './helpers/v1-artifact.js';
import { createTestAdapterRegistry, resetFakeAdapterState } from '../src/adapters/testing.js';
import { renderStatusPanel } from '../src/status-panel.js';
import type { PanelContext } from '../src/status.js';
import { createPanelCliOutput } from '../src/cli-output.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

describe('Slice 6 Live Panel Display Integration (N5 & AC9)', () => {
  const tempWorkspace = resolve(process.cwd(), 'temp-execution-panel-test');

  beforeEach(() => {
    createTempDir('temp-execution-panel-test');
    mkdirSync(join(tempWorkspace, 'docs/dev'), { recursive: true });
    mkdirSync(join(tempWorkspace, 'roles'), { recursive: true });
    mkdirSync(join(tempWorkspace, 'skills'), { recursive: true });
    writeFileSync(join(tempWorkspace, 'docs/dev/plan.md'), '# Plan\n');
    writeFileSync(join(tempWorkspace, 'roles/auditor.md'), 'Auditor role');
    writeFileSync(join(tempWorkspace, 'roles/planner.md'), 'Planner role');
    writeFileSync(join(tempWorkspace, 'skills/audit.md'), 'Audit skill');
    writeFileSync(join(tempWorkspace, 'skills/repair.md'), 'Repair skill');
  });

  afterEach(() => {
    removeTempDir(tempWorkspace);
  });

  it('populates resolvedRunners and activeInvocation in PanelContext during executeLoopStep (fresh session)', async () => {
    let capturedPanelContextCallback: (() => PanelContext) | null = null;
    const output = createPanelCliOutput();
    output.attachLiveRegion = (cb: () => PanelContext) => {
      capturedPanelContextCallback = cb;
    };

    const registry = createTestAdapterRegistry();
    const config = {
      projectRoot: tempWorkspace,
      manifestPath: join(tempWorkspace, 'config/orc-smash.yaml'),
      manifestRoot: tempWorkspace,
      manifest: {
        schemaVersion: 1,
        roles: { auditor: 'roles/auditor.md', planner: 'roles/planner.md' },
        skills: {
          'plan-audit': { file: 'skills/audit.md', role: 'auditor', runnerProfile: 'default' },
          'plan-follow-up': { file: 'skills/repair.md', role: 'planner', runnerProfile: 'default' },
        },
        loops: {
          plan: {
            type: 'approval-loop',
            target: { path: 'docs/dev/plan.md', kind: 'file' },
            inputs: [],
            evaluate: { skill: 'plan-audit', output: { pattern: 'out.md', contract: 'decision-artifact' } },
            repair: { skill: 'plan-follow-up', output: { pattern: 'out.md', contract: 'completion-artifact' } },
          },
        },
        tasks: {},
        pipelines: {},
      },
      registry: { providers: {} },
    } as any;

    const deps: LoopExecutionDeps = {
      projectRoot: tempWorkspace,
      loopName: 'plan',
      bindingKind: 'loop',
      loopSpec: config.manifest.loops.plan,
      config,
      registry,
      output,
      steps: [],
      maxIterations: 5,
      runners: {
        'plan-audit': { agent: 'opencode', model: 'opencode-model', effort: 'medium', sessionStrategy: 'resume-per-skill' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model', effort: undefined, sessionStrategy: 'fresh-per-invocation' },
      },
    };

    const request: ExecuteLoopStep = {
      runner: deps.runners!['plan-audit']!,
      prompt: 'Test prompt',
      spawnLabel: 'Running plan-audit v1...',
      kind: 'evaluate',
      skillId: 'plan-audit',
      version: 1,
      iteration: 1,
      continuity: { mode: 'fresh', freshReason: 'policy' },
      sessionStrategy: 'resume-per-skill',
      inputFingerprint: 'hash123',
    };

    // Execute loop step (will call attachLiveRegion)
    const runPromise = executeLoopStep(deps, request);

    expect(capturedPanelContextCallback).not.toBeNull();
    const panelContext = capturedPanelContextCallback!();

    // 1. Verify resolvedRunners contains both skills for the loop
    expect(panelContext.resolvedRunners).toBeDefined();
    expect(panelContext.resolvedRunners!.length).toBe(2);

    const evalRunner = panelContext.resolvedRunners!.find(r => r.skillId === 'plan-audit');
    expect(evalRunner).toBeDefined();
    expect(evalRunner!.phase).toBe('evaluate');
    expect(evalRunner!.role).toBe('auditor');
    expect(evalRunner!.agent).toBe('opencode');
    expect(evalRunner!.model).toBe('opencode-model');
    expect(evalRunner!.effort).toBe('medium');
    expect(evalRunner!.sessionStrategy).toBe('resume-per-skill');

    const repRunner = panelContext.resolvedRunners!.find(r => r.skillId === 'plan-follow-up');
    expect(repRunner).toBeDefined();
    expect(repRunner!.phase).toBe('repair');
    expect(repRunner!.role).toBe('planner');
    expect(repRunner!.agent).toBe('fake');

    // 2. Verify activeInvocation carries fresh mode + policy reason and pending new session indicator
    expect(panelContext.activeInvocation).toBeDefined();
    expect(panelContext.activeInvocation!.skillId).toBe('plan-audit');
    expect(panelContext.activeInvocation!.version).toBe(1);
    expect(panelContext.activeInvocation!.sessionMode).toBe('fresh');
    expect(panelContext.activeInvocation!.freshReason).toBe('policy');
    expect(panelContext.activeInvocation!.newSessionPending).toBe(true);

    // 3. Verify status panel rendered output contains Run configuration (with role) and Active invocation (with pending) sections
    const rendered = renderStatusPanel(panelContext);
    expect(rendered).toContain('Run configuration');
    expect(rendered).toContain('Evaluate   plan-audit (auditor)');
    expect(rendered).toContain('opencode · opencode-model');
    expect(rendered).toContain('Repair     plan-follow-up (planner)');
    expect(rendered).toContain('Active invocation');
    expect(rendered).toContain('plan-audit v1 — fresh session (policy, new session ID: pending)');

    await runPromise;
  });

  it('renders resumed session state in live panel during executeLoopStep', async () => {
    let capturedPanelContextCallback: (() => PanelContext) | null = null;
    const output = createPanelCliOutput();
    output.attachLiveRegion = (cb: () => PanelContext) => {
      capturedPanelContextCallback = cb;
    };

    const registry = createTestAdapterRegistry();
    const config = {
      projectRoot: tempWorkspace,
      manifestPath: join(tempWorkspace, 'config/orc-smash.yaml'),
      manifestRoot: tempWorkspace,
      manifest: {
        schemaVersion: 1,
        roles: { auditor: 'roles/auditor.md', planner: 'roles/planner.md' },
        skills: {
          'plan-audit': { file: 'skills/audit.md', role: 'auditor', runnerProfile: 'default' },
          'plan-follow-up': { file: 'skills/repair.md', role: 'planner', runnerProfile: 'default' },
        },
        loops: {
          plan: {
            type: 'approval-loop',
            target: { path: 'docs/dev/plan.md', kind: 'file' },
            inputs: [],
            evaluate: { skill: 'plan-audit', output: { pattern: 'out.md', contract: 'decision-artifact' } },
            repair: { skill: 'plan-follow-up', output: { pattern: 'out.md', contract: 'completion-artifact' } },
          },
        },
        tasks: {},
        pipelines: {},
      },
      registry: { providers: {} },
    } as any;

    const deps: LoopExecutionDeps = {
      projectRoot: tempWorkspace,
      loopName: 'plan',
      bindingKind: 'loop',
      loopSpec: config.manifest.loops.plan,
      config,
      registry,
      output,
      steps: [],
      maxIterations: 5,
      runners: {
        'plan-audit': { agent: 'opencode', model: 'opencode-model', effort: 'high', sessionStrategy: 'resume-per-skill' },
        'plan-follow-up': { agent: 'fake', model: 'fake-model', effort: undefined, sessionStrategy: 'fresh-per-invocation' },
      },
    };

    const request: ExecuteLoopStep = {
      runner: deps.runners!['plan-audit']!,
      prompt: 'Test prompt',
      spawnLabel: 'Running plan-audit v2 (resumed)...',
      kind: 'evaluate',
      skillId: 'plan-audit',
      version: 2,
      iteration: 2,
      continuity: { mode: 'resumed', sessionId: 'sess-abc-98765' },
      sessionStrategy: 'resume-per-skill',
      inputFingerprint: 'hash456',
    };

    const runPromise = executeLoopStep(deps, request);

    expect(capturedPanelContextCallback).not.toBeNull();
    const panelContext = capturedPanelContextCallback!();

    expect(panelContext.activeInvocation).toBeDefined();
    expect(panelContext.activeInvocation!.sessionMode).toBe('resumed');
    expect(panelContext.activeInvocation!.sessionId).toBe('sess-abc-98765');

    const rendered = renderStatusPanel(panelContext);
    expect(rendered).toContain('Active invocation');
    expect(rendered).toContain('plan-audit v2 — resuming session *98765');

    await runPromise;
  });

  it('renders post-completion step in timeline carrying recorded provider session ID', () => {
    const panelContext: PanelContext = {
      projectRoot: tempWorkspace,
      loopName: 'plan',
      currentIteration: 1,
      maxIterations: 5,
      activeSkillRunner: null,
      timeline: [
        {
          kind: 'evaluate',
          role: 'auditor',
          agent: 'opencode',
          model: 'opencode-model',
          version: 1,
          status: 'done',
          artifactPath: join(tempWorkspace, 'docs/dev/plan-audit-v1-opencode.md'),
          mtime: Date.now(),
          decision: 'accepted',
          sessionId: 'sess-persist-999',
          durationMs: 1200,
        },
      ],
      nextStepMessage: 'accepted',
      inFlight: null,
      latestVersion: 1,
      readOnly: false,
    };

    const rendered = renderStatusPanel(panelContext);
    expect(rendered).toContain('*t-999');
  });

  it('drives session continuity through binding-engine seam and records session ID in panel and timeline', async () => {
    resetFakeAdapterState();

    // 1. Write prior evaluate v1 (REJECTED) with session ID and resume-per-skill strategy
    const eval1Meta = makeV1ArtifactMeta({
      version: 1,
      provider: 'fake',
      agent: 'fake',
      model: 'fake-model',
      effort: 'medium',
      sessionStrategy: 'resume-per-skill',
      sessionMode: 'fresh',
      sessionId: 'sess-seam-789',
      bindingId: 'plan',
      kind: 'evaluate',
      step: 'evaluate',
      parentArtifactIdentity: null,
    });
    writeArtifactWithMeta(
      join(tempWorkspace, 'docs/dev/plan-audit-v1-fake.md'),
      '# Evaluation\n\n## Verdict\n\nREJECTED\n',
      eval1Meta,
    );

    // 2. Write repair v1 (COMPLETED) linked to eval v1
    const rep1Meta = makeV1ArtifactMeta({
      version: 1,
      provider: 'fake',
      agent: 'fake',
      model: 'fake-model',
      effort: 'provider default',
      skill: 'plan-follow-up',
      role: 'planner',
      sessionStrategy: 'fresh-per-invocation',
      sessionMode: 'fresh',
      sessionId: 'sess-rep-789',
      bindingId: 'plan',
      kind: 'repair',
      step: 'repair',
      chainId: eval1Meta.chainId,
      parentArtifactIdentity: eval1Meta.artifactIdentity,
    });
    writeArtifactWithMeta(
      join(tempWorkspace, 'docs/dev/plan-followup-v1-fake.md'),
      '# Repair\n\n## Outcome\n\nCOMPLETED\n',
      rep1Meta,
    );

    const config = {
      projectRoot: tempWorkspace,
      manifestPath: join(tempWorkspace, 'config/orc-smash.yaml'),
      manifestRoot: tempWorkspace,
      manifest: {
        schemaVersion: 1,
        roles: { auditor: 'roles/auditor.md', planner: 'roles/planner.md' },
        skills: {
          'plan-audit': { file: 'skills/audit.md', role: 'auditor', runnerProfile: 'default' },
          'plan-follow-up': { file: 'skills/repair.md', role: 'planner', runnerProfile: 'default' },
        },
        loops: {
          plan: {
            type: 'approval-loop',
            target: { path: 'docs/dev/plan.md', kind: 'file' },
            inputs: [{ source: 'target' }, { source: 'version' }, { source: 'priorArtifact' }, { source: 'outputPath' }],
            evaluate: { skill: 'plan-audit', output: { pattern: 'docs/dev/plan-audit-v{version}-{provider}.md', contract: 'decision-artifact', decision: { heading: 'Verdict', accepted: 'APPROVED', retry: 'REJECTED' } } },
            repair: { skill: 'plan-follow-up', output: { pattern: 'docs/dev/plan-followup-v{version}-{provider}.md', contract: 'completion-artifact' } },
          },
        },
        tasks: {},
        pipelines: {},
      },
      registry: { providers: {} },
    } as any;

    let capturedContexts: PanelContext[] = [];
    const output = createPanelCliOutput();
    output.attachLiveRegion = (cb: () => PanelContext) => {
      capturedContexts.push(cb());
    };

    const registry = createTestAdapterRegistry();

    const runners = {
      'plan-audit': { agent: 'fake', model: 'fake-model', effort: 'medium', sessionStrategy: 'resume-per-skill' },
      'plan-follow-up': { agent: 'fake', model: 'fake-model', effort: undefined, sessionStrategy: 'fresh-per-invocation' },
    };

    const runContext: RunContext = {
      pipelineId: null,
      pipelineRunId: null,
      stageId: null,
      chainId: eval1Meta.chainId!,
      chainMode: 'ad-hoc',
      parentArtifactIdentity: null,
    };

    // Run binding for 1 iteration (will execute evaluate v2)
    const result = await runBinding(
      tempWorkspace,
      'plan',
      'loop',
      config.manifest.loops.plan,
      config,
      runners,
      {
        maxIterations: 1,
        registry,
        output,
        runContext,
      },
    );

    // Verify live region was attached during runBinding execution
    expect(capturedContexts.length).toBeGreaterThan(0);
    const activeCtx = capturedContexts.find(c => c.activeInvocation !== null);
    expect(activeCtx).toBeDefined();
    expect(activeCtx!.activeInvocation!.sessionMode).toBe('resumed');
    expect(activeCtx!.activeInvocation!.sessionId).toBe('sess-seam-789');

    // Verify status panel rendered text while active showed resuming session
    const activeRendered = renderStatusPanel(activeCtx!);
    expect(activeRendered).toContain('plan-audit v2 — resuming session *m-789');

    expect(result.success).toBe(true);
  });
});
