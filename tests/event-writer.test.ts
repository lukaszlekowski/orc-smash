import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { EventWriter } from '../src/event-writer.js';
import { makeRunEvent } from '../src/run-event.js';

function fakeStream() {
  const stream = new EventEmitter() as EventEmitter & {
    writableEnded: boolean;
    destroyed: boolean;
    write: (chunk: string, encoding: string, callback?: (error?: Error | null) => void) => boolean;
  };
  stream.writableEnded = false;
  stream.destroyed = false;
  const chunks: string[] = [];
  let first = true;
  stream.write = (chunk, _encoding, callback) => {
    chunks.push(chunk);
    callback?.();
    if (first) {
      first = false;
      return false;
    }
    return true;
  };
  return { stream, chunks };
}

describe('EventWriter', () => {
  it('waits for drain and preserves queued event order', async () => {
    const { stream, chunks } = fakeStream();
    const writer = new EventWriter(stream as any);
    const event = makeRunEvent({ type: 'note', atMs: 1, message: 'one' });

    writer.write(event, 'one');
    writer.write(event, 'two');
    let settled = false;
    const flush = writer.flush().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(chunks).toEqual(['one\n']);

    stream.emit('drain');
    await flush;
    expect(chunks).toEqual(['one\n', 'two\n']);
  });

  it('rejects flush on a writer error', async () => {
    const { stream } = fakeStream();
    const writer = new EventWriter(stream as any);
    writer.write(makeRunEvent({ type: 'note', atMs: 1, message: 'one' }), 'one');
    const flush = writer.flush();
    const error = new Error('broken pipe');
    stream.emit('error', error);
    await expect(flush).rejects.toBe(error);
    expect(writer.fatal).toBe(error);
  });
});
