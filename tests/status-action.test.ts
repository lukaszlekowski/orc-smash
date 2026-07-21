import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { statusAction } from '../src/commands/status.js';
import { loadConfig } from '../src/config.js';
import { writeArtifactWithMeta } from '../src/provenance.js';
import { writeInterruptedMarker } from '../src/interrupted-artifact.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { createMockOutput } from './helpers/mock-output.js';
import { makeV1ArtifactMeta } from './helpers/v1-artifact.js';

describe('generic status snapshot', () => {
  const project = resolve(process.cwd(), 'temp-status-action');
  let panel: any;
  const output = createMockOutput({
    renderPanel: (context: any) => { panel = context; },
  });

  beforeEach(() => {
    createTempDir('temp-status-action');
    mkdirSync(join(project, 'docs/dev'), { recursive: true });
    writeFileSync(join(project, 'docs/dev/plan.md'), '# Plan\n');
    panel = null;
  });

  afterEach(() => removeTempDir(project));

  function writeEvaluation(version: number, token: string) {
    writeArtifactWithMeta(
      join(project, 'docs/dev/plan-audit-v' + version + '-fake.md'),
      '# Evaluation\n\n## Verdict\n\n' + token + '\n',
      makeV1ArtifactMeta({ version, agent: 'fake', provider: 'fake', bindingId: 'plan', kind: 'evaluate' }),
    );
  }

  it('renders a fresh generic evaluation suggestion', async () => {
    const result = await statusAction({ project, output });
    expect(result.exitCode).toBe(0);
    expect(panel.loopName).toBe('plan');
    expect(panel.nextStepMessage).toContain('plan-audit');
    expect(panel.nextStepMessage).toContain('version 1');
    expect(panel.readOnly).toBe(true);
  });

  it('renders retry as repair followed by the next evaluation', async () => {
    writeEvaluation(1, 'REJECTED');
    await statusAction({ project, output });
    expect(panel.nextStepMessage).toContain('plan-follow-up');
    expect(panel.nextStepMessage).toContain('version 2');
  });

  it('renders accepted evaluation as completed without selecting a downstream task', async () => {
    writeEvaluation(1, 'APPROVED');
    await statusAction({ project, output });
    expect(panel.loopName).toBe('plan');
    expect(panel.nextStepMessage).toBe('Completed: accepted at version 1');
  });

  it('shows the global task artifact when --all is selected', async () => {
    const config = loadConfig(project);
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
    expect(panel.loopName).toBe('all');
    expect(panel.timeline.some((step: any) => step.bindingId === 'implement')).toBe(true);
    expect(config.manifest.tasks?.implement).toBeDefined();
  });

  it('gives interrupted markers display-only generic text', async () => {
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
    expect(panel.nextStepMessage).toContain('Binding plan v3 was interrupted');
    expect(panel.timeline.some((step: any) => step.status === 'interrupted')).toBe(true);
  });
});
