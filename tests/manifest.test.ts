import { describe, it, expect } from 'vitest';
import { loadManifest, ManifestSchema } from '../src/manifest.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const toolRoot = resolve(__dirname, '..');

describe('Manifest validation', () => {
  it('successfully loads and validates the standard skills.yaml', () => {
    const yamlPath = resolve(toolRoot, 'skills.yaml');
    const manifest = loadManifest(yamlPath);
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
    const parsed = ManifestSchema.safeParse(invalidManifest);
    expect(parsed.success).toBe(false);
  });
});
