import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveOpencodeTimeoutMs,
  OPENCODE_BUILT_IN_TIMEOUT_MS,
  resolveClaudeTimeoutMs,
  resolveCodexTimeoutMs,
  resolveAgyTimeoutMs,
  CONFIG_ONLY_BUILT_IN_TIMEOUT_MS
} from '../../src/adapters/utils.js';

describe('resolveOpencodeTimeoutMs (pure precedence resolver)', () => {
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env['OPENCODE_RUN_TIMEOUT_MS'];
    delete process.env['OPENCODE_RUN_TIMEOUT_MS'];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['OPENCODE_RUN_TIMEOUT_MS'];
    else process.env['OPENCODE_RUN_TIMEOUT_MS'] = savedEnv;
  });

  it('built-in default when neither env nor config is set', () => {
    expect(resolveOpencodeTimeoutMs()).toBe(OPENCODE_BUILT_IN_TIMEOUT_MS);
    expect(resolveOpencodeTimeoutMs({})).toBe(OPENCODE_BUILT_IN_TIMEOUT_MS);
  });

  it('config tier beats built-in when no env', () => {
    expect(resolveOpencodeTimeoutMs({ defaultTimeoutMs: 120000 })).toBe(120000);
  });

  it('env beats config: OPENCODE_RUN_TIMEOUT_MS=30000 wins over defaultTimeoutMs=120000', () => {
    process.env['OPENCODE_RUN_TIMEOUT_MS'] = '30000';
    expect(resolveOpencodeTimeoutMs({ defaultTimeoutMs: 120000 })).toBe(30000);
  });

  it('env beats built-in: OPENCODE_RUN_TIMEOUT_MS=90000 wins when no config', () => {
    process.env['OPENCODE_RUN_TIMEOUT_MS'] = '90000';
    expect(resolveOpencodeTimeoutMs()).toBe(90000);
  });

  it('env "0" disables the watchdog (returns 0)', () => {
    process.env['OPENCODE_RUN_TIMEOUT_MS'] = '0';
    expect(resolveOpencodeTimeoutMs({ defaultTimeoutMs: 120000 })).toBe(0);
  });

  it('config tier 0 disables when env unset', () => {
    expect(resolveOpencodeTimeoutMs({ defaultTimeoutMs: 0 })).toBe(0);
  });

  it('non-numeric env falls through to config tier (defensive)', () => {
    process.env['OPENCODE_RUN_TIMEOUT_MS'] = 'garbage';
    expect(resolveOpencodeTimeoutMs({ defaultTimeoutMs: 120000 })).toBe(120000);
    expect(resolveOpencodeTimeoutMs()).toBe(OPENCODE_BUILT_IN_TIMEOUT_MS);
  });

  it('empty-string env is treated as unset (falls through to config/built-in)', () => {
    process.env['OPENCODE_RUN_TIMEOUT_MS'] = '';
    expect(resolveOpencodeTimeoutMs({ defaultTimeoutMs: 120000 })).toBe(120000);
  });
});

describe('resolveClaudeTimeoutMs / resolveCodexTimeoutMs / resolveAgyTimeoutMs (config-only precedence)', () => {
  it('built-in default is 0 (disabled) when config is unset', () => {
    expect(CONFIG_ONLY_BUILT_IN_TIMEOUT_MS).toBe(0);
    expect(resolveClaudeTimeoutMs()).toBe(0);
    expect(resolveCodexTimeoutMs({})).toBe(0);
    expect(resolveAgyTimeoutMs()).toBe(0);
  });

  it('config tier beats built-in: a configured timeout is returned verbatim', () => {
    expect(resolveClaudeTimeoutMs({ defaultTimeoutMs: 300000 })).toBe(300000);
    expect(resolveCodexTimeoutMs({ defaultTimeoutMs: 240000 })).toBe(240000);
    expect(resolveAgyTimeoutMs({ defaultTimeoutMs: 180000 })).toBe(180000);
  });

  it('config tier 0 explicitly disables (returns 0)', () => {
    expect(resolveClaudeTimeoutMs({ defaultTimeoutMs: 0 })).toBe(0);
    expect(resolveCodexTimeoutMs({ defaultTimeoutMs: 0 })).toBe(0);
    expect(resolveAgyTimeoutMs({ defaultTimeoutMs: 0 })).toBe(0);
  });

  it('negative configured values are normalized to 0 (disabled)', () => {
    expect(resolveClaudeTimeoutMs({ defaultTimeoutMs: -100 })).toBe(0);
    expect(resolveCodexTimeoutMs({ defaultTimeoutMs: -1 })).toBe(0);
  });
});
