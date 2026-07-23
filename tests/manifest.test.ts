import { describe, it, expect } from 'vitest';
import { loadManifest, buildManifestSchema } from '../src/manifest.js';
import { DEFAULT_REGISTRY } from '../src/config.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(toolRoot, 'config/orc-smash.yaml');

describe('v1 manifest contract', () => {
  it('loads loops, tasks, and the linear pipeline from the packaged manifest', () => {
    const { manifest, declarationOrder } = loadManifest(manifestPath, DEFAULT_REGISTRY);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.loops.plan).toBeDefined();
    expect(manifest.loops.review).toBeDefined();
    expect(manifest.tasks?.implement).toBeDefined();
    expect(manifest.loops.implement).toBeUndefined();
    expect(manifest.pipelines.default?.stages.map(stage => stage.stageId)).toEqual(['plan', 'implement', 'review']);
    expect(manifest.pipelines.default?.stages[1]).toEqual({ stageId: 'implement', task: 'implement' });
    expect((manifest as any).manifestDeclarationOrder).toBeUndefined();
    expect(declarationOrder.loops).toEqual(['plan', 'review']);
    expect(declarationOrder.tasks).toEqual(['implement']);
  });

  it('rejects unsupported schema versions and malformed output patterns', () => {
    const schema = buildManifestSchema(DEFAULT_REGISTRY);
    expect(() => schema.parse({
      schemaVersion: 2,
      roles: {},
      skills: {},
      loops: {},
    })).toThrow();
    expect(() => schema.parse({
      schemaVersion: 1,
      roles: { auditor: 'roles/auditor.md' },
      skills: {
        audit: { file: 'skills/a.md', role: 'auditor', runnerProfile: 'audit' },
      },
      loops: {
        check: {
          type: 'approval-loop',
          target: { path: '.', kind: 'worktree' },
          inputs: [],
          evaluate: {
            skill: 'audit',
            output: {
              pattern: 'docs/out.md',
              contract: 'decision-artifact',
              decision: { heading: 'Decision', accepted: 'PASS', retry: 'FAIL' },
            },
          },
          repair: {
            skill: 'audit',
            output: { pattern: 'docs/out-v{version}-{provider}.md', contract: 'completion-artifact' },
          },
        },
      },
    })).toThrow(/version|provider/i);
  });

  it('rejects duplicate stage ids and accepts reusable bindings across pipelines', () => {
    const parsed = {
      schemaVersion: 1 as const,
      roles: { auditor: 'roles/auditor.md' },
      skills: { audit: { file: 'skills/a.md', role: 'auditor', runnerProfile: 'audit' } },
      loops: {
        check: {
          type: 'approval-loop' as const,
          target: { path: '.', kind: 'worktree' as const },
          inputs: [],
          evaluate: {
            skill: 'audit',
            output: {
              pattern: 'docs/eval-v{version}-{provider}.md',
              contract: 'decision-artifact' as const,
              decision: { heading: 'Decision', accepted: 'PASS', retry: 'FAIL' },
            },
          },
          repair: {
            skill: 'audit',
            output: { pattern: 'docs/repair-v{version}-{provider}.md', contract: 'completion-artifact' as const },
          },
        },
      },
      pipelines: {
        one: { stages: [{ stageId: 'a', loop: 'check' }, { stageId: 'a', loop: 'check' }] },
        two: { stages: [{ stageId: 'a', loop: 'check' }] },
      },
    };
    expect(() => buildManifestSchema(DEFAULT_REGISTRY).parse(parsed)).toThrow(/Duplicate stageId/);
  });

  it('rejects unsafe identifiers and invalid decision tokens', () => {
    const schema = buildManifestSchema(DEFAULT_REGISTRY);
    // Unsafe ID
    expect(() => schema.parse({
      schemaVersion: 1,
      roles: { 'bad role name!': 'roles/auditor.md' },
      skills: {},
      loops: {},
    })).toThrow(/Invalid role ID/);

    // Empty / non-distinct decision tokens
    expect(() => schema.parse({
      schemaVersion: 1,
      roles: { auditor: 'roles/auditor.md' },
      skills: { audit: { file: 'skills/a.md', role: 'auditor', runnerProfile: 'audit' } },
      loops: {
        check: {
          type: 'approval-loop',
          target: { path: '.', kind: 'worktree' },
          inputs: [],
          evaluate: {
            skill: 'audit',
            output: {
              pattern: 'docs/eval-v{version}-{provider}.md',
              contract: 'decision-artifact',
              decision: { heading: 'Decision', accepted: 'SAME', retry: 'same' },
            },
          },
          repair: {
            skill: 'audit',
            output: { pattern: 'docs/repair-v{version}-{provider}.md', contract: 'completion-artifact' },
          },
        },
      },
    })).toThrow(/case-insensitively distinct/);

    // task with decision-artifact contract is rejected
    expect(() => schema.parse({
      schemaVersion: 1,
      roles: { auditor: 'roles/auditor.md' },
      skills: { audit: { file: 'skills/a.md', role: 'auditor', runnerProfile: 'audit' } },
      loops: {},
      tasks: {
        doit: {
          skill: 'audit',
          target: { path: '.', kind: 'worktree' },
          inputs: [],
          output: {
            pattern: 'docs/eval-v{version}-{provider}.md',
            contract: 'decision-artifact',
          },
        },
      },
    })).toThrow();
  });

  it('rejects unreferenced files: keys that are not referenced in inputs', () => {
    const schema = buildManifestSchema(DEFAULT_REGISTRY);
    expect(() => schema.parse({
      schemaVersion: 1,
      roles: { auditor: 'roles/auditor.md' },
      skills: { audit: { file: 'skills/a.md', role: 'auditor', runnerProfile: 'audit' } },
      loops: {
        check: {
          type: 'approval-loop',
          target: { path: '.', kind: 'worktree' },
          inputs: [],
          files: { unreferencedKey: 'docs/some.md' },
          evaluate: {
            skill: 'audit',
            output: {
              pattern: 'docs/eval-v{version}-{provider}.md',
              contract: 'decision-artifact',
              decision: { heading: 'Decision', accepted: 'PASS', retry: 'FAIL' },
            },
          },
          repair: {
            skill: 'audit',
            output: { pattern: 'docs/repair-v{version}-{provider}.md', contract: 'completion-artifact' },
          },
        },
      },
    })).toThrow(/not referenced as a source in inputs/);
  });
});
