import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import {
  loadModelRegistry,
  DEFAULT_REGISTRY,
  registryTimeoutFor
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

  it('parses optional per-agent timeouts and exposes them via registryTimeoutFor', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    const yaml = `
providers:
  opencode:
    - opencode-go/deepseek-v4-flash
defaults:
  agent: opencode
  model: opencode-go/deepseek-v4-flash
timeouts:
  opencode: 120000
`;
    writeFileSync(join(tempDir, 'orc.config.yaml'), yaml);
    const registry = loadModelRegistry(tempDir);
    expect(registry.timeouts?.['opencode']).toBe(120000);
    expect(registryTimeoutFor(registry, 'opencode')).toBe(120000);
    expect(registryTimeoutFor(registry, 'codex')).toBeUndefined();
  });

  it('parses claude/codex/agy config-only timeouts and exposes them via registryTimeoutFor', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    writeFileSync(join(tempDir, 'orc.config.yaml'), `
providers:
  opencode: [opencode-go/x]
  claude: [glm-5.2]
  codex: [gpt-5.4]
  agy: ['Gemini 3.5 Flash (Medium)']
defaults: { agent: opencode, model: opencode-go/x }
timeouts:
  opencode: 600000
  claude: 300000
  codex: 240000
  agy: 180000
`);
    const registry = loadModelRegistry(tempDir);
    expect(registryTimeoutFor(registry, 'opencode')).toBe(600000);
    expect(registryTimeoutFor(registry, 'claude')).toBe(300000);
    expect(registryTimeoutFor(registry, 'codex')).toBe(240000);
    expect(registryTimeoutFor(registry, 'agy')).toBe(180000);
    // An agent with no timeout support still resolves to undefined.
    expect(registryTimeoutFor(registry, 'fake')).toBeUndefined();
  });

  it('treats claude/codex/agy timeouts as optional (undefined when omitted)', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    writeFileSync(join(tempDir, 'orc.config.yaml'), `
providers: { opencode: [opencode-go/x] }
defaults: { agent: opencode, model: opencode-go/x }
timeouts: { opencode: 60000 }
`);
    const registry = loadModelRegistry(tempDir);
    expect(registryTimeoutFor(registry, 'claude')).toBeUndefined();
    expect(registryTimeoutFor(registry, 'codex')).toBeUndefined();
    expect(registryTimeoutFor(registry, 'agy')).toBeUndefined();
  });

  it('rejects negative or non-integer timeout values', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    writeFileSync(join(tempDir, 'orc.config.yaml'), `
providers: { opencode: ['opencode-go/x'] }
defaults: { agent: opencode, model: opencode-go/x }
timeouts: { opencode: -5 }
`);
    expect(() => loadModelRegistry(tempDir)).toThrow(/Failed to parse or validate/);
  });

  it('treats timeouts.opencode: 0 as "disabled" (non-negative integers allowed)', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    writeFileSync(join(tempDir, 'orc.config.yaml'), `
providers: { opencode: ['opencode-go/x'] }
defaults: { agent: opencode, model: opencode-go/x }
timeouts: { opencode: 0 }
`);
    const registry = loadModelRegistry(tempDir);
    expect(registryTimeoutFor(registry, 'opencode')).toBe(0);
  });

  it('rejects unknown timeouts keys (e.g. "opencdoe" as a typo) — strict schema catches unrecognized keys', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    writeFileSync(join(tempDir, 'orc.config.yaml'), `
providers: { opencode: ['opencode-go/x'] }
defaults: { agent: opencode, model: opencode-go/x }
timeouts: { opencdoe: 12345 }
`);
    expect(() => loadModelRegistry(tempDir)).toThrow(/Unrecognized/);
  });

  it('rejects a non-opencode timeouts key even when opencode is also present', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    writeFileSync(join(tempDir, 'orc.config.yaml'), `
providers: { opencode: ['opencode-go/x'] }
defaults: { agent: opencode, model: opencode-go/x }
timeouts: { opencode: 60000, fake: 5000 }
`);
    expect(() => loadModelRegistry(tempDir)).toThrow(/Unrecognized/);
  });

  it('accepts a codex timeouts key (codex/claude/agy are config-only timeout agents)', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    writeFileSync(join(tempDir, 'orc.config.yaml'), `
providers:
  opencode: [opencode-go/x]
  codex: [gpt-5.4]
  claude: [glm-5.2]
defaults: { agent: opencode, model: opencode-go/x }
timeouts:
  opencode: 60000
  codex: 60000
`);
    const registry = loadModelRegistry(tempDir);
    expect(registryTimeoutFor(registry, 'codex')).toBe(60000);
  });

  it('rejects a genuinely unknown timeouts key (e.g. an unsupported agent)', () => {
    vi.spyOn(os, 'homedir').mockReturnValue(join(tempDir, 'home'));
    writeFileSync(join(tempDir, 'orc.config.yaml'), `
providers: { opencode: [opencode-go/x] }
defaults: { agent: opencode, model: opencode-go/x }
timeouts: { opencode: 60000, fake: 5000 }
`);
    expect(() => loadModelRegistry(tempDir)).toThrow(/Unrecognized/);
  });
});
