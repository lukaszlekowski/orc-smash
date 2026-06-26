import { describe, it, expect } from 'vitest';
import { stampProvenance, parseProvenance } from '../src/provenance.js';

describe('Provenance stamp and parse', () => {
  it('stamps and parses provenance via HTML comments correctly', () => {
    const comment = stampProvenance('opencode', 'opencode/deepseek-v4-flash', 6);
    expect(comment).toContain('<!-- orc-smash-provenance agent="opencode" model="opencode/deepseek-v4-flash" version="6" -->');

    const fileContent = `Some text here.${comment}`;
    const parsed = parseProvenance(fileContent, 'opencode', 6);
    expect(parsed).toEqual({
      agent: 'opencode',
      model: 'opencode/deepseek-v4-flash',
      version: 6
    });
  });

  it('falls back to Auditor header when comment is missing', () => {
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

  it('falls back to filename agent and version when Auditor header and comment are missing', () => {
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
