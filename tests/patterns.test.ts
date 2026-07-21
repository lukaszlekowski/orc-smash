import { describe, it, expect } from 'vitest';
import { renderPattern, patternToRegex } from '../src/patterns.js';

describe('artifact path patterns', () => {
  const auditPattern = 'docs/dev/plan-audit-v{version}-{provider}.md';
  const followUpPattern = 'docs/dev/plan-followup-v{version}-{provider}.md';

  it('renders the audit pattern with version + agent', () => {
    expect(renderPattern(auditPattern, { version: 3, provider: 'opencode' }))
      .toBe('docs/dev/plan-audit-v3-opencode.md');
  });

  it('renders the follow-up pattern with version + agent', () => {
    expect(renderPattern(followUpPattern, { version: 2, provider: 'claude' }))
      .toBe('docs/dev/plan-followup-v2-claude.md');
  });

  it('render -> parse round-trips for the audit pattern', () => {
    const path = renderPattern(auditPattern, { version: 7, provider: 'codex' });
    const m = path.match(patternToRegex(auditPattern));
    expect(m).not.toBeNull();
    expect(m![1]).toBe('7');
    expect(m![2]).toBe('codex');
  });

  it('render -> parse round-trips for the follow-up pattern', () => {
    const path = renderPattern(followUpPattern, { version: 1, provider: 'fake' });
    const m = path.match(patternToRegex(followUpPattern));
    expect(m).not.toBeNull();
    expect(m![1]).toBe('1');
    expect(m![2]).toBe('fake');
  });

  it('matches agents composed of letters, digits, underscores, and dashes', () => {
    const regex = patternToRegex(auditPattern);
    expect('docs/dev/plan-audit-v1-agent_name-2.md'.match(regex)).not.toBeNull();
    expect('docs/dev/plan-audit-v1-agent.name.md'.match(regex)).toBeNull();
    expect('docs/dev/plan-audit-vX-opencode.md'.match(regex)).toBeNull();
  });

  it('rejects paths that do not fully match the pattern (anchored)', () => {
    const regex = patternToRegex(auditPattern);
    expect('extra/docs/dev/plan-audit-v1-opencode.md'.match(regex)).toBeNull();
    expect('docs/dev/plan-audit-v1-opencode.md.bak'.match(regex)).toBeNull();
  });
});
