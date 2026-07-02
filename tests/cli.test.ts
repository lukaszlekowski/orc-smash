import { describe, it, expect } from 'vitest';
import { buildProgram } from '../src/cli.js';

describe('CLI Commander Option Parsing', () => {
  it('recognizes and parses --codex-audit-continuity flag', () => {
    const program = buildProgram();
    const smashCmd = program.commands.find(c => c.name() === 'smash');
    if (smashCmd) {
      smashCmd.action(() => {});
    }

    // Parse a dummy argument list
    program.parse([
      'node',
      'orc',
      'smash',
      '--project',
      '/tmp/project',
      '--codex-audit-continuity'
    ]);

    expect(smashCmd).toBeDefined();
    if (smashCmd) {
      const opts = smashCmd.opts();
      expect(opts['codexAuditContinuity']).toBe(true);
      expect(opts['project']).toBe('/tmp/project');
    }
  });

  it('defaults --codex-audit-continuity flag to undefined/false when absent', () => {
    const program = buildProgram();
    const smashCmd = program.commands.find(c => c.name() === 'smash');
    if (smashCmd) {
      smashCmd.action(() => {});
    }

    program.parse([
      'node',
      'orc',
      'smash',
      '--project',
      '/tmp/project'
    ]);

    expect(smashCmd).toBeDefined();
    if (smashCmd) {
      const opts = smashCmd.opts();
      expect(opts['codexAuditContinuity']).toBeUndefined();
    }
  });
});
