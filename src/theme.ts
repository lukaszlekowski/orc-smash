import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk, { Chalk, type ChalkInstance } from 'chalk';
import YAML from 'yaml';
import { z } from 'zod';
import type { PanelContext } from './status.js';
import type { StepKind } from './state.js';

const TOOL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGED_THEME_PATH = resolve(TOOL_ROOT, 'config/theme.yaml');
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

const BUILTIN_COLORS = new Set([
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white', 'gray', 'grey',
  'blackBright', 'redBright', 'greenBright', 'yellowBright', 'blueBright',
  'magentaBright', 'cyanBright', 'whiteBright',
]);

export const THEME_TOKENS = [
  'role.auditor', 'role.planner', 'role.reviewer', 'role.implementer', 'role.unknown',
  'kind.audit', 'kind.follow-up', 'kind.implement', 'kind.evaluate', 'kind.repair', 'kind.task',
  'status.running', 'status.failed', 'status.done', 'status.interrupted',
  'result.pass', 'result.fail', 'result.warn', 'result.neutral',
  'availability.available', 'availability.unavailable', 'availability.missing-inputs',
  'emphasis.identity', 'emphasis.binding-identity', 'emphasis.supporting',
  'emphasis.placeholder', 'emphasis.recommended', 'emphasis.warning',
  'unclassified.attention', 'unclassified.idle',
  'stale.stale', 'stale.fresh',
  'panel.column_header', 'panel.dim_row',
  'panel.border.failed', 'panel.border.audit', 'panel.border.evaluate',
  'panel.border.follow-up', 'panel.border.repair', 'panel.border.implement',
  'panel.border.task', 'panel.border.default',
  'log.fail', 'log.warn', 'log.pass', 'log.info',
] as const;

export type ThemeToken = typeof THEME_TOKENS[number];
export type ThemeLocation = 'status-panel' | 'terminal-accent' | 'plain-timeline' | 'log';
export type TextFormatter = (text: string) => string;

const TOKEN_SET = new Set<string>(THEME_TOKENS);
const LOCATIONS: ThemeLocation[] = ['status-panel', 'terminal-accent', 'plain-timeline', 'log'];

const StyleSpecSchema = z.object({
  fg: z.string().min(1).optional(),
  bg: z.string().min(1).optional(),
  bold: z.boolean().optional(),
  dim: z.boolean().optional(),
  underline: z.boolean().optional(),
  inverse: z.boolean().optional(),
}).strict();

const ThemeFileSchema = z.object({
  colors: z.record(z.string().min(1)).optional(),
  defaults: z.record(StyleSpecSchema),
  'status-panel': z.record(StyleSpecSchema).optional(),
  'terminal-accent': z.record(StyleSpecSchema).optional(),
  'plain-timeline': z.record(StyleSpecSchema).optional(),
  log: z.record(StyleSpecSchema).optional(),
}).strict();

export type StyleSpec = z.infer<typeof StyleSpecSchema>;
type ThemeFile = z.infer<typeof ThemeFileSchema>;

function isBuiltinColor(value: string): boolean {
  return BUILTIN_COLORS.has(value);
}

function isDirectColor(value: string): boolean {
  return HEX_COLOR.test(value) || isBuiltinColor(value);
}

function addIssue(ctx: z.RefinementCtx, path: (string | number)[], message: string): void {
  ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
}

const ValidatedThemeFileSchema = ThemeFileSchema.superRefine((theme, ctx) => {
  for (const [name, value] of Object.entries(theme.colors ?? {})) {
    if (!isDirectColor(value)) {
      addIssue(ctx, ['colors', name], `Unknown color '${value}'; expected a chalk color or #rrggbb hex`);
    }
  }

  const groups: Array<[string, Record<string, StyleSpec> | undefined]> = [
    ['defaults', theme.defaults],
    ...LOCATIONS.map(location => [location, theme[location]] as [string, Record<string, StyleSpec> | undefined]),
  ];
  for (const [group, specs] of groups) {
    for (const [token, spec] of Object.entries(specs ?? {})) {
      if (!TOKEN_SET.has(token)) {
        addIssue(ctx, [group, token], `Unknown theme token '${token}'`);
        continue;
      }
      for (const field of ['fg', 'bg'] as const) {
        const value = spec[field];
        if (value === undefined) continue;
        if (!isDirectColor(value) && !(value in (theme.colors ?? {}))) {
          addIssue(ctx, [group, token, field], `Unknown color '${value}'`);
        }
      }
    }
  }
});

const identityFormatter: TextFormatter = text => text;

