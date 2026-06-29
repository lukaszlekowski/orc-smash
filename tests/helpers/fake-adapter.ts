import { resetFakeAdapterState } from '../../src/adapters/testing.js';
import { fakeAdapterState } from '../../src/adapters/fake.js';
import type { CliOutput } from '../../src/cli-output.js';
import { vi } from 'vitest';

export function resetFakeAdapterStateForTests(): void {
  resetFakeAdapterState();
}

export function setFakeVerdicts(verdicts: ('APPROVED' | 'REJECTED' | 'unknown')[]): void {
  fakeAdapterState.verdicts = [...verdicts];
}

export function createMockCliOutput(): CliOutput {
  return {
    note: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    iterationStarted: vi.fn(),
    stepStarted: vi.fn(),
    stepSucceeded: vi.fn(),
    stepFailed: vi.fn(),
    renderPanel: vi.fn(),
    finalSummary: vi.fn(),
  };
}
