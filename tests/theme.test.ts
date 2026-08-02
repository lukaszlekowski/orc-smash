import { describe, expect, it, afterEach } from 'vitest';
import chalk from 'chalk';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadTheme, Theme } from '../src/theme.js';

const fixtureDirs: string[] = [];

function fixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'orc-theme-'));
  fixtureDirs.push(dir);
  const path = join(dir, 'theme.yaml');
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  for (const path of fixtureDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

function basicTheme(statusOverride = ''): string {
  const statusLines = statusOverride ? ['status-panel:', statusOverride] : ['status-panel: {}'];
  return [
    'colors:',
    '  custom: magenta',
    'defaults:',
    '  role.auditor: { fg: cyan }',
    '  role.implementer: { fg: custom, bg: green, bold: true }',
    '  emphasis.identity: { fg: cyan, bold: true }',
    '  panel.dim_row: {}',
    '  panel.border.default: { fg: cyan }',
    '  panel.border.failed: { fg: red }',
    '  panel.border.audit: { fg: cyan }',
    ...statusLines,
    'terminal-accent: {}',
    'plain-timeline: {}',
    'log: {}',
  ].join('\n');
}

function withLevel<T>(level: 0 | 1 | 2 | 3, fn: () => T): T {
  const previous = chalk.level;
  chalk.level = level;
  try {
    return fn();
  } finally {
    chalk.level = previous;
  }
}

describe('theme loading and resolution', () => {
  it('builds isolated instances and location overrides win over defaults', () => {
    const first = loadTheme(fixture(basicTheme('  role.auditor: { fg: red }')));
    const second = loadTheme(fixture(basicTheme('  role.auditor: { fg: blue }')));

    expect(first).toBeInstanceOf(Theme);
    expect(withLevel(1, () => first.resolveStyle('role.auditor', 'status-panel')('x')))
      .toBe('\u001B[31mx\u001B[39m');
    expect(withLevel(1, () => second.resolveStyle('role.auditor', 'status-panel')('x')))
      .toBe('\u001B[34mx\u001B[39m');
    expect(withLevel(1, () => first.resolveStyle('role.auditor', 'log')('x')))
      .toBe('\u001B[36mx\u001B[39m');
  });

  it('resolves named, composed, background, hex, and empty specs', () => {
    const theme = loadTheme(fixture(basicTheme()));
    expect(withLevel(1, () => theme.resolveStyle('role.auditor')('x')))
      .toBe('\u001B[36mx\u001B[39m');
    expect(withLevel(1, () => theme.resolveStyle('emphasis.identity')('x')))
      .toBe('\u001B[1m\u001B[36mx\u001B[39m\u001B[22m');
    expect(withLevel(1, () => theme.resolveStyle('panel.dim_row')('x')))
      .toBe('x');

    const rich = loadTheme(fixture([
      'defaults:',
      "  role.auditor: { fg: '#ff8c42' }",
      '  role.implementer: { fg: black, bg: green, bold: true }',
      "  panel.border.default: { fg: '#ff8c42' }",
      'status-panel: {}',
    ].join('\n')));
    expect(withLevel(3, () => rich.resolveStyle('role.auditor')('x')))
      .toBe('\u001B[38;2;255;140;66mx\u001B[39m');
    expect(withLevel(3, () => rich.resolveStyle('role.implementer')('x')))
      .toBe('\u001B[1m\u001B[42m\u001B[30mx\u001B[39m\u001B[49m\u001B[22m');
    expect(rich.resolveBorderColor({ inFlight: null, timeline: [] } as never)).toBe('#ff8c42');
  });

  it('returns identity at chalk level 0 and responds correctly after a level change', () => {
    const theme = loadTheme(fixture(basicTheme()));
    expect(withLevel(0, () => theme.resolveStyle('role.auditor')('x'))).toBe('x');
    expect(withLevel(1, () => theme.resolveStyle('role.auditor')('x')))
      .toBe('\u001B[36mx\u001B[39m');
  });

  it('rejects unknown tokens, colors, malformed files, and unknown root keys', () => {
    expect(() => loadTheme(fixture(basicTheme().replace('  panel.dim_row: {}', '  status.unclassified: { fg: cyan }'))))
      .toThrow(/Unknown theme token/);
    expect(() => loadTheme(fixture(basicTheme().replace('  role.auditor: { fg: cyan }', '  role.auditor: { fg: not-a-color }'))))
      .toThrow(/Unknown color/);
    expect(() => loadTheme(fixture(basicTheme() + '\nextra: { nope: true }'))).toThrow();
    expect(() => loadTheme(fixture('defaults: null'))).toThrow();
  });
});
