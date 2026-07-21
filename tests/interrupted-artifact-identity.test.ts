import { describe, it, expect, afterAll, vi } from 'vitest';
import {
  writeInterruptedMarker,
  readInterruptedMarker,
  quarantineInterruptedResume,
  setStepCtx,
  setActiveProjectRoot,
  clearInterruptState,
} from '../src/interrupted-artifact.js';
import { parseArtifactMetaClassified } from '../src/provenance.js';
import { scanGlobalSnapshot } from '../src/artifact-index.js';
import { writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { V1Manifest } from '../src/manifest.js';

describe('Interrupted Artifact Full R1 Identity (M5 Verification)', () => {
  const testDir = join(process.cwd(), '.test-interrupted-identity');

  it('preserves full R1 identity in interrupted marker and scan', () => {
    rmSync(testDir, { recursive: true, force: true });
    mkdirSync(join(testDir, '.orc-smash'), { recursive: true });
    mkdirSync(join(testDir, 'docs/dev'), { recursive: true });

    const marker = {
      loop: 'plan',
      kind: 'evaluate' as const,
      version: 1,
      agent: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      skillId: 'plan-audit',
      interruptedAtMs: Date.now(),
      effort: 'medium',
      sessionStrategy: 'fresh-per-invocation',
      chainId: 'plan:run1:stage1:chain1',
      pipelineId: 'default',
      pipelineRunId: 'run1',
      stageId: 'plan',
      artifactIdentity: 'identity-12345',
      parentArtifactIdentity: null,
    };

    writeInterruptedMarker(testDir, marker);

    const read = readInterruptedMarker(testDir);
    expect(read).toBeDefined();
    expect(read?.effort).toBe('medium');
    expect(read?.sessionStrategy).toBe('fresh-per-invocation');
    expect(read?.chainId).toBe('plan:run1:stage1:chain1');
    expect(read?.artifactIdentity).toBe('identity-12345');

    // Create partial artifact file
    const partialPath = join(testDir, 'docs/dev/plan-audit-v1-opencode.md');
    writeFileSync(
      partialPath,
      `<!-- orc-smash:v1 kind=evaluate role=auditor version=1 agent=opencode model=opencode-go/deepseek-v4-flash chainId=plan:run1:stage1:chain1 artifactIdentity=identity-12345 effort=medium -->\nPartial output`
    );

    const manifest: V1Manifest = {
      schemaVersion: 1,
      roles: { auditor: 'roles/auditor.md' },
      skills: { 'plan-audit': { file: 'skills/audit.md', role: 'auditor', runnerProfile: 'audit' } },
      loops: {
        plan: {
          type: 'approval-loop',
          target: { path: '.', kind: 'worktree' },
          inputs: [],
          evaluate: {
            skill: 'plan-audit',
            output: { pattern: 'docs/dev/plan-audit-v{version}-{provider}.md', contract: 'decision-artifact', decision: { heading: 'Verdict', accepted: 'APPROVED', retry: 'REJECTED' } },
          },
          repair: {
            skill: 'plan-audit',
            output: { pattern: 'docs/dev/plan-followup-v{version}-{provider}.md', contract: 'completion-artifact' },
          },
        },
      },
      tasks: {},
      pipelines: {},
    };

    const quarantineResult = quarantineInterruptedResume(testDir, manifest.loops);
    expect(quarantineResult.hadMarker).toBe(true);
    expect(quarantineResult.quarantined.length).toBeGreaterThan(0);

    const snapshot = scanGlobalSnapshot(testDir, manifest);
    expect(snapshot.steps.length).toBe(0); // Quarantined file is ignored by active snapshot scan
  });

  it('covers production in-flight signal interruption, marker write, and quarantine stamp', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    
    // Create partial artifact file
    const partialPath = join(testDir, 'docs/dev/plan-audit-v1-opencode.md');
    writeFileSync(partialPath, 'Partially written by provider');
    
    const manifest: V1Manifest = {
      schemaVersion: 1,
      roles: { auditor: 'roles/auditor.md' },
      skills: { 'plan-audit': { file: 'skills/audit.md', role: 'auditor', runnerProfile: 'audit' } },
      loops: {
        plan: {
          type: 'approval-loop',
          target: { path: '.', kind: 'worktree' },
          inputs: [],
          evaluate: {
            skill: 'plan-audit',
            output: { pattern: 'docs/dev/plan-audit-v{version}-{provider}.md', contract: 'decision-artifact', decision: { heading: 'Verdict', accepted: 'APPROVED', retry: 'REJECTED' } },
          },
          repair: {
            skill: 'plan-audit',
            output: { pattern: 'docs/dev/plan-followup-v{version}-{provider}.md', contract: 'completion-artifact' },
          },
        },
      },
      tasks: {},
      pipelines: {},
    };

    const ctx = {
      loop: 'plan',
      kind: 'evaluate' as const,
      version: 1,
      agent: 'opencode',
      model: 'opencode-model',
      skillId: 'plan-audit',
      effort: 'medium',
      sessionStrategy: 'fresh-per-invocation',
      chainId: 'chain-xyz',
      pipelineId: null,
      pipelineRunId: null,
      stageId: null,
      artifactIdentity: 'draft-identity',
      parentArtifactIdentity: null,
      bindingKind: 'loop',
      bindingId: 'plan',
      chainMode: 'ad-hoc' as const,
      inputFingerprint: 'inf-123',
      resultFingerprint: 'res-456',
      sessionMode: 'fresh',
      sessionId: 'sess-abc',
    };

    setStepCtx(ctx);
    setActiveProjectRoot(testDir);

    const { handleInterruptSignal } = await import('../src/interrupted-artifact.js');
    await handleInterruptSignal('SIGINT');

    // 1. Verify marker was written with all fields
    const read = readInterruptedMarker(testDir);
    expect(read).toBeDefined();
    expect(read?.bindingKind).toBe('loop');
    expect(read?.bindingId).toBe('plan');
    expect(read?.chainMode).toBe('ad-hoc');
    expect(read?.inputFingerprint).toBe('inf-123');
    expect(read?.resultFingerprint).toBe('res-456');

    // 2. Run quarantine to archive the partial file and stamp it as interrupted
    const quarantineResult = quarantineInterruptedResume(testDir, manifest.loops);
    expect(quarantineResult.hadMarker).toBe(true);
    expect(quarantineResult.quarantined.length).toBe(1);

    // 3. Verify quarantined file has stamped front-matter with status: interrupted
    const archivedPath = quarantineResult.quarantined[0]!;
    const archivedContent = readFileSync(archivedPath, 'utf-8');
    expect(archivedContent).toContain('status: interrupted');
    expect(archivedContent).toContain('bindingKind: loop');
    expect(archivedContent).toContain('chainId: chain-xyz');

    // 4. Verify parseArtifactMetaClassified parses the archived file as status: interrupted
    const parsed = parseArtifactMetaClassified(archivedContent, { agent: 'opencode', version: 1, kind: 'evaluate' });
    expect(parsed.status).toBe('interrupted');

    exitSpy.mockRestore();
    clearInterruptState();
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });
});
