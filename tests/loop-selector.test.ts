import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { selectDefaultLoop, bindingHasInProgressChain, bindingHasCompletedAcceptance } from '../src/loop-selector.js';
import { loadConfig } from '../src/config.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';
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

describe('F7 binding state checks', () => {
  const workspace = resolve(process.cwd(), 'temp-loop-selector-state');

  beforeEach(() => {
    createTempDir('temp-loop-selector-state');
    mkdirSync(join(workspace, 'docs/dev'), { recursive: true });
    mkdirSync(join(workspace, 'roles'), { recursive: true });
    mkdirSync(join(workspace, 'skills'), { recursive: true });
    writeFileSync(join(workspace, 'roles/tester.md'), '# Tester\n');
    writeFileSync(join(workspace, 'skills/SKILL.md'), '# Skill\n');
    writeFileSync(join(workspace, '.orc-smash.yaml'), JSON.stringify({
      schemaVersion: 1,
      roles: { tester: 'roles/tester.md' },
      skills: {
        'test-skill': { file: 'skills/SKILL.md', role: 'tester', runnerProfile: 'default' },
      },
      loops: {
        plan: {
          type: 'approval-loop',
          target: { path: 'docs/dev/plan.md', kind: 'file' },
          inputs: [],
          evaluate: { skill: 'test-skill', output: { pattern: 'test-v{version}-{provider}.md', contract: 'decision-artifact', decision: { heading: 'Verdict', accepted: 'YES', retry: 'NO' } } },
          repair: { skill: 'test-skill', output: { pattern: 'test-repair-v{version}-{provider}.md', contract: 'completion-artifact' } },
        },
      },
      tasks: {},
      pipelines: {},
    }));
    writeFileSync(join(workspace, 'docs/dev/plan.md'), '# Plan\n');
  });

  afterEach(() => {
    removeTempDir(workspace);
  });

  it('reports no in-progress chain when no artifacts exist', () => {
    const config = loadConfig(workspace);
    expect(bindingHasInProgressChain(workspace, config.manifest, 'plan')).toBe(false);
  });

  it('reports no completed acceptance when no artifacts exist', () => {
    const config = loadConfig(workspace);
    expect(bindingHasCompletedAcceptance(workspace, config.manifest, 'plan')).toBe(false);
  });
});
