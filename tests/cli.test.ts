import { describe, it, expect, vi } from 'vitest';
import { buildProgram } from '../src/cli.js';

describe('CLI Commander Option Parsing', () => {
  it('exposes the exact supervisor compatibility contract', async () => {
    const program = buildProgram();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await program.parseAsync(['node', 'orc', 'supervisor-contract']);
      expect(write).toHaveBeenCalledWith(JSON.stringify({
        kind: 'orc-smash-supervisor-contract',
        schemaVersion: 1,
        ownershipSchemaVersion: 1,
        pid: process.pid
      }) + '\n');
    } finally {
      write.mockRestore();
    }
  });

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
