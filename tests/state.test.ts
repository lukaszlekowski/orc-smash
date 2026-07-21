import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config.js';
import { scanAllForStatus, scanGlobalSnapshot } from '../src/state.js';
import { writeArtifactWithMeta } from '../src/provenance.js';
import { writeInterruptedMarker } from '../src/interrupted-artifact.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { makeV1ArtifactMeta } from './helpers/v1-artifact.js';

describe('generic artifact index', () => {
  const project = resolve(process.cwd(), 'temp-state-test');

  beforeEach(() => {
    createTempDir('temp-state-test');
    mkdirSync(join(project, 'docs/dev'), { recursive: true });
    writeFileSync(join(project, 'docs/dev/plan.md'), '# Plan\n');
  });

  afterEach(() => removeTempDir(project));

  function writeArtifact(path: string, body: string, meta: Parameters<typeof writeArtifactWithMeta>[2]) {
    writeArtifactWithMeta(join(project, path), body, meta);
  }

  it('indexes loop and task artifacts by configured binding and canonical contract state', () => {
    const config = loadConfig(project);
    writeArtifact(
      'docs/dev/plan-audit-v1-fake.md',
      '# Evaluation\n\n## Verdict\n\nREJECTED\n',
      makeV1ArtifactMeta({ bindingId: 'plan', kind: 'evaluate', version: 1 }),
    );
    writeArtifact(
      'docs/dev/plan-followup-v1-fake.md',
      '# Repair\n\n## Outcome\n\nCOMPLETED\n',
      makeV1ArtifactMeta({ bindingId: 'plan', kind: 'repair', version: 1, parentArtifactIdentity: 'artifact-plan-1-fake' }),
    );

    const snapshot = scanGlobalSnapshot(project, config.manifest);
    const plan = snapshot.byBinding.get('plan')!;
    expect(plan).toHaveLength(2);
    expect(plan.find(step => step.kind === 'evaluate')?.decision).toBe('retry');
    expect(plan.find(step => step.kind === 'repair')?.completionOutcome).toBe('completed');
    expect(snapshot.unclassified).toHaveLength(0);
  });

  it('retains legacy-shaped matching files as unclassified without completion evidence', () => {
    const config = loadConfig(project);
    writeFileSync(
      join(project, 'docs/dev/plan-audit-v1-fake.md'),
      '---\nloop: plan\nkind: audit\nversion: 1\n---\n\n## Verdict\n\nAPPROVED\n',
    );
    const snapshot = scanGlobalSnapshot(project, config.manifest);
    expect(snapshot.unclassified).toHaveLength(1);
    expect(snapshot.unclassified[0]!.unclassified).toBe(true);
    expect(snapshot.unclassified[0]!.contractValid).toBe(false);
    expect(snapshot.unclassified[0]!.decision).toBeUndefined();
  });

  it('scans all configured outputs once and ignores archived artifacts', () => {
    const config = loadConfig(project);
    mkdirSync(join(project, 'docs/dev/archived'), { recursive: true });
    writeFileSync(join(project, 'docs/dev/archived/plan-audit-v9-fake.md'), 'legacy');
    writeArtifact(
      'docs/dev/impl-v1-fake.md',
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
    const snapshot = scanGlobalSnapshot(project, config.manifest);
    expect(snapshot.byBinding.has('implement')).toBe(true);
    expect(snapshot.steps.some(step => step.artifactPath.includes('/archived/'))).toBe(false);
  });

  it('synthesizes an interrupted display row only in the status view', () => {
    const config = loadConfig(project);
    writeInterruptedMarker(project, {
      loop: 'plan',
      kind: 'evaluate',
      version: 2,
      agent: 'fake',
      model: 'fake-model',
      skillId: 'plan-audit',
      interruptedAtMs: 123,
    });
    const status = scanAllForStatus(project, config.manifest);
    expect(status.interruptedStep?.status).toBe('interrupted');
    expect(status.timeline.some(step => step.status === 'interrupted')).toBe(true);
    expect(status.timeline.some(step => step.kind === 'evaluate')).toBe(true);
  });
});
