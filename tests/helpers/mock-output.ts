import type { CliOutput } from '../../src/cli-output.js';
import type { RunEvent } from '../../src/run-event.js';

export function createMockOutput<T extends Record<string, any>>(overrides?: T): CliOutput & T {
  const events: RunEvent[] = [];
  return {
    emit: (event: RunEvent) => { events.push(event); },
    flush: async () => {},
    note: () => {},
    warn: () => {},
    error: () => {},
    iterationStarted: () => {},
    stepStarted: () => {},
    stepSucceeded: () => {},
    stepFailed: () => {},
    renderPanel: () => {},
    finalSummary: () => {},
    ...overrides
  } as unknown as CliOutput & T;
}
