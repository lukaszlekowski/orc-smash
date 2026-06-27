import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadManifest, type Manifest } from './manifest.js';

export interface Config {
  defaultAgent: string;
  defaultModel: string;
  agentDefaultModels: Record<string, string>;
  apiKeys: Record<string, string>;
  manifest: Manifest;
}

export function loadConfig(projectRoot: string = process.cwd()): Config {
  // Load env from the projectRoot if it exists, otherwise fallback to current directory
  const envPath = resolve(projectRoot, '.env');
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  } else {
    dotenv.config();
  }

  // Load manifest. skills.yaml is always in the tool's root directory or target root?
  // The plan states "skills.yaml" is in the tool repository root.
  // Let's resolve skills.yaml relative to this file's directory (src/config.ts -> ../skills.yaml)
  // or we can allow passing it. Let's look for skills.yaml in process.cwd() or tool root.
  const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let manifestPath = resolve(toolRoot, 'skills.yaml');
  if (!existsSync(manifestPath)) {
    // fallback to projectRoot
    manifestPath = resolve(projectRoot, 'skills.yaml');
  }

  const manifest = loadManifest(manifestPath);

  const defaultAgent = process.env['DEFAULT_AGENT'] || 'opencode';
  // Note: opencode-go/deepseek-v4-flash is the paid provider model, which bills the user's plan.
  const defaultModel = process.env['DEFAULT_MODEL'] || 'opencode-go/deepseek-v4-flash';

  const agentDefaultModels: Record<string, string> = {
    opencode: process.env['OPENCODE_DEFAULT_MODEL'] || 'opencode-go/deepseek-v4-flash',
    codex: process.env['CODEX_DEFAULT_MODEL'] || 'gpt-5-codex',
    claude: process.env['CLAUDE_DEFAULT_MODEL'] || 'claude-sonnet-4-6',
    fake: 'fake-model'
  };

  const apiKeys: Record<string, string> = {};
  if (process.env['OPENCODE_API_KEY']) {
    apiKeys['opencode'] = process.env['OPENCODE_API_KEY'];
  }
  if (process.env['CODEX_API_KEY']) {
    apiKeys['codex'] = process.env['CODEX_API_KEY'];
  }
  if (process.env['CLAUDE_API_KEY']) {
    apiKeys['claude'] = process.env['CLAUDE_API_KEY'];
  }

  return {
    defaultAgent,
    defaultModel,
    agentDefaultModels,
    apiKeys,
    manifest
  };
}

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
