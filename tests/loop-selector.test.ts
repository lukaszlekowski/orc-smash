import { describe, it, expect } from 'vitest';
import { selectDefaultLoop } from '../src/loop-selector.js';
import type { LoopSpec } from '../src/manifest.js';

const loop = (target: string): LoopSpec => ({
  type: 'approval-loop',
  target: { path: target, kind: 'file' },
  inputs: [],
  evaluate: {
    skill: 'evaluate-skill',
    output: {
      pattern: `${target}-v{version}-{provider}.md`,
      contract: 'decision-artifact',
      decision: { heading: 'Decision', accepted: 'YES', retry: 'NO' },
    },
  },
  repair: {
    skill: 'repair-skill',
    output: { pattern: `${target}-repair-v{version}-{provider}.md`, contract: 'completion-artifact' },
  },
});

describe('generic loop selection', () => {
  const loops = { quality: loop('quality'), security: loop('security') };

  it('gives an interrupted configured binding precedence', () => {
    expect(selectDefaultLoop('security', loops, { quality: 100, security: 1 })).toBe('security');
  });

  it('selects the configured binding with the newest artifact activity', () => {
    expect(selectDefaultLoop(null, loops, { quality: 100, security: 200 })).toBe('security');
  });

  it('falls back deterministically to the first configured binding', () => {
    expect(selectDefaultLoop(null, loops, { quality: null, security: null })).toBe('quality');
    expect(selectDefaultLoop(null, {}, {})).toBe('');
  });
});
