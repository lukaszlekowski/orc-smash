import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  writeArtifactWithMeta,
  parseArtifactMeta,
  parseProvenance,
  type ArtifactMeta
} from '../src/provenance.js';

describe('Provenance front-matter and legacy fallback', () => {
  const tempDir = join(process.cwd(), 'temp-provenance-test');
  const tempFile = join(tempDir, 'test-artifact.md');

  beforeEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('performs front-matter round-trip via writeArtifactWithMeta and parseArtifactMeta', () => {
    const meta: ArtifactMeta = {
      loop: 'plan',
      skill: 'plan-audit',
      kind: 'audit',
      role: 'auditor',
      version: 2,
      agent: 'codex',
      model: 'gpt-5-codex',
      target: 'docs/dev/plan.md',
      priorAudit: 'docs/dev/plan-audit-v1-opencode.md',
      timestamp: '2026-06-26T20:11:00.000Z'
    };

    const body = '# Title\nSome content here.';
    writeArtifactWithMeta(tempFile, body, meta);

    const written = readFileSync(tempFile, 'utf-8');
    expect(written.startsWith('---')).toBe(true);
    expect(written).toContain('loop: plan');
    expect(written).toContain('model: gpt-5-codex');

    const parsed = parseArtifactMeta(written, { agent: 'fake-agent', version: 99 });
    expect(parsed).toEqual(meta);

    // Verify atomic write: no temp file is left behind
    const files = require('node:fs').readdirSync(tempDir);
    expect(files).toEqual(['test-artifact.md']);
  });

  it('falls back to HTML comment for historical artifacts in parseProvenance', () => {
    const fileContent = `Some text here.
<!-- orc-smash-provenance agent="opencode" model="opencode-go/deepseek-v4-flash" version="6" -->`;
    const parsed = parseProvenance(fileContent, 'opencode', 6);
    expect(parsed).toEqual({
      agent: 'opencode',
      model: 'opencode-go/deepseek-v4-flash',
      version: 6
    });
  });

  it('falls back to Auditor header when comment is missing in parseProvenance', () => {
    const fileContent = `
# Plan Audit
Auditor: codex-gpt-5
Document: some-doc
    `;
    const parsed = parseProvenance(fileContent, 'codex', 5);
    expect(parsed).toEqual({
      agent: 'codex',
      model: 'gpt-5',
      version: 5
    });
  });

  it('falls back to filename agent and version when Auditor header and comment are missing in parseProvenance', () => {
    const fileContent = `
# Plan Audit
Just some markdown content.
    `;
    const parsed = parseProvenance(fileContent, 'claude', 3);
    expect(parsed).toEqual({
      agent: 'claude',
      model: 'unknown',
      version: 3
    });
  });
});
