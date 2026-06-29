import type { RunResult, RunError } from '../../src/adapters/types.js';

/**
 * Helper to build an override-friendly RunResult object for tests.
 */
export function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    stdout: 'success',
    exitCode: 0,
    completion: 'complete',
    ...overrides
  };
}

/**
 * Helper to build an override-friendly RunError object for tests.
 */
export function makeRunError(overrides: Partial<RunError> = {}): RunError {
  return {
    kind: 'nonzero-exit',
    message: 'Process exited with non-zero exit code',
    ...overrides
  };
}
