/**
 * Single source of truth for artifact-path rendering, parsing, and validation.
 *
 * Artifact paths are templated with `{version}` and `{provider}` tokens, e.g.
 * `docs/dev/plan-audit-v{version}-{provider}.md`. Both the render direction
 * (template -> concrete path) and the parse direction (path -> capture groups)
 * live here so the runtime and the state scanner cannot drift on filename
 * semantics.
 */

export interface PatternValues {
  version: number;
  provider: string;
}

const BUILT_IN_TOKENS = ['version', 'provider'] as const;

const TOKEN_PATTERN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

const PROVIDER_FILENAME_RE = /^[a-zA-Z0-9_-]+$/;

export function renderPattern(pattern: string, values: PatternValues): string {
  if (!Number.isInteger(values.version) || values.version < 0) {
    throw new Error(`Artifact version must be a non-negative integer (got ${values.version}).`);
  }
  if (!isValidProviderId(values.provider)) {
    throw new Error(`Artifact provider '${values.provider}' is not valid for an output filename.`);
  }
  return pattern
    .replace('{version}', String(values.version))
    .replace('{provider}', values.provider);
}

export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace('\\{version\\}', '(\\d+)')
    .replace('\\{provider\\}', '([a-zA-Z0-9_-]+)');
  return new RegExp('^' + escaped + '$');
}

/**
 * Validate an output-pattern string for the grammar:
 *   - must contain `{version}` exactly once
 *   - must contain `{provider}` exactly once
 *   - no other `{...}` tokens
 *   - `{provider}` replacement values must match `[a-zA-Z0-9_-]+`
 *
 * Returns an array of token names found.
 * Throws with a descriptive message on validation failure.
 */
export function validateOutputPattern(pattern: string): void {
  const tokens: string[] = [];
  let match: RegExpExecArray | null;
  TOKEN_PATTERN.lastIndex = 0;
  while ((match = TOKEN_PATTERN.exec(pattern)) !== null) {
    tokens.push(match[1]!);
  }
  const versionCount = tokens.filter(t => t === 'version').length;
  const providerCount = tokens.filter(t => t === 'provider').length;
  if (versionCount !== 1 || providerCount !== 1) {
    throw new Error(
      `Output pattern "${pattern}" must contain {version} and {provider} exactly once each (got version=${versionCount}, provider=${providerCount})`
    );
  }
  for (const token of tokens) {
    if (!(BUILT_IN_TOKENS as readonly string[]).includes(token)) {
      throw new Error(
        `Output pattern "${pattern}" contains unknown token "{${token}}"; only {version} and {provider} are permitted`
      );
    }
  }
}

export function isValidProviderId(value: string): boolean {
  return PROVIDER_FILENAME_RE.test(value);
}

/** Built-in input source names */
export const BUILT_IN_SOURCES = ['target', 'version', 'priorArtifact', 'outputPath'] as const;
export type BuiltInSource = (typeof BUILT_IN_SOURCES)[number];

export function isBuiltInSource(s: string): s is BuiltInSource {
  return (BUILT_IN_SOURCES as readonly string[]).includes(s);
}
