import { describe, it, expect } from 'vitest';
import { loadManifest, buildManifestSchema } from '../src/manifest.js';
import { DEFAULT_REGISTRY } from '../src/config.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const toolRoot = resolve(__dirname, '..');

describe('Manifest validation', () => {
  it('successfully loads and validates the standard skills.yaml', () => {
    const yamlPath = resolve(toolRoot, 'skills.yaml');
    const manifest = loadManifest(yamlPath, DEFAULT_REGISTRY);
    expect(manifest.roles).toBeDefined();
    expect(manifest.skills).toBeDefined();
    expect(manifest.loops).toBeDefined();

    // Verify loops
    expect(manifest.loops['plan']).toBeDefined();
    expect(manifest.loops['implement']).toBeDefined();

    // Verify properties
    expect(manifest.loops['plan']?.audit).toBe('plan-audit');
    expect(manifest.loops['plan']?.['follow-up']).toBe('plan-follow-up');
    expect(manifest.loops['plan']?.followUpPattern).toBe('docs/dev/plan-followup-v{n}-{agent}.md');
  });

  it('rejects a loop pattern that omits {n} or {agent}', () => {
    const invalidManifest = {
      roles: { auditor: 'roles/auditor.md' },
      skills: {
        'plan-audit': { file: 'skills/SKILL.md', role: 'auditor', kind: 'audit', agent: 'fake', model: 'fake' },
        'plan-follow-up': { file: 'skills/SKILL.md', role: 'auditor', kind: 'follow-up', agent: 'fake', model: 'fake' }
      },
      loops: {
        plan: {
          kind: 'doc-audit',
          target: 'docs/dev/plan.md',
          targetKind: 'file',
          audit: 'plan-audit',
          'follow-up': 'plan-follow-up',
          auditPattern: 'invalid-pattern-without-vars.md',
          followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md',
          inputs: []
        }
      }
    };
    const parsed = buildManifestSchema(DEFAULT_REGISTRY).safeParse(invalidManifest);
    expect(parsed.success).toBe(false);
  });

  it('allows a manifest that defines plan and implement without a review loop (manifest remains generic)', () => {
    const validManifest = {
      roles: { auditor: 'roles/auditor.md', planner: 'roles/planner.md', implementer: 'roles/implementer.md' },
      skills: {
        'plan-audit': { file: 'skills/SKILL.md', role: 'auditor', kind: 'audit', agent: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
        'plan-follow-up': { file: 'skills/SKILL.md', role: 'planner', kind: 'follow-up', agent: 'opencode', model: 'opencode-go/deepseek-v4-flash' },
        '30-simple-implement': { file: 'skills/SKILL.md', role: 'implementer', kind: 'implement', agent: 'opencode', model: 'opencode-go/deepseek-v4-flash' }
      },
      loops: {
        plan: {
          kind: 'doc-audit',
          target: 'docs/dev/plan.md',
          targetKind: 'file',
          audit: 'plan-audit',
          'follow-up': 'plan-follow-up',
          auditPattern: 'docs/dev/plan-audit-v{n}-{agent}.md',
          followUpPattern: 'docs/dev/plan-followup-v{n}-{agent}.md',
          inputs: []
        },
        implement: {
          kind: 'implement',
          target: '.',
          targetKind: 'worktree',
          planPath: 'docs/dev/plan.md',
          implement: '30-simple-implement',
          implementPattern: 'docs/dev/impl-v{n}-{agent}.md',
          inputs: []
        }
      }
    };
    const parsed = buildManifestSchema(DEFAULT_REGISTRY).safeParse(validManifest);
    expect(parsed.success).toBe(true);
  });
});
