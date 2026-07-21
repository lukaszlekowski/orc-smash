import { describe, it, expect } from 'vitest';
import { createTempDir, removeTempDir } from './helpers/fs.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { resolveRunner } from '../src/runner.js';
import { createTestConfig } from './helpers/test-config.js';

describe('per-skill runner resolution in configured bindings', () => {
  it('resolves the evaluate and repair profiles independently', () => {
    const config = createTestConfig({
      profiles: {
        audit: { provider: 'fake', model: 'fake-model' },
        'follow-up': { provider: 'opencode' },
      },
    });
    config.registry.providers.fake!.efforts = ['low', 'medium'];
    config.registry.providers.fake!.defaultEffort = 'medium';

    const evaluate = resolveRunner('plan-audit', config, {});
    const repair = resolveRunner('plan-follow-up', config, {});
    expect(evaluate.agent).toBe('fake');
    expect(repair.agent).toBe('opencode');
    expect(evaluate.model).toBe('fake-model');
    expect(repair.model).toBe(config.registry.providers.opencode!.defaultModel);
  });

  it('loads the v1 manifest without creating a synthetic task loop', () => {
    const project = createTempDir('temp-loop-followup-runner');
    try {
      mkdirSync(join(project, 'docs/dev'), { recursive: true });
      writeFileSync(join(project, 'docs/dev/plan.md'), '# Plan\n');
      const config = loadConfig(project);
      expect(config.manifest.tasks?.implement).toBeDefined();
      expect(config.manifest.loops.implement).toBeUndefined();
    } finally {
      removeTempDir(project);
    }
  });
});
