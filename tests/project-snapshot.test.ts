import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildProjectSnapshotView, buildBindingPromptContracts } from '../src/project-snapshot-view.js';
import { renderCompactSnapshot, renderDetailedSnapshot } from '../src/project-snapshot-renderer.js';
import { scanGlobalSnapshot } from '../src/artifact-index.js';
import { loadConfig } from '../src/config.js';
import { resolveDefaultLoop } from '../src/loop-selector.js';
import { writeArtifactWithMeta } from '../src/provenance.js';
import { makeV1ArtifactMeta } from './helpers/v1-artifact.js';
import { writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs';
import fs from 'node:fs';
import { join, resolve } from 'node:path';

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
    expect(detailedText).toContain('Prompt Contracts:');
    expect(detailedText).toContain('Bindings:');
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
    expect(view.suggestedLoopReason).toContain("most recently active loop is 'plan'");
    expect(view.suggestedLoopReason).not.toContain('in-progress chain active');
  });

  it('renders prompt contracts in manifest declaration order even for integer-like IDs (10 then 2)', () => {
    const manifestYaml = `
schemaVersion: 1
roles:
  auditor: roles/auditor.md
skills:
  audit:
    file: skills/audit.md
    role: auditor
    runnerProfile: audit
loops:
  "10":
    type: approval-loop
    target: { path: "docs/dev/plan.md", kind: "file" }
    inputs: [{ source: "target" }]
    evaluate:
      skill: audit
      output:
        pattern: "docs/dev/audit-10-v{version}-{provider}.md"
        contract: decision-artifact
        decision: { heading: Verdict, accepted: APPROVED, retry: REJECTED }
    repair:
      skill: audit
      output:
        pattern: "docs/dev/follow-10-v{version}-{provider}.md"
        contract: completion-artifact
  "2":
    type: approval-loop
    target: { path: "docs/dev/plan.md", kind: "file" }
    inputs: [{ source: "target" }]
    evaluate:
      skill: audit
      output:
        pattern: "docs/dev/audit-2-v{version}-{provider}.md"
        contract: decision-artifact
        decision: { heading: Verdict, accepted: APPROVED, retry: REJECTED }
    repair:
      skill: audit
      output:
        pattern: "docs/dev/follow-2-v{version}-{provider}.md"
        contract: completion-artifact
`;
    mkdirSync(join(testDir, 'roles'), { recursive: true });
    mkdirSync(join(testDir, 'skills'), { recursive: true });
    writeFileSync(join(testDir, '.orc-smash.yaml'), manifestYaml);
    writeFileSync(join(testDir, 'roles/auditor.md'), 'auditor role content');
    writeFileSync(join(testDir, 'skills/audit.md'), 'audit skill content');
    writeFileSync(join(testDir, 'docs/dev/plan.md'), '# Plan');

    const config = loadConfig(testDir);
    const snapshot = scanGlobalSnapshot(testDir, config.manifest);
    const view = buildProjectSnapshotView(config, snapshot);

    expect(view.promptContracts.map(c => c.bindingId)).toEqual(['10', '2']);

    const detailedText = renderDetailedSnapshot(view);
    const pos10 = detailedText.indexOf('[loop] 10');
    const pos2 = detailedText.indexOf('[loop] 2');
    expect(pos10).toBeGreaterThan(-1);
    expect(pos2).toBeGreaterThan(-1);
    expect(pos10).toBeLessThan(pos2);
  });

  it('no content leakage: sentinel strings in role, skill, target, and prior-artifact files are never surfaced in detailed status', () => {
    const ROLE_SENTINEL = 'SECRET_ROLE_CONTENT_12345';
    const SKILL_SENTINEL = 'SECRET_SKILL_CONTENT_67890';
    const TARGET_SENTINEL = 'SECRET_TARGET_CONTENT_ABCDE';

    mkdirSync(join(testDir, 'roles'), { recursive: true });
    mkdirSync(join(testDir, 'skills'), { recursive: true });

    writeFileSync(join(testDir, 'roles/auditor.md'), `Role file with ${ROLE_SENTINEL}`);
    writeFileSync(join(testDir, 'skills/audit.md'), `Skill file with ${SKILL_SENTINEL}`);
    writeFileSync(join(testDir, 'docs/dev/plan.md'), `Target file with ${TARGET_SENTINEL}`);

    const PRIOR_ART_SENTINEL = 'CONFIDENTIAL_PRIOR_ARTIFACT_SENTINEL';
    writeFileSync(resolve(testDir, 'docs/dev/plan-v1-opencode.md'), `# Prior Artifact\n${PRIOR_ART_SENTINEL}`);

    const config = loadConfig(testDir);
    const snapshot = scanGlobalSnapshot(testDir, config.manifest);
    const view = buildProjectSnapshotView(config, snapshot);
    const detailedText = renderDetailedSnapshot(view);

    expect(detailedText).not.toContain(ROLE_SENTINEL);
    expect(detailedText).not.toContain(SKILL_SENTINEL);
    expect(detailedText).not.toContain(TARGET_SENTINEL);
    expect(detailedText).not.toContain(PRIOR_ART_SENTINEL);
  });

  it('full-manifest Prompt Contracts assertion: packaged manifest renders contracts across all configured bindings', () => {
    const config = loadConfig(process.cwd());
    const snapshot = scanGlobalSnapshot(process.cwd(), config.manifest);
    const view = buildProjectSnapshotView(config, snapshot);

    expect(view.promptContracts.length).toBe(3); // plan, review, implement
    const stepCount = view.promptContracts.reduce((sum, b) => sum + b.steps.length, 0);
    expect(stepCount).toBe(5); // plan eval/repair, review eval/repair, implement task

    const text = renderDetailedSnapshot(view);
    expect(text).toContain('Prompt Contracts:');
    expect(text).toContain('Bindings:');
    expect(text).toContain('Target:');
    expect(text).toContain('Result contract: Pattern -> contract -> decision/validator');

    // Structural read order assertion per B4: Prompt Contracts before Bindings with single headers
    const promptContractsIdx = text.indexOf('Prompt Contracts:');
    const bindingsIdx = text.indexOf('Bindings:');
    expect(promptContractsIdx).toBeGreaterThan(-1);
    expect(bindingsIdx).toBeGreaterThan(promptContractsIdx);
    expect(text.indexOf('Prompt Contracts:', promptContractsIdx + 1)).toBe(-1);
    expect(text.indexOf('Bindings:', bindingsIdx + 1)).toBe(-1);

    expect(text).toContain('[loop] plan');
    expect(text).toContain('[loop] review');
    expect(text).toContain('[task] implement');
  });

  it('renders missing file-kind target on Prompt Contracts binding-level Target line with missing annotation and warning accent', () => {
    const config = loadConfig(process.cwd());
    const snapshot = scanGlobalSnapshot(testDir, config.manifest);
    const view = buildProjectSnapshotView(config, snapshot);
    const text = renderDetailedSnapshot(view);

    expect(text).toContain('Target:          docs/dev/plan.md [file: missing target]');
    const planContract = view.promptContracts.find((c) => c.bindingId === 'plan');
    expect(planContract?.targetStatus).toBe('missing');
  });

  it('m1: scoped no-read purity assertion: buildBindingPromptContracts operates purely on in-memory manifest data without reading files', () => {
    const config = loadConfig(process.cwd());
    const snapshot = scanGlobalSnapshot(process.cwd(), config.manifest);

    const spy = vi.spyOn(fs, 'readFileSync');
    spy.mockClear();

    try {
      const contracts = buildBindingPromptContracts(config.manifest, snapshot, config.manifestDeclarationOrder);
      expect(contracts.length).toBeGreaterThan(0);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('m2: explicit B5a/B5b parity assertion: recipe/contract match manifest definitions across all bindings and loops', () => {
    const config = loadConfig(process.cwd());
    const snapshot = scanGlobalSnapshot(process.cwd(), config.manifest);
    const contracts = buildBindingPromptContracts(config.manifest, snapshot, config.manifestDeclarationOrder);

    // 1. Plan loop
    const planBinding = contracts.find(c => c.bindingId === 'plan');
    expect(planBinding).toBeDefined();
    expect(planBinding!.steps.length).toBe(2);

    const planEval = planBinding!.steps.find(s => s.phase === 'evaluate')!;
    expect(planEval.roleId).toBe('auditor');
    expect(planEval.rolePath).toBe(config.manifest.roles[planEval.roleId]);
    expect(planEval.skillId).toBe(config.manifest.loops!.plan.evaluate.skill);
    expect(planEval.skillPath).toBe(config.manifest.skills[planEval.skillId]!.file);
    expect(planEval.outputPattern).toBe(config.manifest.loops!.plan.evaluate.output.pattern);
    expect(planEval.outputContract).toBe(config.manifest.loops!.plan.evaluate.output.contract);
    expect(planEval.decision?.heading).toBe(config.manifest.loops!.plan.evaluate.output.decision!.heading);
    expect(planEval.decision?.accepted).toBe(config.manifest.loops!.plan.evaluate.output.decision!.accepted);
    expect(planEval.decision?.retry).toBe(config.manifest.loops!.plan.evaluate.output.decision!.retry);
    expect(planEval.inputs.map(i => i.source)).toEqual(config.manifest.loops!.plan.inputs.map(i => i.source));

    const planRepair = planBinding!.steps.find(s => s.phase === 'repair')!;
    expect(planRepair.roleId).toBe('planner');
    expect(planRepair.rolePath).toBe(config.manifest.roles[planRepair.roleId]);
    expect(planRepair.skillId).toBe(config.manifest.loops!.plan.repair.skill);
    expect(planRepair.skillPath).toBe(config.manifest.skills[planRepair.skillId]!.file);
    expect(planRepair.outputPattern).toBe(config.manifest.loops!.plan.repair.output.pattern);
    expect(planRepair.outputContract).toBe(config.manifest.loops!.plan.repair.output.contract);

    // 2. Review loop
    const reviewBinding = contracts.find(c => c.bindingId === 'review');
    expect(reviewBinding).toBeDefined();
    expect(reviewBinding!.steps.length).toBe(2);

    const reviewEval = reviewBinding!.steps.find(s => s.phase === 'evaluate')!;
    expect(reviewEval.roleId).toBe('reviewer');
    expect(reviewEval.rolePath).toBe(config.manifest.roles[reviewEval.roleId]);
    expect(reviewEval.skillId).toBe(config.manifest.loops!.review.evaluate.skill);
    expect(reviewEval.skillPath).toBe(config.manifest.skills[reviewEval.skillId]!.file);
    expect(reviewEval.outputPattern).toBe(config.manifest.loops!.review.evaluate.output.pattern);
    expect(reviewEval.outputContract).toBe(config.manifest.loops!.review.evaluate.output.contract);
    expect(reviewEval.decision?.heading).toBe(config.manifest.loops!.review.evaluate.output.decision!.heading);
    expect(reviewEval.decision?.accepted).toBe(config.manifest.loops!.review.evaluate.output.decision!.accepted);
    expect(reviewEval.decision?.retry).toBe(config.manifest.loops!.review.evaluate.output.decision!.retry);

    const reviewRepair = reviewBinding!.steps.find(s => s.phase === 'repair')!;
    expect(reviewRepair.roleId).toBe('implementer');
    expect(reviewRepair.rolePath).toBe(config.manifest.roles[reviewRepair.roleId]);
    expect(reviewRepair.skillId).toBe(config.manifest.loops!.review.repair.skill);
    expect(reviewRepair.skillPath).toBe(config.manifest.skills[reviewRepair.skillId]!.file);
    expect(reviewRepair.outputPattern).toBe(config.manifest.loops!.review.repair.output.pattern);
    expect(reviewRepair.outputContract).toBe(config.manifest.loops!.review.repair.output.contract);

    // 3. Implement task
    const implementBinding = contracts.find(c => c.bindingId === 'implement');
    expect(implementBinding).toBeDefined();
    expect(implementBinding!.steps.length).toBe(1);
    const implTask = implementBinding!.steps[0]!;
    expect(implTask.roleId).toBe('implementer');
    expect(implTask.rolePath).toBe(config.manifest.roles[implTask.roleId]);
    expect(implTask.skillId).toBe(config.manifest.tasks!.implement.skill);
    expect(implTask.skillPath).toBe(config.manifest.skills[implTask.skillId]!.file);
    expect(implTask.outputPattern).toBe(config.manifest.tasks!.implement.output.pattern);
    expect(implTask.outputContract).toBe(config.manifest.tasks!.implement.output.contract);
    expect(implTask.validator).toBe(config.manifest.tasks!.implement.output.validator);
  });
});
