import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initializePlanMetadata } from '../src/plan-metadata.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

describe('plan metadata preflight', () => {
  const root = join(process.cwd(), 'temp-plan-metadata');

  afterEach(() => removeTempDir(root));

  it('migrates a leading legacy status line while preserving the plan body', () => {
    createTempDir('temp-plan-metadata');
    const plan = join(root, 'plan.md');
    writeFileSync(plan, '**Status:** drafted\n\n# Durable plan body\n\nKeep this text.\n');

    expect(initializePlanMetadata(plan)).toEqual(expect.objectContaining({ ok: true }));
    expect(readFileSync(plan, 'utf-8')).toBe('---\nstatus: ready\n---\n# Durable plan body\n\nKeep this text.\n');
  });

  it('fails closed for malformed YAML without changing the plan', () => {
    createTempDir('temp-plan-metadata');
    const plan = join(root, 'plan.md');
    const malformed = '---\nstatus: [ready\n---\n# Plan\n';
    writeFileSync(plan, malformed);

    const result = initializePlanMetadata(plan);
    expect(result.ok).toBe(false);
    expect(readFileSync(plan, 'utf-8')).toBe(malformed);
  });

  it('reports a missing plan without creating one', () => {
    createTempDir('temp-plan-metadata');
    const plan = join(root, 'missing.md');
    expect(initializePlanMetadata(plan)).toEqual(expect.objectContaining({ ok: false }));
    expect(existsSync(plan)).toBe(false);
  });
});
