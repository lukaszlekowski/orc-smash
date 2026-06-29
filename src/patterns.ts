/**
 * Single source of truth for artifact-path rendering and parsing (production runtime).
 *
 * Artifact paths are templated with `{n}` (audit/follow-up version) and `{agent}`
 * tokens, e.g. `docs/dev/plan-audit-v{n}-{agent}.md`. Both the render direction
 * (template -> concrete path) and the parse direction (path -> capture groups)
 * live here so the runtime (loop / prompt-composer) and the state scanner cannot
 * drift on filename semantics.
 *
 * Scope note: this seam covers production runtime code only. The fake test adapter
 * keeps its own independent path-kind token detection (deferred to roadmap item 20)
 * — see `src/adapters/fake.ts`.
 */

export interface PatternValues {
  n: number;
  agent: string;
}

/**
 * Render a templated path pattern into a concrete path by substituting the
 * `{n}` (version) and `{agent}` tokens. Mirrors the previous inline
 * `.replace('{n}', ...).replace('{agent}', ...)` exactly.
 */
export function renderPattern(pattern: string, values: PatternValues): string {
  return pattern
    .replace('{n}', String(values.n))
    .replace('{agent}', values.agent);
}

/**
 * Build the anchored regex used to match a templated path pattern. Captures the
 * `{n}` group as `\d+` and the `{agent}` group as `[a-zA-Z0-9_-]+`, matching
 * agents composed of letters, digits, `_`, and `-`.
 */
export function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace('\\{n\\}', '(\\d+)')
    .replace('\\{agent\\}', '([a-zA-Z0-9_-]+)');
  return new RegExp('^' + escaped + '$');
}
