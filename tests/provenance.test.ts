import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, existsSync, rmSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  writeArtifactWithMeta,
  parseArtifactMeta,
  type ArtifactMeta
} from '../src/provenance.js';

describe('Provenance front-matter contract', () => {
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

  it('uses only the caller fallback values when front matter is absent', () => {
    const body = `# Plan Audit\n\n## Verdict\n\nAPPROVED\n`;
    const parsed = parseArtifactMeta(body, { agent: 'claude', version: 3, kind: 'audit' });
    expect(parsed).toEqual({
      loop: 'unknown',
      skill: 'unknown',
      kind: 'audit',
      role: 'unknown',
      version: 3,
      agent: 'claude',
      model: 'unknown',
      target: 'unknown',
      priorAudit: 'none',
      timestamp: ''
    });
  });

  it('does NOT infer metadata from legacy prose (HTML comment / Auditor header removed)', () => {
    // A historical artifact carrying an HTML-comment provenance stamp and an
    // `Auditor:` header must NOT have that prose parsed as metadata anymore.
    const body = `Some text here.
<!-- orc-smash-provenance agent="opencode" model="opencode-go/deepseek-v4-flash" version="6" -->

# Plan Audit
Auditor: codex-gpt-5
`;
    const parsed = parseArtifactMeta(body, { agent: 'claude', version: 3, kind: 'audit' });
    // Only the caller fallback values survive; prose is never inferred.
    expect(parsed.agent).toBe('claude');
    expect(parsed.version).toBe(3);
    expect(parsed.model).toBe('unknown');
  });
});
