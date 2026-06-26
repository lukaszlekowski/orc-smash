import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claudeAdapter } from '../src/adapters/claude.js';

describe('smoke sign-off record', () => {
  const signOffPath = join(process.cwd(), 'docs/dev/smoke-sign-off.md');

  it('describes the exact claude command produced by claudeAdapter.buildRun()', () => {
    const signOff = readFileSync(signOffPath, 'utf-8');
    const model = 'claude-sonnet-4-6';
    const build = claudeAdapter.buildRun({
      prompt: '<prompt>',
      model,
      cwd: '<cwd>'
    });
    const expectedCommand = `\`${build.command} ${build.args.join(' ')}\``;
    expect(signOff).toContain(expectedCommand);
  });

  it('does not describe a claude invocation using --print (drift guard)', () => {
    const signOff = readFileSync(signOffPath, 'utf-8');
    expect(signOff).not.toMatch(/`claude -p[^`]*--print/);
  });
});
