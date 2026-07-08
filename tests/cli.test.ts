import { describe, it, expect } from 'vitest';
import { buildProgram } from '../src/cli.js';

describe('CLI Commander Option Parsing', () => {
  it('rejects --audit-continuity as an unknown option', () => {
    const program = buildProgram();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {}
    });
    program.exitOverride();

    expect(() => {
      program.parse([
        'node',
        'orc',
        'smash',
        '--project',
        '/tmp/project',
        '--audit-continuity'
      ]);
    }).toThrow();
  });

  it('rejects --codex-audit-continuity as an unknown option', () => {
    const program = buildProgram();
    program.configureOutput({
      writeOut: () => {},
      writeErr: () => {}
    });
    program.exitOverride();

    expect(() => {
      program.parse([
        'node',
        'orc',
        'smash',
        '--project',
        '/tmp/project',
        '--codex-audit-continuity'
      ]);
    }).toThrow();
  });
});
