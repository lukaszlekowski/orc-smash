import type { RunResult } from './types.js';

/**
 * Classify a run's execution-completeness from the adapter's raw completion
 * signal, producing a normalized value the loop can branch on WITHOUT knowing
 * provider-specific stop-reason literals.
 *
 * Batch 1 rules:
 *  - `agent !== 'opencode'`  => `undefined`
 *  - opencode + `stop`       => `'complete'`
 *  - opencode + `tool-calls` => `'complete'`
 *  - opencode + other string => `'truncated'`
 *  - opencode + null signal  => `'interrupted'` (a verified completion signal was
 *                               expected but missing)
 *
 * codex/claude support is intentionally `undefined` until a later batch verifies
 * their completion semantics — the loop must not treat their runs as truncated
 * based on this field.
 */
export function classifyCompletion(agent: string, result: RunResult): RunResult['completion'] | undefined {
  if (agent !== 'opencode') {
    return undefined;
  }

  const stopReason = result.stopReason;
  if (stopReason === 'stop' || stopReason === 'tool-calls') {
    return 'complete';
  }
  if (stopReason == null) {
    return 'interrupted';
  }
  return 'truncated';
}
