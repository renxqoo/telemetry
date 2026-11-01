import { validateEvent, parseEnvelope } from '../../index.js';
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  decodeTraces,
  decimal,
  decodeTraceResponse,
  encodeTraceResponse,
  encodeTraceStatus,
  TraceDecodeError,
} from '../codec.js';
import { projectSpan, ruleAllows } from '../policy.js';
import { emptyTracePolicy, traceDefaults } from '../types.js';
import { parseTraceJson } from '../json.js';
const golden = readFileSync('tests/support/trace/golden.json', 'utf8');
const decode = (text = golden) => decodeTraces(new TextEncoder().encode(text), false);
const request = () =>
  JSON.parse(golden) as {
    resourceSpans: {
      resource: { attributes: object[] };
      scopeSpans: { scope: { name: string }; spans: Record<string, unknown>[] }[];
    }[];
  };
function changed(update: (span: Record<string, unknown>) => void) {
  const value = request();
  update(value.resourceSpans[0].scopeSpans[0].spans[0]);
  return JSON.stringify(value);
}
it('accepts legacy event trace IDs while requiring a valid paired span reference', () => {
  const event = {
    id: '77abe2c3-69cb-4830-9b4e-6521d7c64fe8',
    occurred_at: '2026-11-01T00:00:00.000Z',
    kind: 'event',
    name: 'linked',
    properties: {},
    context: { trace_id: 'legacy-text' },
  };
  expect(validateEvent(event).context?.trace_id).toBe('legacy-text');
  expect(() =>
    validateEvent({ ...event, context: { trace_id: 'legacy-text', span_id: '1'.repeat(16) } }),
  ).toThrow();
  const linked = { ...event, context: { trace_id: 'A'.repeat(32), span_id: 'B'.repeat(16) } };
  expect(validateEvent(linked).context).toEqual({
    trace_id: 'a'.repeat(32),
    span_id: 'b'.repeat(16),
  });
  const envelope = {
    schema_version: '1',
    environment: 'test',
    service: 'web',
    release: '1',
    build_id: '1',
    events: [linked],
  };
  expect(parseEnvelope(envelope, 'server').events[0].context?.span_id).toBe('b'.repeat(16));
});
describe('OTLP decoding with independent field expectations', () => {
  it.each([false, true])(
    'preserves independent nanosecond, signed integer, flags and ID values for binary=%s',
    (binary) => {
      const result = decodeTraces(
        readFileSync(`tests/support/trace/golden.${binary ? 'bin' : 'json'}`),
        binary,
      );
      expect(result.total).toBe(1);
      expect(result.rejected).toBe(0);
      expect(result.candidates[0]).toMatchObject({
        service: 'web',
        span: {
          trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
          span_id: '00f067aa0ba902b7',
          start_time_unix_nano: '1793491200000000000',
          end_time_unix_nano: '1793491200123456789',
          duration_ns: '123456789',
          flags: 257,
          kind: 2,
          status: { code: 1 },
          attributes: [{ key: 'count', value: { type: 'int', value: '-9223372036854775808' } }],
        },
      });
    },
  );
  it.each([false, true])(
    'decodes independently authored all-value fixtures for binary=%s',
    (binary) => {
      const result = decodeTraces(
        readFileSync(`tests/support/trace/values.${binary ? 'bin' : 'json'}`),
        binary,
      );
      expect(result.rejected).toBe(0);
      const span = result.candidates[0].span;
      expect(span.end_time_unix_nano).toBe('18446744073709551615');
      expect(span.duration_ns).toBe('18446744073709551614');
      expect(span.attributes.map((a) => a.value)).toEqual([
        { type: 'string', value: 'safe' },
        { type: 'bool', value: true },
        { type: 'int', value: '9223372036854775807' },
        { type: 'double', value: 'NaN' },
        { type: 'bytes', value: 'AP8=' },
        { type: 'array', value: [{ type: 'int', value: '-1' }] },
        { type: 'kvlist', value: [{ key: 'child', value: { type: 'bool', value: false } }] },
        { type: 'empty' },
      ]);
      expect(span.events[0]).toMatchObject({ time_unix_nano: '0', dropped_attributes_count: 3 });
      expect(span.links[0].flags).toBe(4294967295);
    },
  );
  it('distinguishes binary64 JSON numbers from exact decimal strings', () => {
    expect(
      decode(golden.replace('"1793491200123456789"', '1793491200123456789')).candidates[0].span
        .end_time_unix_nano,
    ).toBe('1793491200123456768');
    expect(decimal('18446744073709551615')).toBe('18446744073709551615');
    expect(() => decimal(Number('18446744073709551615'))).toThrow();
    expect(decimal('1.23e3')).toBe('1230');
    expect(() => decimal('1.01')).toThrow();
    expect(() => decimal('-9223372036854775809', true)).toThrow();
  });
  it.each([
    '{"resourceSpans":[],"resourceSpans":[]}',
    '{"resourceSpans":[null]}',
    '{"resourceSpans":{}}',
    '{"resourceSpans":[],}',
    '[1]',
    '{"a":NaN}',
  ])('rejects invalid shape or duplicate JSON keys: %s', (text) =>
    expect(() => decode(text)).toThrow(TraceDecodeError),
  );
  it('ignores unknown fields and snake_case while rejecting enum names and malformed oneof', () => {
    expect(decode('{"resource_spans":[]}').total).toBe(0);
    expect(
      decode(
        changed((span) => {
          span.unknown = { secret: 'private' };
        }),
      ).candidates,
    ).toEqual(decode().candidates);
    expect(() =>
      decode(
        changed((span) => {
          span.kind = 'SPAN_KIND_SERVER';
        }),
      ),
    ).toThrow();
    expect(() =>
      decode(
        changed((span) => {
          span.attributes = [{ key: 'x', value: { stringValue: 'x', boolValue: true } }];
        }),
      ),
    ).toThrow();
  });
  it.each([
    { spanId: '0000000000000000' },
    { traceId: 'S/k vNXezTaa jzpKdDg5HNg==' },
    { name: '' },
    { startTimeUnixNano: '0' },
    { endTimeUnixNano: '1' },
    { parentSpanId: '00f067aa0ba902b7' },
  ])('permanently rejects individual semantic errors: %j', (fields) => {
    const result = decode(changed((span) => Object.assign(span, fields)));
    expect(result.total).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.candidates).toEqual([]);
  });
  it('normalizes every AnyValue variant including nested and unset values', () => {
    const values = [
      {},
      { boolValue: false },
      { bytesValue: 'AQI=' },
      { doubleValue: 'NaN' },
      { arrayValue: { values: [{ intValue: '1000' }] } },
      { kvlistValue: { values: [{ key: 'nested', value: { stringValue: 'ok' } }] } },
    ];
    const result = decode(
      changed((span) => {
        span.attributes = values.map((value, index) => ({ key: `v${index}`, value }));
      }),
    );
    expect(result.candidates[0].span.attributes.map((a) => a.value)).toEqual([
      { type: 'empty' },
      { type: 'bool', value: false },
      { type: 'bytes', value: 'AQI=' },
      { type: 'double', value: 'NaN' },
      { type: 'array', value: [{ type: 'int', value: '1000' }] },
      { type: 'kvlist', value: [{ key: 'nested', value: { type: 'string', value: 'ok' } }] },
    ]);
  });
  it('enforces count, key, value, recursion and input byte budgets', () => {
    expect(() =>
      decodeTraces(new TextEncoder().encode(golden), false, { ...traceDefaults, body_bytes: 1 }),
    ).toThrow();
    expect(
      decodeTraces(new TextEncoder().encode(golden), false, {
        ...traceDefaults,
        max_attribute_key_bytes: 3,
      }).rejected,
    ).toBe(1);
    expect(() => parseTraceJson('['.repeat(66) + '0' + ']'.repeat(66))).toThrow();
  });
  it('applies explicit privacy rules without rewriting upstream dropped counts', () => {
    const span = decode(
      changed((span) => {
        span.traceState = 'vendor=private';
        span.droppedAttributesCount = 9;
        span.events = [
          {
            name: 'private-event',
            timeUnixNano: '123',
            attributes: [{ key: 'secret', value: { stringValue: 'private' } }],
          },
        ];
        span.links = [
          { traceId: '1'.repeat(32), spanId: '1'.repeat(16), traceState: 'vendor=private' },
        ];
        span.status = { code: 2, message: 'private' };
      }),
    ).candidates[0].span;
    const projected = projectSpan(span, structuredClone(emptyTracePolicy));
    expect(projected.name).toBe('span');
    expect(projected.status.message).toBe('');
    expect(projected.trace_state).toBe('');
    expect(projected.events[0].name).toBe('event');
    expect(projected.links[0].trace_state).toBe('');
    expect(projected.dropped_attributes_count).toBe(9);
    expect(JSON.stringify(projected)).not.toContain('private');
    expect(projected.collector_dropped.span_attributes).toBe(1);
    expect(ruleAllows({ type: 'int', value: '99' }, { type: 'int', min: '100' })).toBe(false);
    expect(ruleAllows({ type: 'double', value: 'NaN' }, { type: 'double', finite: true })).toBe(
      false,
    );
    expect(
      ruleAllows(
        { type: 'array', value: [{ type: 'bool', value: true }] },
        { type: 'array', max_items: 1, items: { type: 'bool' } },
      ),
    ).toBe(true);
  });
  it('regression: overflowing binary varints cannot truncate into valid int64 or empty requests', () => {
    const binary = readFileSync('tests/support/trace/golden.bin');
    const pattern = Buffer.from([24, ...Array(9).fill(128), 1]);
    const at = binary.indexOf(pattern);
    expect(at).toBeGreaterThan(0);
    const invalid = Buffer.from(binary);
    invalid[at + 10] = 3;
    expect(() => decodeTraces(invalid, true)).toThrow(TraceDecodeError);
    expect(() => decodeTraces(Uint8Array.from([16, ...Array(9).fill(255), 2]), true)).toThrow(
      TraceDecodeError,
    );
  });
  it('regression: equivalent base64 bytes normalize before identity digesting', () => {
    const first = decode(
      changed((span) => {
        span.attributes = [{ key: 'bytes', value: { bytesValue: 'AA==' } }];
      }),
    ).candidates[0].span;
    const second = decode(
      changed((span) => {
        span.attributes = [{ key: 'bytes', value: { bytesValue: 'AB==' } }];
      }),
    ).candidates[0].span;
    expect(first.attributes).toEqual([{ key: 'bytes', value: { type: 'bytes', value: 'AA==' } }]);
    expect(second.attributes).toEqual(first.attributes);
  });
  it('rejects non-JSON whitespace and malformed binary success responses', () => {
    for (const input of ['\u00a0{}', '\u000b{}']) {
      expect(() => parseTraceJson(input)).toThrow();
      expect(() => decodeTraceResponse(new TextEncoder().encode(input), false, 1)).toThrow();
    }
    expect(() =>
      decodeTraceResponse(Uint8Array.from([10, 11, 8, ...Array(9).fill(128), 2]), true, 1),
    ).toThrow();
    expect(() => decodeTraceResponse(Uint8Array.from([10, 3, 18, 1, 255]), true, 1)).toThrow();
  });
  it('uses official empty success and Status wire encodings and validates partial counts', () => {
    expect([...(encodeTraceResponse(true) as Uint8Array)]).toEqual([]);
    expect(encodeTraceResponse(false)).toEqual({});
    expect([...(encodeTraceStatus(true, 14, 'x') as Uint8Array)]).toEqual([8, 14, 18, 1, 120]);
    expect(
      decodeTraceResponse(
        new TextEncoder().encode('{"partialSuccess":{"rejectedSpans":"1"}}'),
        false,
        2,
      ),
    ).toBe(1);
    expect(() =>
      decodeTraceResponse(
        new TextEncoder().encode('{"partialSuccess":{"rejectedSpans":"3"}}'),
        false,
        2,
      ),
    ).toThrow();
  });
});