function resolvedColor(value: string, colors: Record<string, string>): string {
  if (isDirectColor(value)) return value;
  const configured = colors[value];
  if (configured === undefined) throw new Error(`Unknown theme color '${value}'`);
  return configured;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function applyColor(instance: ChalkInstance, value: string, colors: Record<string, string>, background: boolean): ChalkInstance {
  const color = resolvedColor(value, colors);
  if (HEX_COLOR.test(color)) return background ? instance.bgHex(color) : instance.hex(color);

  const methodName = background ? `bg${capitalize(color)}` : color;
  const method = (instance as unknown as Record<string, unknown>)[methodName];
  if (typeof method !== 'function') throw new Error(`Unsupported chalk color '${color}'`);
  return method as ChalkInstance;
}

function buildFormatter(spec: StyleSpec, colors: Record<string, string>): TextFormatter {
  if (chalk.level === 0) return identityFormatter;

  let instance: ChalkInstance = new Chalk({ level: chalk.level });
  // Modifier-before-color ordering matches the existing chalk chains:
  // chalk.bold.cyan opens bold and then cyan.
  if (spec.bold) instance = instance.bold;
  if (spec.dim) instance = instance.dim;
  if (spec.underline) instance = instance.underline;
  if (spec.inverse) instance = instance.inverse;
  if (spec.bg) instance = applyColor(instance, spec.bg, colors, true);
  if (spec.fg) instance = applyColor(instance, spec.fg, colors, false);
  return text => instance(text);
}

export type BorderContext =
  | 'failed'
  | 'audit'
  | 'evaluate'
  | 'follow-up'
  | 'repair'
  | 'implement'
  | 'task'
  | 'default';

const KIND_BORDER_CONTEXT: Record<StepKind, Exclude<BorderContext, 'failed' | 'default'>> = {
  audit: 'audit',
  evaluate: 'evaluate',
  'follow-up': 'follow-up',
  repair: 'repair',
  implement: 'implement',
  task: 'task',
};

/** Extract the panel's context-sensitive border state without resolving color. */
export function borderContext(ctx: PanelContext): BorderContext {
  if (ctx.inFlight?.status === 'failed') return 'failed';
  if (ctx.inFlight) return KIND_BORDER_CONTEXT[ctx.inFlight.kind];

  const relevantRows = ctx.timeline.filter(row => row.relevance !== 'unrelated' && row.relevance !== 'unclassified');
  const last = relevantRows[relevantRows.length - 1]?.step;
  if (last?.status === 'failed') return 'failed';
  if (last) return KIND_BORDER_CONTEXT[last.kind] ?? 'default';
  return 'default';
}

export class Theme {
  private readonly styleCache = new Map<string, TextFormatter>();
  private readonly borderCache = new Map<string, string>();

  public constructor(private readonly file: ThemeFile, public readonly sourcePath?: string) {}

  private specFor(token: ThemeToken, location: ThemeLocation): StyleSpec {
    return this.file[location]?.[token] ?? this.file.defaults[token] ?? {};
  }

  public resolveStyle(token: string, location: ThemeLocation = 'terminal-accent'): TextFormatter {
    if (!TOKEN_SET.has(token)) throw new Error(`Unknown theme token '${token}'`);
    const level = chalk.level;
    const key = `${level}:${location}:${token}`;
    const cached = this.styleCache.get(key);
    if (cached) return cached;
    const formatter = buildFormatter(this.specFor(token as ThemeToken, location), this.file.colors ?? {});
    this.styleCache.set(key, formatter);
    return formatter;
  }

  public resolveBorderColor(ctx: PanelContext, location: ThemeLocation = 'status-panel'): string {
    const context = borderContext(ctx);
    const token = `panel.border.${context}` as ThemeToken;
    const key = `${location}:${token}`;
    const cached = this.borderCache.get(key);
    if (cached) return cached;
    const spec = this.specFor(token, location);
    if (!spec.fg) throw new Error(`Theme token '${token}' must define an fg color for a boxen border`);
    const color = resolvedColor(spec.fg, this.file.colors ?? {});
    this.borderCache.set(key, color);
    return color;
  }
}

function themePathFor(projectRoot: string, explicitPath?: string): string {
  if (explicitPath) return resolve(explicitPath);
  const localPath = resolve(projectRoot, '.theme.yaml');
  if (existsSync(localPath)) return localPath;
  return PACKAGED_THEME_PATH;
}

function packagedThemePath(): string {
  if (!existsSync(PACKAGED_THEME_PATH)) throw new Error(`Packaged theme not found: ${PACKAGED_THEME_PATH}`);
  return PACKAGED_THEME_PATH;
}

/** Resolve the CLI theme precedence without loading the file. */
export function resolveThemePath(projectRoot: string = process.cwd(), explicitPath?: string): string {
  const path = themePathFor(projectRoot, explicitPath);
  if (!existsSync(path)) {
    if (explicitPath) throw new Error(`Specified theme file not found: ${path}`);
    throw new Error(`Packaged theme not found: ${path}`);
  }
  return path;
}

/** Build an isolated Theme instance; this function never mutates module state. */
export function loadTheme(path?: string): Theme {
  const themePath = path ? resolveThemePath(process.cwd(), path) : packagedThemePath();
  const raw = YAML.parse(readFileSync(themePath, 'utf-8'));
  const result = ValidatedThemeFileSchema.safeParse(raw);
  if (!result.success) throw result.error;
  return new Theme(result.data, themePath);
}

let defaultTheme: Theme | undefined;
let defaultThemePath: string | undefined;

/** Seed the production convenience theme before rendering. */
export function initTheme(themePath?: string, projectRoot: string = process.cwd()): Theme {
  const resolvedPath = themePath ? resolveThemePath(projectRoot, themePath) : packagedThemePath();
  if (!defaultTheme || defaultThemePath !== resolvedPath) {
    defaultTheme = loadTheme(resolvedPath);
    defaultThemePath = resolvedPath;
  }
  return defaultTheme;
}

function getDefaultTheme(): Theme {
  return defaultTheme ?? initTheme();
}

export function resolveStyle(token: string, location: ThemeLocation = 'terminal-accent'): TextFormatter {
  return getDefaultTheme().resolveStyle(token, location);
}

export function resolveBorderColor(ctx: PanelContext, location: ThemeLocation = 'status-panel'): string {
  return getDefaultTheme().resolveBorderColor(ctx, location);
}

export { ThemeFileSchema };
