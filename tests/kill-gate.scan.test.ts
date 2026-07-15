import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) files.push(...sourceFiles(abs));
    else if (/\.(?:ts|mjs)$/.test(entry)) files.push(abs);
  }
  return files;
}

function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/gs, '');
}

describe('negative-PID signal boundary', () => {
  it('keeps process.kill calls confined to the gate and bootstrap signal re-raise', () => {
    const srcDir = join(process.cwd(), 'src');
    const violations = sourceFiles(srcDir)
      .filter((file) => !file.endsWith('/kill-gate.ts') && !file.endsWith('/process-group-bootstrap.mjs'))
      .filter((file) => /process\.kill\s*\(/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(process.cwd(), file));
    expect(violations).toEqual([]);
  });

  it('never weakens the forbidden-group resolver in a test that can signal', () => {
    const testDir = join(process.cwd(), 'tests');
    const violations = sourceFiles(testDir)
      .filter((file) => {
        const source = withoutComments(readFileSync(file, 'utf8'));
        return source.includes('__setForbiddenPgidResolverForTests') && /process\.kill\s*\(/.test(source);
      })
      .map((file) => relative(process.cwd(), file));
    expect(violations).toEqual([]);
  });

  it('keeps parent cleanup non-signalling for IPC-reported descendants', () => {
    const runtimeTest = readFileSync(
      join(process.cwd(), 'tests/process-group.runtime.test.ts'),
      'utf8'
    );
    expect(runtimeTest).not.toMatch(/process\.kill\s*\(/);
    expect(runtimeTest).not.toContain('signalIfSameIncarnation');
    expect(runtimeTest).not.toContain('cleanupPids');
  });
});
