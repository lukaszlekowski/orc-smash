import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const DEBUG_SPAWN_ENV = 'ORC_DEBUG_SPAWN';
const DEBUG_SPAWN_FILE_ENV = 'ORC_DEBUG_SPAWN_FILE';
const DEFAULT_DEBUG_LOG_PATH = 'docs/dev/spawn-debug.log';
const DEBUG_PROMPT_MAX_CHARS = 4000;
const DEBUG_OUTPUT_TAIL_MAX_CHARS = 4000;
let debugSpawnEnabledOverride: boolean | null = null;
let debugSpawnFileOverride: string | null = null;

function truncateDebugText(text: string, maxChars = DEBUG_PROMPT_MAX_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n... [truncated ${text.length - maxChars} chars]`;
}

function tailDebugText(text: string, maxChars = DEBUG_OUTPUT_TAIL_MAX_CHARS): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `[truncated ${text.length - maxChars} chars]\n${text.slice(-maxChars)}`;
}

export function isSpawnDebugEnabled(): boolean {
  if (debugSpawnEnabledOverride !== null) {
    return debugSpawnEnabledOverride;
  }
  const raw = process.env[DEBUG_SPAWN_ENV];
  return raw === '1' || raw === 'true';
}

export function configureSpawnDebug(options: { enabled?: boolean; filePath?: string | null }): void {
  if (options.enabled !== undefined) {
    debugSpawnEnabledOverride = options.enabled;
  }
  if (options.filePath !== undefined) {
    debugSpawnFileOverride = options.filePath;
  }
}

function resolveDebugLogPath(cwd: string): string {
  if (debugSpawnFileOverride) {
    return isAbsolute(debugSpawnFileOverride) ? debugSpawnFileOverride : resolve(cwd, debugSpawnFileOverride);
  }
  const rawPath = process.env[DEBUG_SPAWN_FILE_ENV];
  if (!rawPath) {
    return resolve(cwd, DEFAULT_DEBUG_LOG_PATH);
  }
  return isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
}

function writeDebugLog(cwd: string, lines: string[]): void {
  const logPath = resolveDebugLogPath(cwd);
  mkdirSync(dirname(logPath), { recursive: true });
  appendFileSync(logPath, `${new Date().toISOString()}\n${lines.join('\n')}\n\n`, 'utf8');
}

export function debugLoopSpawn(ctx: {
  loopName: string;
  skillId: string;
  kind: string;
  agent: string;
  model: string;
  version: number;
  cwd: string;
  prompt: string;
}): void {
  if (!isSpawnDebugEnabled()) {
    return;
  }

  writeDebugLog(ctx.cwd,
    [
      '[ORC_DEBUG_SPAWN] loop adapter run',
      `loop=${ctx.loopName}`,
      `skill=${ctx.skillId}`,
      `kind=${ctx.kind}`,
      `agent=${ctx.agent}`,
      `model=${ctx.model}`,
      `version=${ctx.version}`,
      `cwd=${ctx.cwd}`,
      'prompt:',
      truncateDebugText(ctx.prompt)
    ]
  );
}

export function debugCommandBuild(ctx: {
  adapter: string;
  command: string;
  args: string[];
  cwd: string;
}): void {
  if (!isSpawnDebugEnabled()) {
    return;
  }

  writeDebugLog(ctx.cwd,
    [
      '[ORC_DEBUG_SPAWN] adapter command',
      `adapter=${ctx.adapter}`,
      `command=${ctx.command}`,
      `cwd=${ctx.cwd}`,
      `args=${JSON.stringify(ctx.args)}`
    ]
  );
}

export function debugProcessLifecycle(ctx: {
  adapter: string;
  cwd: string;
  command: string;
  args: string[];
  pid?: number;
  phase: 'spawned' | 'completed' | 'spawn-error';
  durationMs?: number;
  exitCode?: number;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  stdout?: string;
  stderr?: string;
  spawnErrorMessage?: string;
}): void {
  if (!isSpawnDebugEnabled()) {
    return;
  }

  const lines = [
    '[ORC_DEBUG_SPAWN] process lifecycle',
    `adapter=${ctx.adapter}`,
    `phase=${ctx.phase}`,
    `command=${ctx.command}`,
    `cwd=${ctx.cwd}`,
    `args=${JSON.stringify(ctx.args)}`
  ];

  if (ctx.pid !== undefined) lines.push(`pid=${ctx.pid}`);
  if (ctx.durationMs !== undefined) lines.push(`durationMs=${ctx.durationMs}`);
  if (ctx.exitCode !== undefined) lines.push(`exitCode=${ctx.exitCode}`);
  if (ctx.signal !== undefined) lines.push(`signal=${ctx.signal ?? 'null'}`);
  if (ctx.timedOut !== undefined) lines.push(`timedOut=${String(ctx.timedOut)}`);
  if (ctx.spawnErrorMessage) lines.push(`spawnError=${ctx.spawnErrorMessage}`);
  if (ctx.stdout !== undefined) {
    lines.push('stdout_tail:');
    lines.push(tailDebugText(ctx.stdout));
  }
  if (ctx.stderr !== undefined) {
    lines.push('stderr_tail:');
    lines.push(tailDebugText(ctx.stderr));
  }

  writeDebugLog(ctx.cwd, lines);
}
