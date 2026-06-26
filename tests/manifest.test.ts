import { describe, it, expect } from 'vitest';
import { loadManifest } from '../src/manifest.js';
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
  });
});
