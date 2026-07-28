import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { runLoop, runTask, type LoopOptions } from '../../src/loop.js';
import { loadConfig, type Config } from '../../src/config.js';
import { fakeAdapterState } from '../../src/adapters/fake.js';
import { createTestAdapterRegistry } from '../../src/adapters/testing.js';
import { createMockOutput } from '../helpers/mock-output.js';
import { allPipelineCandidates, pipelineSuggestions } from '../../src/next-step.js';
import { mintRunContext, type RunContext } from '../../src/pipeline-state.js';
import type { Candidate } from '../../src/pipeline-stage-state.js';
import { buildTaskMenu } from '../../src/stage-menu.js';

const project = resolve(process.cwd(), 'temp-research-first-pipeline');
const output = createMockOutput();

function makeProject(options: { research?: string; plan?: string } = {}): void {
  rmSync(project, { recursive: true, force: true });
  mkdirSync(join(project, 'docs/dev'), { recursive: true });
  if (options.research !== undefined) {
    writeFileSync(join(project, 'docs/dev/research.md'), options.research);
  }
  if (options.plan !== undefined) {
    writeFileSync(join(project, 'docs/dev/plan.md'), options.plan);
  }
}

function runners(): Record<string, { agent: string; model: string }> {
  return {
    'research-audit': { agent: 'fake', model: 'fake-model' },
    'research-follow-up': { agent: 'fake', model: 'fake-model' },
    '23-simple-create-plan': { agent: 'fake', model: 'fake-model' },
    'plan-audit': { agent: 'fake', model: 'fake-model' },
    'plan-follow-up': { agent: 'fake', model: 'fake-model' },
    '30-simple-implement': { agent: 'fake', model: 'fake-model' },
    review: { agent: 'fake', model: 'fake-model' },
    'review-follow-up': { agent: 'fake', model: 'fake-model' },
  };
}

function options(): LoopOptions {
  return {
    maxIterations: 4,
    registry: createTestAdapterRegistry(),
    output,
    interactive: false,
  };
}

function continuation(candidate: Candidate): RunContext {
  return mintRunContext({
    mode: 'stage-continuation',
    pipelineId: candidate.pipelineId,
    pipelineRunId: candidate.pipelineRunId,
    stageId: candidate.successorStageId,
    parentArtifactIdentity: candidate.artifactIdentity,
  });
}

function candidateFor(config: Config, predecessorStageId: string): Candidate {
  const candidate = pipelineSuggestions(project, config.manifest)
    .find(item => item.predecessorStageId === predecessorStageId);
  expect(candidate, `expected eligible candidate after ${predecessorStageId}`).toBeDefined();
  return candidate!;
}

