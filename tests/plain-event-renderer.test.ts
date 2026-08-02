import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { renderRunEvent } from '../src/plain-event-renderer.js';
import type { RunEvent } from '../src/run-event.js';

function event(overrides: Partial<RunEvent> & Pick<RunEvent, 'type'>): RunEvent {
  return { schemaVersion: 1, atMs: 1700000000000, ...overrides } as RunEvent;
}

describe('renderRunEvent — plain event renderer', () => {
  it('renders event type and message text at level 1', () => {
    const originalLevel = chalk.level;
    chalk.level = 1;
    try {
      const out = renderRunEvent(event({ type: 'error', message: 'boom' }));
      expect(out).toContain('error');
      expect(out).toContain('boom');
      expect(out).toMatch(/\u001b\[/);
    } finally {
      chalk.level = originalLevel;
    }
  });

  it('emits no SGR sequences at chalk.level = 0 (AC8, MIN-1)', () => {
    const originalLevel = chalk.level;
    chalk.level = 0;
    try {
      const fail = renderRunEvent(event({ type: 'error', message: 'boom' }));
      const warn = renderRunEvent(event({ type: 'warning', message: 'careful' }));
      const pass = renderRunEvent(event({ type: 'run.completed', result: 'accepted', outcome: 'ok' }));
      const info = renderRunEvent(event({ type: 'config.loaded', path: '/p/config/orc-smash.yaml' }));
      for (const out of [fail, warn, pass, info]) {
        expect(out).not.toMatch(/\u001b\[/);
      }
      expect(fail).toContain('error');
      expect(pass).toContain('run.completed');
    } finally {
      chalk.level = originalLevel;
    }
  });
});
