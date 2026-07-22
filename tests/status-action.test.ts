import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { statusAction } from '../src/commands/status.js';
import { writeArtifactWithMeta } from '../src/provenance.js';
import { writeInterruptedMarker } from '../src/interrupted-artifact.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';
import { makeV1ArtifactMeta } from './helpers/v1-artifact.js';
import { captureTargetFingerprint } from '../src/target-snapshot.js';
import { loadConfig } from '../src/config.js';

describe('generic status snapshot', () => {
  const project = resolve(process.cwd(), 'temp-status-action');
  let output: ReturnType<typeof createMockOutput>;

  beforeEach(() => {
    createTempDir('temp-status-action');
    mkdirSync(join(project, 'docs/dev'), { recursive: true });
    writeFileSync(join(project, 'docs/dev/plan.md'), '# Plan\n');
    output = createMockOutput();
  });

  afterEach(() => removeTempDir(project));

  function writeEvaluation(version: number, token: string) {
    writeArtifactWithMeta(
      join(project, 'docs/dev/plan-audit-v' + version + '-fake.md'),
      '# Evaluation\n\n## Verdict\n\n' + token + '\n',
      makeV1ArtifactMeta({ version, agent: 'fake', provider: 'fake', bindingId: 'plan', kind: 'evaluate' }),
    );
  }

  it('renders a fresh generic evaluation snapshot', async () => {
    const result = await statusAction({ project, output });
    expect(result.exitCode).toBe(0);
    expect(output.lastStaticText).toContain('Project Snapshot');
    expect(output.lastStaticText).toContain('Suggested loop: plan');
  });

  it('renders retry evaluation artifact in binding summary', async () => {
    writeEvaluation(1, 'REJECTED');
    await statusAction({ project, output });
    expect(output.lastStaticText).toContain('Latest evaluate: evaluate v1 (retry)');
  });

  it('renders accepted evaluation artifact in binding summary', async () => {
    writeEvaluation(1, 'APPROVED');
    await statusAction({ project, output });
    expect(output.lastStaticText).toContain('Latest evaluate: evaluate v1 (accepted)');
  });

  it('shows tasks and loops in the detailed snapshot', async () => {
    writeArtifactWithMeta(
      join(project, 'docs/dev/impl-v1-fake.md'),
      '# Ledger\n',
      makeV1ArtifactMeta({
        bindingId: 'implement',
        bindingKind: 'task',
        kind: 'task',
        skill: '30-simple-implement',
        role: 'implementer',
        target: '.',
      }),
    );
    await statusAction({ project, output, all: true });
    expect(output.lastStaticText).toContain('[task] implement');
    expect(output.lastStaticText).toContain('Unclassified count: 0');
  });

  it('renders interrupted marker in detailed snapshot', async () => {
    writeInterruptedMarker(project, {
      loop: 'plan',
      kind: 'evaluate',
      version: 3,
      agent: 'fake',
      model: 'fake-model',
      skillId: 'plan-audit',
      interruptedAtMs: 123,
    });
    await statusAction({ project, output });
    expect(output.lastStaticText).toContain('Interrupted Run:');
    expect(output.lastStaticText).toContain('Binding: plan');
  });

  it('renders pipeline suggestions with full evidence when stage is completed', async () => {
    const planPath = join(project, 'docs/dev/plan.md');
    writeFileSync(planPath, '# Plan\n');
    const config = loadConfig(project);
    const fingerprint = captureTargetFingerprint(project, config.manifest.loops.plan!.target, config.manifest);

    const meta = makeV1ArtifactMeta({
      version: 1,
      agent: 'fake',
      provider: 'fake',
      bindingId: 'plan',
      bindingKind: 'loop',
      kind: 'evaluate',
      pipelineId: 'default',
      pipelineRunId: 'test-run-123',
      stageId: 'plan',
      chainId: 'c1',
      chainMode: 'pipeline-start',
      resultFingerprint: fingerprint,
    });

    writeArtifactWithMeta(
      join(project, 'docs/dev/plan-audit-v1-fake.md'),
      '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
      meta,
    );

    await statusAction({ project, output });
    expect(output.lastStaticText).toContain('Pipeline Suggestions');
    expect(output.lastStaticText).toContain('plan -> implement');
    expect(output.lastStaticText).toContain('Artifact identity:');
    expect(output.lastStaticText).toContain('Decision/Outcome: accepted');
    expect(output.lastStaticText).toContain('Fingerprint: valid (' + fingerprint + ')');
  });

  it('renders stale pipeline suggestions with drift explanation when target is modified', async () => {
    const planPath = join(project, 'docs/dev/plan.md');
    writeFileSync(planPath, '# Plan\n');

    const meta = makeV1ArtifactMeta({
      version: 1,
      agent: 'fake',
      provider: 'fake',
      bindingId: 'plan',
      bindingKind: 'loop',
      kind: 'evaluate',
      pipelineId: 'default',
      pipelineRunId: 'test-run-123',
      stageId: 'plan',
      chainId: 'c1',
      chainMode: 'pipeline-start',
      resultFingerprint: 'some-stale-hash-123',
    });

    writeArtifactWithMeta(
      join(project, 'docs/dev/plan-audit-v1-fake.md'),
      '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
      meta,
    );

    await statusAction({ project, output });
    expect(output.lastStaticText).toContain('Pipeline Suggestions (Eligible: 0, Total: 1)');
    expect(output.lastStaticText).toContain('stale');
    expect(output.lastStaticText).toContain('Fingerprint: drift (recorded some-stale-hash-123 vs current');
  });

  it('renders concurrently eligible runs in stable order', async () => {
    const planPath = join(project, 'docs/dev/plan.md');
    writeFileSync(planPath, '# Plan\n');
    const config = loadConfig(project);
    const fingerprint = captureTargetFingerprint(project, config.manifest.loops.plan!.target, config.manifest);

    writeArtifactWithMeta(
      join(project, 'docs/dev/plan-audit-v1-fake.md'),
      '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
      makeV1ArtifactMeta({
        version: 1,
        agent: 'fake',
        provider: 'fake',
        bindingId: 'plan',
        bindingKind: 'loop',
        kind: 'evaluate',
        pipelineId: 'default',
        pipelineRunId: 'run-AAA',
        stageId: 'plan',
        chainId: 'c-AAA',
        chainMode: 'pipeline-start',
        resultFingerprint: fingerprint,
      }),
    );

    writeArtifactWithMeta(
      join(project, 'docs/dev/plan-audit-v2-fake.md'),
      '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
      makeV1ArtifactMeta({
        version: 2,
        agent: 'fake',
        provider: 'fake',
        bindingId: 'plan',
        bindingKind: 'loop',
        kind: 'evaluate',
        pipelineId: 'default',
        pipelineRunId: 'run-BBB',
        stageId: 'plan',
        chainId: 'c-BBB',
        chainMode: 'pipeline-start',
        resultFingerprint: fingerprint,
      }),
    );

    await statusAction({ project, output });
    const text = output.lastStaticText!;
    expect(text).toContain('run-AAA');
    expect(text).toContain('run-BBB');
    expect(text.indexOf('run-AAA')).toBeLessThan(text.indexOf('run-BBB'));
  });
});
