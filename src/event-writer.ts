import type { Writable } from 'node:stream';
import type { RunEvent } from './run-event.js';

/** Serializes canonical event lines and honors Writable backpressure. */
export class EventWriter {
  private _sequence = 0;
  private _queue: string[] = [];
  private _backpressured = false;
  private _pendingWrites = 0;
  private _flushWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];
  private _fatal: Error | null = null;

  constructor(private readonly _stream: Writable) {
    this._stream.on('error', (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
    this._stream.on('close', () => {
      if (this._flushWaiters.length > 0 || this._queue.length > 0 || this._backpressured || this._pendingWrites > 0) {
        this.fail(new Error('event output stream closed before flush completed'));
      }
    });
  }

  write(_event: RunEvent, line: string): boolean {
    if (this._fatal) return false;
    this._sequence += 1;
    this._queue.push(`${line}\n`);
    this.pump();
    return !this._fatal && !this._backpressured;
  }

  flush(): Promise<void> {
    if (this._fatal) return Promise.reject(this._fatal);
    this.pump();
    if (this._queue.length === 0 && !this._backpressured && this._pendingWrites === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this._flushWaiters.push({ resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    if (this._fatal || this._backpressured) return;

    while (this._queue.length > 0 && !this._backpressured && !this._fatal) {
      const line = this._queue.shift()!;
      let accepted: boolean;
      this._pendingWrites += 1;
      try {
        accepted = this._stream.write(line, 'utf-8', (error?: Error | null) => {
          this._pendingWrites -= 1;
          if (error) this.fail(error);
          else this.resolveWaitersIfDrained();
        });
      } catch (error) {
        this._pendingWrites -= 1;
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (!accepted) {
        this._backpressured = true;
        this._stream.once('drain', () => {
          this._backpressured = false;
          this.pump();
        });
      }
    }

    this.resolveWaitersIfDrained();
  }

  private resolveWaitersIfDrained(): void {
    if (this._queue.length === 0 && !this._backpressured && this._pendingWrites === 0) {
      const waiters = this._flushWaiters.splice(0);
      for (const waiter of waiters) waiter.resolve();
    }
  }

  private fail(error: Error): void {
    if (this._fatal) return;
    this._fatal = error;
    const waiters = this._flushWaiters.splice(0);
    for (const waiter of waiters) waiter.reject(error);
  }

  get sequence(): number {
    return this._sequence;
  }

  get fatal(): Error | null {
    return this._fatal;
  }
}
