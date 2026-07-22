import type { CliOutput } from '../../src/cli-output.js';
import type { RunEvent } from '../../src/run-event.js';

export function createMockOutput<T extends Record<string, any>>(overrides?: T): CliOutput & T & { staticTextWrites: string[]; lastStaticText: string | null } {
  const events: RunEvent[] = [];
  const staticTextWrites: string[] = [];
  const mock = {
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
    writeStatic: (text: string) => { staticTextWrites.push(text); },
    get lastStaticText() {
      return staticTextWrites.length > 0 ? staticTextWrites[staticTextWrites.length - 1]! : null;
    },
    staticTextWrites,
    ...overrides
  };
  return mock as unknown as CliOutput & T & { staticTextWrites: string[]; lastStaticText: string | null };
}
