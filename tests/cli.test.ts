import { describe, it, expect, vi } from 'vitest';
import { buildProgram } from '../src/cli.js';

describe('CLI contract', () => {
  it('exposes the supervisor compatibility contract', async () => {
    const program = buildProgram();
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await program.parseAsync(['node', 'orc', 'supervisor-contract']);
    expect(write).toHaveBeenCalledWith(expect.stringContaining('orc-smash-supervisor-contract'));
    write.mockRestore();
  });

  it('exposes generic binding and runner options without legacy continuity flags', () => {
    const smash = buildProgram().commands.find(command => command.name() === 'smash')!;
    const flags = smash.options.map(option => option.long);
    expect(flags).toEqual(expect.arrayContaining([
      '--loop',
      '--task',
      '--pipeline',
      '--config',
      '--effort',
      '--runner-effort',
    ]));
    expect(flags).not.toContain('--audit-continuity');
    expect(flags).not.toContain('--codex-audit-continuity');
  });
});
