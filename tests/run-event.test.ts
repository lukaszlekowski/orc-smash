import { describe, expect, it } from 'vitest';
import { makeRunEvent, SCHEMA_VERSION } from '../src/run-event.js';

describe('run-event contract', () => {
  it('attaches schemaVersion to every constructed event', () => {
    expect(makeRunEvent({ type: 'run.started', atMs: 1 })).toEqual({
      type: 'run.started',
      atMs: 1,
      schemaVersion: SCHEMA_VERSION
    });
    expect(makeRunEvent({ type: 'provider.completed', atMs: 2, agent: 'fake', toolCalls: '999+', progressEmitted: 8, progressSuppressed: 1 }).schemaVersion)
      .toBe(1);
  });
});
