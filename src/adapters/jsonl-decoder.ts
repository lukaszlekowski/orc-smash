export interface JsonlRecord {
  ordinal: number;
  value: unknown;
}

export type JsonlDiagnosticCode =
  | 'malformed_json'
  | 'oversized_record'
  | 'incomplete_final_record';

export interface JsonlDiagnostic {
  code: JsonlDiagnosticCode;
  ordinal: number;
  byteCount: number;
  id: string;
}

export interface JsonlPushResult {
  records: JsonlRecord[];
  diagnostics: JsonlDiagnostic[];
}

export interface JsonlFinishResult {
  records: JsonlRecord[];
  diagnostics: JsonlDiagnostic[];
}

export interface JsonlDecoderOptions {
  maxRecordLength?: number;
}

export class JsonlDecoder {
  private buffer = '';
  private ordinal = 0;
  private maxRecordLength: number;
  private discardingOversized = false;

  constructor(options?: JsonlDecoderOptions) {
    this.maxRecordLength = options?.maxRecordLength ?? 10 * 1024 * 1024;
  }

  public getBufferedLength(): number {
    return this.buffer.length;
  }

  public push(chunk: string): JsonlPushResult {
    const records: JsonlRecord[] = [];
    const diagnostics: JsonlDiagnostic[] = [];

    let input = chunk;

    while (input.length > 0) {
      if (this.discardingOversized) {
        const newlineIndex = input.indexOf('\n');
        if (newlineIndex !== -1) {
          input = input.slice(newlineIndex + 1);
          this.discardingOversized = false;
          this.buffer = '';
        } else {
          input = '';
        }
      } else {
        const newlineIndex = input.indexOf('\n');
        if (newlineIndex !== -1) {
          const segment = input.slice(0, newlineIndex);
          input = input.slice(newlineIndex + 1);
          let rawLine = this.buffer + segment;
          this.buffer = '';

          if (rawLine.endsWith('\r')) {
            rawLine = rawLine.slice(0, -1);
          }
          if (rawLine.trim().length === 0) {
            continue;
          }
          this.processLine(rawLine, records, diagnostics);
        } else {
          this.buffer += input;
          input = '';
          const currentBytes = Buffer.byteLength(this.buffer, 'utf8');
          if (currentBytes > this.maxRecordLength) {
            this.ordinal += 1;
            diagnostics.push({
              code: 'oversized_record',
              ordinal: this.ordinal,
              byteCount: currentBytes,
              id: `record-${this.ordinal}`,
            });
            this.buffer = '';
            this.discardingOversized = true;
          }
        }
      }
    }

    return { records, diagnostics };
  }

  public finish(): JsonlFinishResult {
    const records: JsonlRecord[] = [];
    const diagnostics: JsonlDiagnostic[] = [];

    if (this.discardingOversized) {
      this.buffer = '';
      this.discardingOversized = false;
      return { records, diagnostics };
    }

    let rawLine = this.buffer;
    this.buffer = '';

    if (rawLine.endsWith('\r')) {
      rawLine = rawLine.slice(0, -1);
    }

    if (rawLine.trim().length > 0) {
      const byteCount = Buffer.byteLength(rawLine, 'utf8');
      this.ordinal += 1;
      if (byteCount > this.maxRecordLength) {
        diagnostics.push({
          code: 'oversized_record',
          ordinal: this.ordinal,
          byteCount,
          id: `record-${this.ordinal}`,
        });
      } else {
        try {
          const value = JSON.parse(rawLine);
          records.push({ ordinal: this.ordinal, value });
        } catch {
          diagnostics.push({
            code: 'incomplete_final_record',
            ordinal: this.ordinal,
            byteCount,
            id: `record-${this.ordinal}`,
          });
        }
      }
    }

    return { records, diagnostics };
  }

  private processLine(rawLine: string, records: JsonlRecord[], diagnostics: JsonlDiagnostic[]): void {
    const byteCount = Buffer.byteLength(rawLine, 'utf8');
    this.ordinal += 1;

    if (byteCount > this.maxRecordLength) {
      diagnostics.push({
        code: 'oversized_record',
        ordinal: this.ordinal,
        byteCount,
        id: `record-${this.ordinal}`,
      });
      return;
    }

    try {
      const value = JSON.parse(rawLine);
      records.push({ ordinal: this.ordinal, value });
    } catch {
      diagnostics.push({
        code: 'malformed_json',
        ordinal: this.ordinal,
        byteCount,
        id: `record-${this.ordinal}`,
      });
    }
  }
}
