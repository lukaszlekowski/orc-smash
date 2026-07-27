import { describe, expect, it } from 'vitest';
import { JsonlDecoder } from '../src/adapters/jsonl-decoder.js';

describe('JsonlDecoder contract', () => {
  it('decodes single JSON line and retains correct ordinal', () => {
    const decoder = new JsonlDecoder();
    const res = decoder.push('{"type":"test","foo":"bar"}\n');
    expect(res.diagnostics).toHaveLength(0);
    expect(res.records).toHaveLength(1);
    expect(res.records[0]).toEqual({ ordinal: 1, value: { type: 'test', foo: 'bar' } });
  });

  it('handles line split across arbitrary chunks', () => {
    const decoder = new JsonlDecoder();
    const res1 = decoder.push('{"type":"tes');
    expect(res1.records).toHaveLength(0);
    const res2 = decoder.push('t","val":123}\n');
    expect(res2.records).toHaveLength(1);
    expect(res2.records[0]).toEqual({ ordinal: 1, value: { type: 'test', val: 123 } });
  });

  it('handles multiple events in one chunk preserving order', () => {
    const decoder = new JsonlDecoder();
    const res = decoder.push('{"id":1}\n{"id":2}\n{"id":3}\n');
    expect(res.diagnostics).toHaveLength(0);
    expect(res.records.map(r => r.value)).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(res.records.map(r => r.ordinal)).toEqual([1, 2, 3]);
  });

  it('handles CRLF, blank lines, and trailing spaces', () => {
    const decoder = new JsonlDecoder();
    const res = decoder.push('\r\n  \r\n{"a":1}\r\n\r\n{"b":2}\r\n');
    expect(res.diagnostics).toHaveLength(0);
    expect(res.records.map(r => r.value)).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('finish() parses valid final record without a trailing newline', () => {
    const decoder = new JsonlDecoder();
    decoder.push('{"final":true}');
    const finished = decoder.finish();
    expect(finished.diagnostics).toHaveLength(0);
    expect(finished.records).toHaveLength(1);
    expect(finished.records[0]).toEqual({ ordinal: 1, value: { final: true } });
  });

  it('finish() classifies incomplete final record as malformed diagnostic without leaking content', () => {
    const decoder = new JsonlDecoder();
    const SECRET = 'SECRET_TOKEN_SENTINEL_12345';
    const line = `{"incomplete":"${SECRET}"`;
    decoder.push(line);
    const finished = decoder.finish();
    expect(finished.records).toHaveLength(0);
    expect(finished.diagnostics).toHaveLength(1);
    expect(finished.diagnostics[0]).toEqual({
      code: 'incomplete_final_record',
      ordinal: 1,
      byteCount: Buffer.byteLength(line, 'utf8'),
      id: 'record-1'
    });
    // Ensure sensitive sentinel string is not in the diagnostic object
    expect(JSON.stringify(finished.diagnostics)).not.toContain(SECRET);
  });

  it('classifies malformed JSON lines as malformed_json diagnostic without leaking content', () => {
    const decoder = new JsonlDecoder();
    const SECRET = 'SECRET_API_KEY_9999';
    const badLine = `NOT_JSON_DATA_${SECRET}`;
    const res = decoder.push(`${badLine}\n{"valid":true}\n`);
    expect(res.records.map(r => r.value)).toEqual([{ valid: true }]);
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0]).toEqual({
      code: 'malformed_json',
      ordinal: 1,
      byteCount: Buffer.byteLength(badLine, 'utf8'),
      id: 'record-1'
    });
    expect(JSON.stringify(res.diagnostics)).not.toContain(SECRET);
  });

  it('classifies oversized record without parsing or leaking content', () => {
    const decoder = new JsonlDecoder({ maxRecordLength: 20 });
    const SECRET = 'SECRET_VERY_LONG_STRING_OVERSIZED';
    const res = decoder.push(`{"secret":"${SECRET}"}\n`);
    expect(res.records).toHaveLength(0);
    expect(res.diagnostics).toHaveLength(1);
    expect(res.diagnostics[0].code).toBe('oversized_record');
    expect(JSON.stringify(res.diagnostics)).not.toContain(SECRET);
  });

  it('enforces live memory bound during push across multiple chunks without newline, recovers after newline, and emits one diagnostic', () => {
    const decoder = new JsonlDecoder({ maxRecordLength: 20 });
    const chunk1 = '{"secret":"1234567890'; // 21 bytes
    const chunk2 = '12345678901234567890';
    const chunk3 = '1234567890"}\n{"valid":true}\n';

    const res1 = decoder.push(chunk1);
    expect(res1.records).toHaveLength(0);
    expect(res1.diagnostics).toHaveLength(1);
    expect(res1.diagnostics[0].code).toBe('oversized_record');
    expect(decoder.getBufferedLength()).toBe(0);

    const res2 = decoder.push(chunk2);
    expect(res2.records).toHaveLength(0);
    expect(res2.diagnostics).toHaveLength(0);
    expect(decoder.getBufferedLength()).toBe(0);

    const res3 = decoder.push(chunk3);
    expect(res3.diagnostics).toHaveLength(0);
    expect(res3.records).toHaveLength(1);
    expect(res3.records[0]).toEqual({ ordinal: 2, value: { valid: true } });
  });
});
