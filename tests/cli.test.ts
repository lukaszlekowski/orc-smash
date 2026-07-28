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
    const program = buildProgram();
    const smash = program.commands.find(command => command.name() === 'smash')!;
    const status = program.commands.find(command => command.name() === 'status')!;
    const flags = smash.options.map(option => option.long);
    expect(flags).toEqual(expect.arrayContaining([
      '--loop',
      '--task',
      '--pipeline',
      '--config',
      '--effort',
      '--runner-effort',
    ]));
    for (const command of [smash, status]) {
      const option = command.options.find(candidate => candidate.long === '--show-fingerprints');
      expect(option).toBeDefined();
      expect(option!.flags).toBe('--show-fingerprints');
      expect(option!.required).toBe(false);
      expect(option!.optional).toBe(false);
      expect(option!.attributeName()).toBe('showFingerprints');
      expect(command.options.find(candidate => candidate.long === '--fingerprints')).toBeUndefined();
      expect(command.options.find(candidate => candidate.short === '-fp')).toBeUndefined();
    }
    expect(smash.options.find(option => option.short === '-p')?.long).toBe('--project');
    expect(status.options.find(option => option.short === '-p')?.long).toBe('--project');
    expect(flags).not.toContain('--audit-continuity');
    expect(flags).not.toContain('--codex-audit-continuity');
  });
});
