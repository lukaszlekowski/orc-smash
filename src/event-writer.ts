import type { Writable } from 'node:stream';
import type { RunEvent } from './run-event.js';

export class EventWriter {
  private _sequence = 0;
  private _queue: string[] = [];
  private _flushing = false;
  private _drainResolve: (() => void) | null = null;
  private _fatal: Error | null = null;

  constructor(private _stream: Writable) {}

  write(event: RunEvent, line: string): boolean {
    if (this._fatal) return false;
    this._sequence++;

    this._queue.push(line);

    const written = this._stream.write(`${line}\n`, 'utf-8', (err) => {
      if (err) {
        this._fatal = err;
      }
    });

    if (this._flushing && written) {
      this._tryDrain();
    }

    return written;
  }

  flush(): Promise<void> {
    if (this._fatal) return Promise.reject(this._fatal);

    if (this._queue.length === 0) {
      return new Promise((resolve, reject) => {
        const check = () => {
          const written = this._stream.write('', 'utf-8', (err) => {
            if (err) { reject(err); return; }
            resolve();
          });
          if (!written) {
            this._stream.once('drain', check);
          }
        };
        this._stream.once('drain', check);
        if (this._stream.write('', 'utf-8', (err) => {
          if (err) { reject(err); return; }
          resolve();
        })) {
          resolve();
        }
      });
    }

    this._flushing = true;
    return new Promise((resolve, reject) => {
      this._drainResolve = () => {
        if (this._fatal) {
          reject(this._fatal);
        } else {
          resolve();
        }
        this._flushing = false;
        this._drainResolve = null;
      };
      this._tryDrain();
    });
  }

  private _tryDrain(): void {
    if (this._queue.length === 0 && this._drainResolve) {
      this._drainResolve();
    }
  }

  get fatal(): Error | null {
    return this._fatal;
  }
}
