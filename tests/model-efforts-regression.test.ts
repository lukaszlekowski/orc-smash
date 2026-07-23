import { describe, it, expect, beforeEach, vi } from 'vitest';
import { select, confirm, input } from '@inquirer/prompts';
import { resolveRunner } from '../src/runner.js';
import { promptRunners } from '../src/interactive.js';
import { createProductionAdapterRegistry } from '../src/adapters/registry.js';
import type { Config } from '../src/config.js';

vi.mock('@inquirer/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  input: vi.fn()
}));

const mockConfig: Config = {
  projectRoot: process.cwd(),
  manifestPath: '/path/to/config/orc-smash.yaml',
  manifestRoot: '/path/to/config',
  manifestDeclarationOrder: { loops: ['plan'], tasks: ['implement'], pipelines: [] },
  registry: {
    providers: {
      opencode: {
        models: ['opencode-go/deepseek-v4-flash', 'opencode-go/unlisted-custom-model'],
        defaultModel: 'opencode-go/deepseek-v4-flash',
        modelEfforts: {
          'opencode-go/deepseek-v4-flash': ['low', 'medium', 'high']
        }
      }
    },
    defaultProfile: 'p1',
    profiles: {
      p1: { provider: 'opencode', effort: 'medium' }
    }
  },
  manifest: {
    schemaVersion: 1 as const,
    roles: { implementer: 'roles/implementer.md' },
    skills: {
      implement: { file: 'skills/implementer.md', role: 'implementer', runnerProfile: 'p1' }
    },
    loops: {},
    tasks: {},
    pipelines: {}
  }
};

describe('Model Efforts Resolver & Interactive Regression (m1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Resolver Behavior', () => {
    it('resolves effort for a listed model with profile effort', () => {
      const runner = resolveRunner('implement', mockConfig);
      expect(runner.agent).toBe('opencode');
      expect(runner.model).toBe('opencode-go/deepseek-v4-flash');
      expect(runner.effort).toBe('medium');
    });

    it('silently omits effort for an unlisted model with profile effort (omission-only)', () => {
      // Create a profile that selects the unlisted custom model with medium effort
      const configWithCustomProfile = {
        ...mockConfig,
        registry: {
          ...mockConfig.registry,
          profiles: {
            p1: { provider: 'opencode', model: 'opencode-go/unlisted-custom-model', effort: 'medium' }
          }
        }
      };

      const runner = resolveRunner('implement', configWithCustomProfile);
      expect(runner.agent).toBe('opencode');
      expect(runner.model).toBe('opencode-go/unlisted-custom-model');
      expect(runner.effort).toBeUndefined();
    });

    it('throws an error if an explicit effort override is provided for an unlisted model', () => {
      const globalOverrides = {
        model: 'opencode-go/unlisted-custom-model',
        effort: 'high'
      };

      expect(() => resolveRunner('implement', mockConfig, globalOverrides)).toThrow(
        /effort 'high' is not supported by agent 'opencode' model 'opencode-go\/unlisted-custom-model'/
      );
    });
  });

  describe('Interactive Prompts Behavior', () => {
    it('always shows effort prompt (with Provider default) and session strategy for a custom/unlisted model selection', async () => {
      vi.mocked(confirm).mockResolvedValueOnce(true); // Choose to customize
      vi.mocked(select)
        .mockResolvedValueOnce('opencode') // Select agent
        .mockResolvedValueOnce('custom') // Select custom model choice
        .mockResolvedValueOnce('default') // Effort prompt (always shown, picks default)
        .mockResolvedValueOnce('fresh-per-invocation'); // Session strategy

      vi.mocked(input).mockResolvedValueOnce('opencode-go/unlisted-custom-model'); // Enter custom model id

      const result = await promptRunners(
        ['implement'],
        mockConfig,
        createProductionAdapterRegistry()
      );

      // Select is called 4 times (agent, model, effort, session strategy).
      // Effort is always shown with at least "Provider default" enabled.
      expect(vi.mocked(select)).toHaveBeenCalledTimes(4);

      // Verify result returns custom model and undefined effort
      expect(result).toEqual({
        implement: {
          agent: 'opencode',
          model: 'opencode-go/unlisted-custom-model',
          effort: undefined,
          sessionStrategy: undefined,
        }
      });
    });
  });
});
