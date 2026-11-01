import { describe, expect, it } from 'vitest';
import { canonicalize, parseEnvelope, ProtocolError, utf8Bytes, validateEvent } from '../index.js';

function event() {
  return {
    id: '44bf94dc-17a7-4462-9528-dd16b4978cad',
    occurred_at: '2026-11-01T02:00:00.000Z',
    kind: 'event',
    name: 'model_viewed',
    properties: { model_id: 'example' },
  };
}
function envelope() {
  return {
    schema_version: '1',
    project_key: 'pub_example',
    environment: 'production',
    service: 'web',
    release: '1',
    build_id: 'web-1',
    events: [event()],
  };
}
function code(action: () => unknown, expected: string) {
  try {
    action();
    throw new Error('Expected rejection');
  } catch (error) {
    expect(error).toBeInstanceOf(ProtocolError);
    expect((error as ProtocolError).code).toBe(expected);
  }
}

describe('protocol v1', () => {
  it('copies valid envelopes and binds the credential source', () => {
    const input = envelope();
    const result = parseEnvelope(input, 'browser');
    input.events[0].properties.model_id = 'mutated';
    expect(result.events[0].properties.model_id).toBe('example');
    code(() => parseEnvelope(input, 'server'), 'invalid_request');
    const { project_key: _key, ...server } = input;
    expect(parseEnvelope(server, 'server').project_key).toBeUndefined();
    code(() => parseEnvelope(server, 'browser'), 'invalid_request');
  });
  it('rejects unknown fields at every structure boundary', () => {
    code(() => parseEnvelope({ ...envelope(), source: 'server' }, 'browser'), 'invalid_request');
    code(
      () => validateEvent({ ...event(), context: { user_id: 'user', cookie: 'private' } }),
      'invalid_event',
    );
    code(
      () =>
        validateEvent({
          ...event(),
          kind: 'error',
          error: {
            type: 'Error',
            mechanism: 'manual',
            handled: true,
            frames: [],
            message: 'private',
          },
        }),
      'invalid_event',
    );
    code(
      () =>
        validateEvent({
          ...event(),
          kind: 'error',
          error: {
            type: 'Error',
            mechanism: 'manual',
            handled: true,
            frames: [{ file: '/app.js', arguments: [] }],
          },
        }),
      'invalid_event',
    );
  });
  it('enforces multibyte strings, finite safe values, names and dates', () => {
    expect(utf8Bytes('汉😀')).toBe(7);
    expect(
      validateEvent({ ...event(), properties: { value: '汉'.repeat(85) } }).properties.value,
    ).toHaveLength(85);
    code(
      () => validateEvent({ ...event(), properties: { value: '汉'.repeat(86) } }),
      'invalid_event',
    );
    for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, {}, []])
      code(
        () => validateEvent({ ...event(), properties: { value } }),
        typeof value === 'number' ? 'invalid_request' : 'invalid_event',
      );
    code(
      () => validateEvent({ ...event(), occurred_at: '2026-02-30T00:00:00.000Z' }),
      'invalid_event',
    );
    code(() => validateEvent({ ...event(), name: 'Model Viewed' }), 'invalid_event');
  });
  it('rejects duplicate identities, schema versions, large properties and batches', () => {
    code(
      () => parseEnvelope({ ...envelope(), events: [event(), event()] }, 'browser'),
      'invalid_event',
    );
    code(
      () => parseEnvelope({ ...envelope(), schema_version: '2' }, 'browser'),
      'unsupported_schema',
    );
    code(
      () =>
        validateEvent({
          ...event(),
          properties: Object.fromEntries(
            Array.from({ length: 33 }, (_, index) => [`p${index}`, true]),
          ),
        }),
      'invalid_event',
    );
    code(
      () =>
        validateEvent({
          ...event(),
          properties: Object.fromEntries(
            Array.from({ length: 9 }, (_, index) => [`p${index}`, 'x'.repeat(256)]),
          ),
        }),
      'invalid_event',
    );
    code(
      () =>
        parseEnvelope(
          { ...envelope(), events: Array.from({ length: 21 }, () => event()) },
          'browser',
        ),
      'invalid_request',
    );
  });
  it('enforces error kind, frame coordinates and event/batch JSON byte limits', () => {
    const error = {
      type: 'Error',
      mechanism: 'manual',
      handled: true,
      frames: [{ file: '/app.js', line: 1, column: 0 }],
    };
    expect(validateEvent({ ...event(), kind: 'error', error }).error?.frames[0].column).toBe(0);
    code(() => validateEvent({ ...event(), error }), 'invalid_event');
    code(() => validateEvent({ ...event(), kind: 'error' }), 'invalid_event');
    code(
      () =>
        validateEvent({
          ...event(),
          kind: 'error',
          error: { ...error, frames: [{ file: '/app.js', line: 0 }] },
        }),
      'invalid_event',
    );
    code(
      () =>
        validateEvent({
          ...event(),
          kind: 'error',
          error: {
            ...error,
            frames: Array.from({ length: 30 }, () => ({ file: 'f'.repeat(512) })),
          },
        }),
      'payload_too_large',
    );
    const events = Array.from({ length: 20 }, (_, index) => ({
      ...event(),
      id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      properties: Object.fromEntries(
        Array.from({ length: 7 }, (_, key) => [`p${key}`, 'x'.repeat(256)]),
      ),
    }));
    code(() => parseEnvelope({ ...envelope(), events }, 'browser'), 'payload_too_large');
  });
  it('rejects __proto__ properties instead of acknowledging a silently changed event', () => {
    code(
      () => validateEvent({ ...event(), properties: JSON.parse('{"__proto__":"private"}') }),
      'invalid_event',
    );
  });
  it('canonicalizes independently of key insertion order without invoking accessors', () => {
    expect(canonicalize({ z: [true, null, '汉'], a: { y: 2, x: 1 } })).toBe(
      '{"a":{"x":1,"y":2},"z":[true,null,"汉"]}',
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    code(() => canonicalize(cycle), 'invalid_request');
    let read = false;
    const getter = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get() {
        read = true;
        throw new Error('private');
      },
    });
    code(() => canonicalize(getter), 'invalid_request');
    expect(read).toBe(false);
    code(
      () =>
        canonicalize(
          new Proxy(
            {},
            {
              ownKeys() {
                throw new Error('private');
              },
            },
          ),
        ),
      'invalid_request',
    );
    for (const input of [undefined, () => 1, 1n, new Date(), Array(2)])
      code(() => canonicalize(input), 'invalid_request');
  });
});
