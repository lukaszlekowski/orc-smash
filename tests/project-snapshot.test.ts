import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildProjectSnapshotView } from '../src/project-snapshot-view.js';
import { renderCompactSnapshot, renderDetailedSnapshot } from '../src/project-snapshot-renderer.js';
import { scanGlobalSnapshot } from '../src/artifact-index.js';
import { loadConfig } from '../src/config.js';
import { resolveDefaultLoop } from '../src/loop-selector.js';
import { writeArtifactWithMeta } from '../src/provenance.js';
import { makeV1ArtifactMeta } from './helpers/v1-artifact.js';
import { writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';

describe('Project Snapshot View and Renderer (Slice 3)', () => {
  const testDir = join(process.cwd(), '.test-snapshot-temp');

  beforeEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(testDir, { recursive: true });
    mkdirSync(join(testDir, 'docs/dev'), { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('builds and renders a compact and detailed snapshot from config and snapshot', () => {
    const config = loadConfig(testDir);
    const snapshot = scanGlobalSnapshot(testDir, config.manifest);
    const view = buildProjectSnapshotView(config, snapshot, '2026-07-22T18:00:00.000Z');

    expect(view.projectRoot).toBe(config.projectRoot);
    expect(view.configPath).toBe(config.manifestPath);
    expect(view.suggestedLoop).toBe('plan');
    expect(view.suggestedLoopReason).toContain('no valid in-progress loop');

    const compactText = renderCompactSnapshot(view);
    expect(compactText).toContain('Project:');
    expect(compactText).toContain('Config:');
    expect(compactText).toContain('Suggested loop: plan');
    expect(compactText).toContain('Bindings:');
    expect(compactText).toContain('[loop] plan');
    expect(compactText).toContain('evaluate: (none)');

    const detailedText = renderDetailedSnapshot(view);
    expect(detailedText).toContain('Project Snapshot');
    expect(detailedText).toContain('Configured Bindings:');
    expect(detailedText).toContain('Unclassified Artifacts (0):');
  });

  it('renders per-phase latest evaluate and repair steps with full provenance in compact and detailed views', () => {
    writeFileSync(join(testDir, 'docs/dev/plan.md'), '# Plan\n');
    const evalPath = join(testDir, 'docs/dev/plan-audit-v1-opencode.md');
    const evalMeta = makeV1ArtifactMeta({
      version: 1,
      provider: 'opencode',
      agent: 'opencode',
      model: 'opencode-model',
      effort: 'high',
      sessionStrategy: 'fresh-per-invocation',
      sessionMode: 'fresh',
      sessionId: 'sess-eval-123',
      bindingId: 'plan',
      kind: 'evaluate',
      step: 'evaluate',
      parentArtifactIdentity: null,
    });
    writeArtifactWithMeta(evalPath, '# Evaluation\n\n## Verdict\n\nREJECTED\n', evalMeta);
    utimesSync(evalPath, new Date(1000000000000), new Date(1000000000000));

    const repPath = join(testDir, 'docs/dev/plan-followup-v1-codex.md');
    const repMeta = makeV1ArtifactMeta({
      version: 1,
      provider: 'codex',
      agent: 'codex',
      model: 'codex-model',
      effort: 'provider default',
      sessionStrategy: 'resume-per-skill',
      sessionMode: 'resumed',
      sessionId: 'sess-rep-456',
      bindingId: 'plan',
      kind: 'repair',
      step: 'repair',
      chainId: evalMeta.chainId,
      chainMode: 'ad-hoc',
      parentArtifactIdentity: evalMeta.artifactIdentity,
    });
    writeArtifactWithMeta(repPath, '# Followup\n\n## Outcome\n\nCOMPLETED\n', repMeta);
    utimesSync(repPath, new Date(2000000000000), new Date(2000000000000));

    const config = loadConfig(testDir);
    const snapshot = scanGlobalSnapshot(testDir, config.manifest);
    const view = buildProjectSnapshotView(config, snapshot, '2026-07-22T18:00:00.000Z');

    const compactText = renderCompactSnapshot(view);
    expect(compactText).toContain('evaluate: plan-audit-v1-opencode.md (retry) [opencode / opencode-model, effort: high, session: fresh-per-invocation / fresh (sess-eval-123)]');
    expect(compactText).toContain('repair: plan-followup-v1-codex.md (completed) [codex / codex-model, effort: provider default, session: resume-per-skill / resumed (sess-rep-456)]');
    expect(compactText).toContain('unclassified count: 0');

    const detailedText = renderDetailedSnapshot(view);
    expect(detailedText).toContain('Configured Pipelines:');
    expect(detailedText).toContain("- Pipeline 'default': plan (plan) -> implement (implement) -> review (review)");
    expect(detailedText).toContain('Latest evaluate: evaluate v1 (retry) [opencode / opencode-model, effort: high, session: fresh-per-invocation / fresh (sess-eval-123)]');
    expect(detailedText).toContain('Latest repair: repair v1 (completed) [codex / codex-model, effort: provider default, session: resume-per-skill / resumed (sess-rep-456)]');
  });

  it('surfaces unclassified steps and their cause-specific unclassifiedReason in detailed view', () => {
    // Write an unclassified artifact
    const unclassContent = '---\nloop: plan\nversion: 1\n---\nInvalid content without identity\n';
    const filePath = join(testDir, 'docs/dev/plan-audit-v1-fake.md');
    writeFileSync(filePath, unclassContent);

    const config = loadConfig(testDir);
    const snapshot = scanGlobalSnapshot(testDir, config.manifest);
    const view = buildProjectSnapshotView(config, snapshot, '2026-07-22T18:00:00.000Z');

    expect(view.unclassifiedCount).toBe(1);
    expect(view.unclassifiedSteps[0]!.unclassifiedReason).toContain('Missing required identity fields:');
    expect(view.suggestedLoopReason).toContain('(unclassified evidence only)');

    const detailedText = renderDetailedSnapshot(view);
    expect(detailedText).toContain('Unclassified Artifacts (1):');
    expect(detailedText).toContain('Reason: Missing required identity fields:');
  });

  it('suggested loop parity: matches resolveDefaultLoop when accepted mtime exceeds in-progress mtime', () => {
    const planPath = join(testDir, 'docs/dev/plan-audit-v1-fake.md');
    writeArtifactWithMeta(
      planPath,
      '# Evaluation\n\n## Verdict\n\nAPPROVED\n',
      makeV1ArtifactMeta({
        version: 1,
        agent: 'fake',
        provider: 'fake',
        bindingId: 'plan',
        kind: 'evaluate',
      }),
    );
    // Set plan mtime to newer timestamp (e.g. 2000000000)
    utimesSync(planPath, new Date(2000000000000), new Date(2000000000000));

    const reviewPath = join(testDir, 'docs/dev/review-v1-fake.md');
    writeArtifactWithMeta(
      reviewPath,
      '# Evaluation\n\n## Verdict\n\nREJECTED\n',
      makeV1ArtifactMeta({
        version: 1,
        agent: 'fake',
        provider: 'fake',
        bindingId: 'review',
        kind: 'evaluate',
      }),
    );
    // Set review mtime to older timestamp (e.g. 1000000000)
    utimesSync(reviewPath, new Date(1000000000000), new Date(1000000000000));

    const config = loadConfig(testDir);
    const snapshot = scanGlobalSnapshot(testDir, config.manifest);
    const view = buildProjectSnapshotView(config, snapshot);
    const expectedLoop = resolveDefaultLoop(testDir, config.manifest).loopName;

    expect(view.suggestedLoop).toBe(expectedLoop);
    expect(view.suggestedLoop).toBe('plan');
    expect(view.suggestedLoopReason).toContain("most recently active loop is 'plan'");
    expect(view.suggestedLoopReason).not.toContain('in-progress chain active');
  });
});
