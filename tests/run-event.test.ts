import { describe, expect, it } from 'vitest';
import { makeRunEvent, SCHEMA_VERSION } from '../src/run-event.js';
import { renderRunEvent } from '../src/plain-event-renderer.js';

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

  it('supports additive progressCapability on provider.started without changing schemaVersion', () => {
    const event = makeRunEvent({ type: 'provider.started', atMs: 100, agent: 'codex', progressCapability: 'structured' });
    expect(event.schemaVersion).toBe(SCHEMA_VERSION);
    if (event.type === 'provider.started') {
      expect(event.progressCapability).toBe('structured');
    }

    const rendered = renderRunEvent(event);
    expect(rendered).toContain('provider.started agent=codex progressCapability=structured');

    const eventWithoutCap = makeRunEvent({ type: 'provider.started', atMs: 100, agent: 'codex' });
    const renderedWithoutCap = renderRunEvent(eventWithoutCap);
    expect(renderedWithoutCap).toContain('provider.started agent=codex');
    expect(renderedWithoutCap).not.toContain('progressCapability');
  });
});
