import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import os from 'node:os';
import {
  loadModelRegistry,
  DEFAULT_REGISTRY,
  loadConfig
} from '../src/config.js';
import { loadManifest } from '../src/manifest.js';
import { createTempDir, removeTempDir } from './helpers/fs.js';

describe('ModelRegistry config system', () => {
  const tempDir = join(process.cwd(), 'temp-config-test');

  beforeEach(() => {
    createTempDir('temp-config-test');
    vi.restoreAllMocks();
  });

  afterEach(() => {
    removeTempDir(tempDir);
  });

  it('returns DEFAULT_REGISTRY if neither project-local nor home config exists', () => {
    // Mock os.homedir to return a non-existent path
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'nonexistent-home'));
    
    // loadModelRegistry(tempDir) should fall back to DEFAULT_REGISTRY
    const registry = loadModelRegistry(tempDir);
    expect(registry).toEqual(DEFAULT_REGISTRY);
  });

  it('uses project-local orc.config.yaml if it exists', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    
    // Write local config
    const localConfigYaml = `
providers:
  opencode:
    - local-opencode-model
defaults:
  agent: opencode
  model: local-opencode-model
`;
    writeFileSync(join(tempDir, 'orc.config.yaml'), localConfigYaml);

    const registry = loadModelRegistry(tempDir);
    expect(registry.providers['opencode']).toEqual(['local-opencode-model']);
    expect(registry.defaults.agent).toBe('opencode');
    expect(registry.defaults.model).toBe('local-opencode-model');
  });

  it('uses home config if local is missing', () => {
    const homeDir = join(tempDir, 'home');
    mkdirSync(join(homeDir, '.config/orc'), { recursive: true });
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);

    const homeConfigYaml = `
providers:
  claude:
    - home-claude-model
defaults:
  agent: claude
  model: home-claude-model
`;
    writeFileSync(join(homeDir, '.config/orc/config.yaml'), homeConfigYaml);

    const registry = loadModelRegistry(tempDir);
    expect(registry.providers['claude']).toEqual(['home-claude-model']);
    expect(registry.defaults.agent).toBe('claude');
    expect(registry.defaults.model).toBe('home-claude-model');
  });

  it('throws a hard error if the configuration file is structurally invalid', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    
    const invalidYaml = `
providers: 12345
defaults:
  agent: opencode
`;
    writeFileSync(join(tempDir, 'orc.config.yaml'), invalidYaml);

    expect(() => {
      loadModelRegistry(tempDir);
    }).toThrow(/Failed to parse or validate model registry config/);
  });

  it('loadManifest rejects skill referencing unregistered model', () => {
    const registry = {
      providers: {
        opencode: ['opencode-allowed-model']
      },
      defaults: {
        agent: 'opencode',
        model: 'opencode-allowed-model'
      }
    };

    const manifestYaml = `
roles:
  auditor: roles/auditor.md
skills:
  plan-audit:
    file: skills/plan-audit/SKILL.md
    role: auditor
    kind: audit
    agent: opencode
    model: unregistered-model
loops: {}
`;
    const manifestPath = join(tempDir, 'skills.yaml');
    writeFileSync(manifestPath, manifestYaml);

    expect(() => {
      loadManifest(manifestPath, registry);
    }).toThrow(/unregistered-model/);
  });
});
