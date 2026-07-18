import { resetFakeAdapterState } from '../../src/adapters/testing.js';
import { fakeAdapterState } from '../../src/adapters/fake.js';
import type { CliOutput } from '../../src/cli-output.js';
import { createMockOutput } from './mock-output.js';

export function resetFakeAdapterStateForTests(): void {
  resetFakeAdapterState();
}

export function setFakeVerdicts(verdicts: ('APPROVED' | 'REJECTED' | 'unknown')[]): void {
  fakeAdapterState.verdicts = [...verdicts];
}

export function createMockCliOutput(overrides?: Partial<CliOutput>): CliOutput {
  return createMockOutput(overrides);
}