describe('optional research-first pipeline', () => {
  beforeEach(() => {
    makeProject({ research: '# Research\n\nInitial findings.\n' });
  });

  afterEach(() => {
    rmSync(project, { recursive: true, force: true });
  });

  it('runs the five-stage chain with exact predecessor identity at every hop', async () => {
    const config = loadConfig(project);
    fakeAdapterState.verdicts = ['APPROVED', 'APPROVED', 'APPROVED'];

    const research = await runLoop(
      project,
      'research',
      config.manifest.loops.research,
      config,
      runners(),
      { ...options(), runContext: mintRunContext({ mode: 'pipeline-start', pipelineId: 'research-first', stageId: 'research' }) },
    );
    expect(research.success).toBe(true);
    expect(pipelineSuggestions(project, config.manifest)).toHaveLength(1);
    const createPlanCandidate = candidateFor(config, 'research');

    fakeAdapterState.extraWrites = [{
      path: 'docs/dev/plan.md',
      content: '# Generated plan\n\n**Confidence: 0.96**\n',
    }];
    const createPlan = await runTask(
      project,
      'create-plan',
      config.manifest.tasks?.['create-plan']!,
      config,
      runners(),
      { ...options(), runContext: continuation(createPlanCandidate) },
    );
    expect(createPlan.success).toBe(true);
    expect(existsSync(join(project, 'docs/dev/plan.md'))).toBe(true);
    const afterCreatePlan = pipelineSuggestions(project, config.manifest);
    expect(afterCreatePlan).toHaveLength(1);
    expect(afterCreatePlan[0]).toMatchObject({
      predecessorStageId: 'create-plan',
      successorStageId: 'plan',
    });

    const snapshotAfterCreatePlan = (await import('../../src/state.js')).scanGlobalSnapshot(project, config.manifest);
    const researchStep = snapshotAfterCreatePlan.steps.find(step => step.bindingId === 'research' && step.kind === 'evaluate');
    const createPlanStep = snapshotAfterCreatePlan.steps.find(step => step.bindingId === 'create-plan');
    expect(createPlanStep?.parentArtifactIdentity).toBe(researchStep?.artifactIdentity);

    fakeAdapterState.extraWrites = [];
    const planCandidate = candidateFor(config, 'create-plan');
    const plan = await runLoop(
      project,
      'plan',
      config.manifest.loops.plan,
      config,
      runners(),
      { ...options(), runContext: continuation(planCandidate) },
    );
    expect(plan.success).toBe(true);
    const afterPlan = pipelineSuggestions(project, config.manifest);
    expect(afterPlan[0]).toMatchObject({ predecessorStageId: 'plan', successorStageId: 'implement' });
    const snapshotAfterPlan = (await import('../../src/state.js')).scanGlobalSnapshot(project, config.manifest);
    const planStep = snapshotAfterPlan.steps.find(step => step.bindingId === 'plan' && step.kind === 'evaluate');
    expect(planStep?.parentArtifactIdentity).toBe(createPlanStep?.artifactIdentity);

    const implementCandidate = candidateFor(config, 'plan');
    const implementation = await runTask(
      project,
      'implement',
      config.manifest.tasks?.implement!,
      config,
      runners(),
      { ...options(), runContext: continuation(implementCandidate) },
    );
    expect(implementation.success).toBe(true);
    const reviewCandidate = candidateFor(config, 'implement');

    const review = await runLoop(
      project,
      'review',
      config.manifest.loops.review,
      config,
      runners(),
      { ...options(), runContext: continuation(reviewCandidate) },
    );
    expect(review.success).toBe(true);
    expect(pipelineSuggestions(project, config.manifest)).toHaveLength(0);

    const finalSnapshot = (await import('../../src/state.js')).scanGlobalSnapshot(project, config.manifest);
    expect(finalSnapshot.steps.filter(step => step.pipelineId === 'research-first')).toHaveLength(5);
    const reviewStep = finalSnapshot.steps.find(step => step.bindingId === 'review' && step.kind === 'evaluate');
    const implementationStep = finalSnapshot.steps.find(step => step.bindingId === 'implement');
    expect(reviewStep?.parentArtifactIdentity).toBe(implementationStep?.artifactIdentity);
  }, 15_000);

  it('keeps an ad-hoc accepted research loop out of pipeline candidates', async () => {
    const config = loadConfig(project);
    fakeAdapterState.verdicts = ['APPROVED'];
    const result = await runLoop(project, 'research', config.manifest.loops.research, config, runners(), options());
    expect(result.success).toBe(true);
    expect(pipelineSuggestions(project, config.manifest)).toEqual([]);
    const snapshot = (await import('../../src/state.js')).scanGlobalSnapshot(project, config.manifest);
    expect(snapshot.steps.find(step => step.bindingId === 'research')?.pipelineId).toBeNull();
  });

  it('runs the configured research retry and repair phases without downstream effect', async () => {
    const config = loadConfig(project);
    fakeAdapterState.verdicts = ['REJECTED', 'APPROVED'];
    const result = await runLoop(project, 'research', config.manifest.loops.research, config, runners(), options());
    expect(result.success).toBe(true);
    expect(result.lastAuditPath).toContain('research-audit-v2-fake.md');
    expect(existsSync(join(project, 'docs/dev/research-followup-v1-fake.md'))).toBe(true);
    expect(readFileSync(join(project, 'docs/dev/research.md'), 'utf8')).toContain('Patched by follow-up');
    expect(pipelineSuggestions(project, config.manifest)).toEqual([]);
  });

  it('shows create-plan missing researchPath with the standard missing-inputs reason', () => {
    rmSync(join(project, 'docs/dev/research.md'));
    const config = loadConfig(project);
    const menu = buildTaskMenu(
      config.manifest,
      new Map([['create-plan', ['file: researchPath=docs/dev/research.md']]]),
      config.manifestDeclarationOrder.tasks,
    );
    const item = menu.find(task => task.taskId === 'create-plan');
    expect(item).toMatchObject({ availability: 'missing-inputs' });
    expect(item?.disabledReason).toContain('researchPath=docs/dev/research.md');
  });

  it('persists BLOCKED create-plan evidence without creating a plan, consuming the exact predecessor edge and stopping further progression', async () => {
    const config = loadConfig(project);
    fakeAdapterState.verdicts = ['APPROVED'];
    await runLoop(
      project,
      'research',
      config.manifest.loops.research,
      config,
      runners(),
      { ...options(), runContext: mintRunContext({ mode: 'pipeline-start', pipelineId: 'research-first', stageId: 'research' }) },
    );
    const candidate = candidateFor(config, 'research');
    fakeAdapterState.taskOutcome = 'BLOCKED';
    const blocked = await runTask(
      project,
      'create-plan',
      config.manifest.tasks?.['create-plan']!,
      config,
      runners(),
      { ...options(), runContext: continuation(candidate) },
    );
    expect(blocked.success).toBe(false);
    expect(blocked.outcome?.kind).toBe('blocked');
    expect(readFileSync(join(project, 'docs/dev/research.md'), 'utf8')).toContain('Initial findings');
    expect(existsSync(join(project, 'docs/dev/plan.md'))).toBe(false);
    expect(pipelineSuggestions(project, config.manifest)).toEqual([]);
    expect(allPipelineCandidates(project, config.manifest).find(item => item.predecessorStageId === 'research'))
      .toMatchObject({ reason: 'exact-edge-consumed' });
  });

  it('blocks ad-hoc create-plan safely when no accepted research predecessor exists and preserves an existing plan', async () => {
    const existingPlan = '# Existing plan\n\nDo not clobber.\n';
    makeProject({ research: '# Research\n', plan: existingPlan });
    const config = loadConfig(project);
    fakeAdapterState.taskOutcome = 'BLOCKED';
    const result = await runTask(
      project,
      'create-plan',
      config.manifest.tasks?.['create-plan']!,
      config,
      runners(),
      options(),
    );
    expect(result.success).toBe(false);
    expect(result.outcome?.kind).toBe('blocked');
    expect(readFileSync(join(project, 'docs/dev/plan.md'), 'utf8')).toBe(existingPlan);
    expect(pipelineSuggestions(project, config.manifest)).toEqual([]);
  });

  it('starts the unchanged default pipeline without a research artifact or prerequisite', async () => {
    makeProject({ research: '# Optional research\n', plan: '# Existing plan\n' });
    const config = loadConfig(project);
    fakeAdapterState.verdicts = ['APPROVED'];
    const result = await runLoop(
      project,
      'plan',
      config.manifest.loops.plan,
      config,
      runners(),
      { ...options(), runContext: mintRunContext({ mode: 'pipeline-start', pipelineId: 'default', stageId: 'plan' }) },
    );
    expect(result.success).toBe(true);
    const snapshot = (await import('../../src/state.js')).scanGlobalSnapshot(project, config.manifest);
    expect(snapshot.steps.find(step => step.bindingId === 'research')).toBeUndefined();
    expect(pipelineSuggestions(project, config.manifest)).toMatchObject([
      { pipelineId: 'default', predecessorStageId: 'plan', successorStageId: 'implement' },
    ]);
  });

  it('reports research and worktree target drift with typed unavailable reasons', async () => {
    const config = loadConfig(project);
    fakeAdapterState.verdicts = ['APPROVED'];
    await runLoop(
      project,
      'research',
      config.manifest.loops.research,
      config,
      runners(),
      { ...options(), runContext: mintRunContext({ mode: 'pipeline-start', pipelineId: 'research-first', stageId: 'research' }) },
    );
    writeFileSync(join(project, 'docs/dev/research.md'), '# Research\n\nEdited after acceptance.\n');
    expect(allPipelineCandidates(project, config.manifest).find(item => item.predecessorStageId === 'research'))
      .toMatchObject({ reason: 'target-fingerprint-drift' });

    makeProject({ research: '# Research\n' });
    const freshConfig = loadConfig(project);
    fakeAdapterState.verdicts = ['APPROVED'];
    await runLoop(
      project,
      'research',
      freshConfig.manifest.loops.research,
      freshConfig,
      runners(),
      { ...options(), runContext: mintRunContext({ mode: 'pipeline-start', pipelineId: 'research-first', stageId: 'research' }) },
    );
    const createCandidate = candidateFor(freshConfig, 'research');
    fakeAdapterState.extraWrites = [{ path: 'docs/dev/plan.md', content: '# Plan\n' }];
    await runTask(
      project,
      'create-plan',
      freshConfig.manifest.tasks?.['create-plan']!,
      freshConfig,
      runners(),
      { ...options(), runContext: continuation(createCandidate) },
    );
    writeFileSync(join(project, 'docs/dev/plan.md'), '# Plan\n\nEdited after creation.\n');
    expect(allPipelineCandidates(project, freshConfig.manifest).find(item => item.predecessorStageId === 'create-plan'))
      .toMatchObject({ reason: 'target-fingerprint-drift' });
  });

  it('uses renamed binding IDs from an external manifest without name-specific runtime behavior', async () => {
    const manifestRoot = join(project, 'fixture-manifest');
    mkdirSync(join(manifestRoot, 'roles'), { recursive: true });
    mkdirSync(join(manifestRoot, 'skills'), { recursive: true });
    writeFileSync(join(manifestRoot, 'roles/auditor.md'), '# Auditor\n');
    writeFileSync(join(manifestRoot, 'roles/planner.md'), '# Planner\n');
    for (const skill of ['source-check', 'source-repair', 'builder']) {
      writeFileSync(join(manifestRoot, `skills/${skill}.md`), `# ${skill}\n`);
    }
    const manifestPath = join(manifestRoot, 'manifest.yaml');
    writeFileSync(manifestPath, `
schemaVersion: 1
roles:
  auditor: roles/auditor.md
  planner: roles/planner.md
skills:
  source-check: { file: skills/source-check.md, role: auditor, runnerProfile: audit }
  source-repair: { file: skills/source-repair.md, role: planner, runnerProfile: follow-up }
  builder: { file: skills/builder.md, role: planner, runnerProfile: follow-up }
loops:
  source-cycle:
    type: approval-loop
    target: { path: docs/dev/research.md, kind: file }
    inputs: [{ source: target }, { source: version }, { source: priorArtifact }, { source: outputPath }]
    evaluate:
      skill: source-check
      output:
        pattern: docs/dev/source-audit-v{version}-{provider}.md
        contract: decision-artifact
        decision: { heading: Verdict, accepted: PASS, retry: FAIL }
    repair:
      skill: source-repair
      output: { pattern: "docs/dev/source-repair-v{version}-{provider}.md", contract: completion-artifact }
tasks:
  builder-task:
    skill: builder
    target: { path: ., kind: worktree }
    files: { sourceFile: docs/dev/research.md }
    inputs: [{ source: sourceFile }, { source: target }, { source: version }, { source: priorArtifact }, { source: outputPath }]
    output: { pattern: "docs/dev/builder-v{version}-{provider}.md", contract: completion-artifact }
pipelines:
  alternate-flow:
    stages:
      - { stageId: source-stage, loop: source-cycle }
      - { stageId: builder-stage, task: builder-task }
`);
    const config = loadConfig(project, manifestPath);
    const renamedRunners = {
      'source-check': { agent: 'fake', model: 'fake-model' },
      'source-repair': { agent: 'fake', model: 'fake-model' },
      builder: { agent: 'fake', model: 'fake-model' },
    };
    fakeAdapterState.verdicts = ['PASS'];
    const first = await runLoop(
      project,
      'source-cycle',
      config.manifest.loops['source-cycle'],
      config,
      renamedRunners,
      { ...options(), runContext: mintRunContext({ mode: 'pipeline-start', pipelineId: 'alternate-flow', stageId: 'source-stage' }) },
    );
    expect(first.success).toBe(true);
    const candidate = pipelineSuggestions(project, config.manifest)[0]!;
    expect(candidate).toMatchObject({ predecessorStageId: 'source-stage', successorStageId: 'builder-stage' });
    fakeAdapterState.extraWrites = [{ path: 'docs/dev/plan.md', content: '# Renamed flow plan\n' }];
    const second = await runTask(
      project,
      'builder-task',
      config.manifest.tasks?.['builder-task']!,
      config,
      renamedRunners,
      { ...options(), runContext: continuation(candidate) },
    );
    expect(second.success).toBe(true);
    expect(pipelineSuggestions(project, config.manifest)).toEqual([]);
  });

  it('detects an intervening commit as worktree drift for create-plan continuation', async () => {
    execFileSync('git', ['init', '-q'], { cwd: project });
    execFileSync('git', ['config', 'user.email', 'orc-test@example.invalid'], { cwd: project });
    execFileSync('git', ['config', 'user.name', 'orc-test'], { cwd: project });
    execFileSync('git', ['add', 'docs/dev/research.md'], { cwd: project });
    execFileSync('git', ['commit', '-qm', 'initial research'], { cwd: project });
    const config = loadConfig(project);
    fakeAdapterState.verdicts = ['APPROVED'];
    await runLoop(
      project,
      'research',
      config.manifest.loops.research,
      config,
      runners(),
      { ...options(), runContext: mintRunContext({ mode: 'pipeline-start', pipelineId: 'research-first', stageId: 'research' }) },
    );
    const candidate = candidateFor(config, 'research');
    fakeAdapterState.extraWrites = [{ path: 'docs/dev/plan.md', content: '# Plan\n' }];
    await runTask(
      project,
      'create-plan',
      config.manifest.tasks?.['create-plan']!,
      config,
      runners(),
      { ...options(), runContext: continuation(candidate) },
    );
    execFileSync('git', ['add', 'docs/dev/plan.md'], { cwd: project });
    execFileSync('git', ['commit', '-qm', 'record generated plan'], { cwd: project });
    expect(allPipelineCandidates(project, config.manifest).find(item => item.predecessorStageId === 'create-plan'))
      .toMatchObject({ reason: 'target-fingerprint-drift' });
  });
});
