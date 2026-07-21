import { describe, it, expect } from 'vitest';
import {
  writeInterruptedMarker,
  readInterruptedMarker,
  quarantineInterruptedResume,
} from '../src/interrupted-artifact.js';
import { scanGlobalSnapshot } from '../src/artifact-index.js';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
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
});
