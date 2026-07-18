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

  it('accepts --audit-continuity as a valid option', () => {
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
    }).not.toThrow();
  });

  it('accepts --codex-audit-continuity as a valid option', () => {
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
    }).not.toThrow();
  });

  it('accepts --runner and --runner-model as repeatable options', () => {
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
        '--loop',
        'plan',
        '--runner',
        'plan-audit=codex',
        '--runner-model',
        'plan-audit=gpt-5.6-terra',
        '--runner',
        'plan-follow-up=claude'
      ]);
    }).not.toThrow();
  });

  it('--runner does not throw at Commander level (semantic validation in smash action)', () => {
    // Commander accepts --runner syntactically; the semantic constraint
    // (requires --loop) is enforced in the smash action handler. This test
    // verifies that Commander parsing itself accepts the option.
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
        '--runner',
        'plan-audit=codex'
      ]);
    }).not.toThrow();
  });
});
