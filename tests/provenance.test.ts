import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  writeArtifactWithMeta,
  parseArtifactMeta
} from '../src/provenance.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { makeArtifactMeta } from './helpers/provenance.js';

describe('Provenance front-matter contract', () => {
  const tempDir = join(process.cwd(), 'temp-provenance-test');
  const tempFile = join(tempDir, 'test-artifact.md');

  beforeEach(() => {
    createTempDir('temp-provenance-test');
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('performs front-matter round-trip via writeArtifactWithMeta and parseArtifactMeta', () => {
    const meta = makeArtifactMeta({
      version: 2,
      agent: 'codex',
      model: 'gpt-5-codex',
      priorAudit: 'docs/dev/plan-audit-v1-opencode.md',
      timestamp: '2026-06-26T20:11:00.000Z'
    });

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

  it('round-trips durationMs through front matter (per-step agent runtime)', () => {
    const meta = makeArtifactMeta({ version: 2, agent: 'codex', durationMs: 125000 });
    const body = '# Title\nSome content here.';

    writeArtifactWithMeta(tempFile, body, meta);
    const written = readFileSync(tempFile, 'utf-8');
    expect(written).toContain('durationMs: 125000');

    const parsed = parseArtifactMeta(written, { agent: 'fake', version: 99 });
    expect(parsed.durationMs).toBe(125000);
  });

  it('reports durationMs as undefined when front matter omits it (pre-timing artifacts)', () => {
    const body = [
      '---',
      'loop: plan',
      'skill: plan-audit',
      'kind: audit',
      'role: auditor',
      'version: 1',
      'agent: fake',
      'model: fake-model',
      'target: docs/dev/plan.md',
      'priorAudit: none',
      'timestamp: 2026-06-26T20:00:00.000Z',
      '---',
      '',
      '# Body'
    ].join('\n');

    const parsed = parseArtifactMeta(body, { agent: 'fake', version: 1 });
    expect(parsed.durationMs).toBeUndefined();
  });

  it('round-trips sessionMode and sessionId through front matter', () => {
    const meta = makeArtifactMeta({
      version: 2,
      agent: 'codex',
      sessionMode: 'resumed',
      sessionId: 'sess_abc123'
    });
    const body = '# Title\nSome content.';

    writeArtifactWithMeta(tempFile, body, meta);
    const written = readFileSync(tempFile, 'utf-8');
    expect(written).toContain('sessionMode: resumed');
    expect(written).toContain('sessionId: sess_abc123');

    const parsed = parseArtifactMeta(written, { agent: 'fake', version: 99 });
    expect(parsed.sessionMode).toBe('resumed');
    expect(parsed.sessionId).toBe('sess_abc123');
  });
});
