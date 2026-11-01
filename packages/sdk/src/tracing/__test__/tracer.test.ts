import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { decodeTraces, type DecodedTraces } from '../../../../protocol/src/traces/codec.js';
import {
  createTracer,
  extractTraceContext,
  injectTraceContext,
  type Tracer,
  type TracerOptions,
  type SpanContext,
} from '../server.js';
const tracers: Tracer[] = [];
const options = (extra: Partial<TracerOptions> = {}): TracerOptions => ({
  endpoints: ['http://127.0.0.1:4320'],
  environment: 'test',
  service: 'web',
  writeToken: 'writer.' + 's'.repeat(32),
  sampleRate: 1,
  transport: async () => Response.json({}),
  ...extra,
});
function tracer(extra: Partial<TracerOptions> = {}) {
  const value = createTracer(options(extra));
  tracers.push(value);
  return value;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T00:00:00.000Z'));
});
afterEach(async () => {
  for (const t of tracers.splice(0)) {
    const closing = t.close({ timeoutMs: 1 });
    await vi.advanceTimersByTimeAsync(2);
    await closing;
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function finish(t: Tracer, timeoutMs = 1000) {
  const result = t.flush({ timeoutMs });
  await vi.advanceTimersByTimeAsync(timeoutMs);
  return result;
}
const context: SpanContext = {
  traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
  spanId: '00f067aa0ba902b7',
  traceFlags: 1,
  traceState: 'vendor=safe,private=token',
  isRemote: true,
};
describe('tracing context and recording', () => {
  it('isolates concurrent async requests and tracer instances while preserving parentage', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({}));
    const a = tracer({ transport }),
      b = tracer();
    await Promise.all(
      ['first', 'second'].map(async (name) =>
        a.withSpan({ name, parent: null }, async (parent) => {
          await Promise.resolve();
          expect(a.currentContext()).toEqual(parent.context);
          expect(b.currentContext()).toBeUndefined();
          await a.withSpan({ name: 'child' }, async (child) => {
            expect(child.context.traceId).toBe(parent.context.traceId);
            expect(child.context.spanId).not.toBe(parent.context.spanId);
            await Promise.resolve();
            expect(a.currentContext()).toEqual(child.context);
          });
          expect(a.currentContext()).toEqual(parent.context);
        }),
      ),
    );
    expect(a.currentContext()).toBeUndefined();
    expect((await finish(a)).confirmedSpans).toBe(4);
    const body = JSON.parse(transport.mock.calls[0][1]?.body as string);
    const spans = body.resourceSpans[0].scopeSpans[0].spans as {
      name: string;
      traceId: string;
      spanId: string;
      parentSpanId: string;
    }[];
    for (const child of spans.filter((s) => s.name === 'child'))
      expect(spans.find((s) => s.spanId === child.parentSpanId)?.traceId).toBe(child.traceId);
  });
  it('rethrows the same exception and exports ERROR without exception secrets', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({}));
    const t = tracer({ transport });
    const failure = new Error('private-token');
    await expect(
      t.withSpan({ name: 'work' }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect((await finish(t)).confirmedSpans).toBe(1);
    const text = transport.mock.calls[0][1]?.body as string;
    expect(text).not.toContain('private-token');
    expect(JSON.parse(text).resourceSpans[0].scopeSpans[0].spans[0].status.code).toBe(2);
  });
  it('keeps monotonic durations, end idempotency and capture-time attributes', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({}));
    const t = tracer({ transport });
    const value = { type: 'string' as const, value: 'original' };
    const span = t.startSpan({ name: 'work', attributes: [{ key: 'safe', value }] });
    value.value = 'mutated';
    await vi.advanceTimersByTimeAsync(20);
    vi.setSystemTime(new Date('2000-01-01'));
    span.end();
    span.setAttribute('safe', { type: 'string', value: 'late' });
    span.end();
    expect((await finish(t)).confirmedSpans).toBe(1);
    const wire = JSON.parse(transport.mock.calls[0][1]?.body as string).resourceSpans[0]
      .scopeSpans[0].spans[0];
    expect(BigInt(wire.endTimeUnixNano) - BigInt(wire.startTimeUnixNano)).toBe(20000000n);
    expect(wire.attributes).toEqual([{ key: 'safe', value: { stringValue: 'original' } }]);
  });
  it('creates propagatable unsampled contexts and obeys parent sampling across local rates', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({}));
    const t = tracer({ transport, sampleRate: 0 });
    const root = t.startSpan({ name: 'root' });
    expect(root.context.traceFlags & 1).toBe(0);
    root.end();
    t.startSpan({ name: 'inherited', parent: context }).end();
    expect((await finish(t)).confirmedSpans).toBe(1);
    const full = tracer({ transport, sampleRate: 1 });
    full.startSpan({ name: 'unsampled', parent: { ...context, traceFlags: 0 } }).end();
    expect((await finish(full)).confirmedSpans).toBe(0);
  });
  it('bounds active spans, recursive values and incremental attributes/events then releases capacity', async () => {
    const t = tracer({ limits: { maxActiveSpans: 1, maxAttributes: 2, maxEvents: 1 } });
    const first = t.startSpan({ name: 'first' });
    t.startSpan({ name: 'overflow' }).end();
    first.setAttribute('one', { type: 'bool', value: true });
    first.setAttribute('two', { type: 'bool', value: false });
    first.setAttribute('three', { type: 'bool', value: true });
    first.addEvent('event');
    first.addEvent('overflow');
    const cyclic = { type: 'array' as const, value: [] as never[] };
    cyclic.value.push(cyclic as never);
    first.setAttribute('bad', cyclic);
    first.end();
    expect(t.getDiagnostics().activeSpans).toBe(0);
    expect(t.getDiagnostics().recordingBytes).toBe(0);
    t.startSpan({ name: 'next' }).end();
    expect((await finish(t)).confirmedSpans).toBe(2);
    expect(t.getDiagnostics().counts).toMatchObject({
      active_limit: 1,
      invalid_attributes: 2,
      invalid_events: 1,
    });
  });
  it.each([
    'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    '00-' + '0'.repeat(32) + '-00f067aa0ba902b7-01',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra',
    '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01',
  ])('rejects invalid W3C traceparent %s', (traceparent) =>
    expect(extractTraceContext({ traceparent })).toBeUndefined(),
  );
  it('handles W3C future versions and removes unsafe tracestate on extraction and injection', () => {
    const rules = { vendor: { safe_values: ['safe'], max_value_bytes: 4 } };
    const headers = {
      traceparent: '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-ff-extra',
      tracestate: ['vendor=safe', 'private=token'],
    };
    expect(extractTraceContext(headers)?.traceState).toBe('');
    const parent = extractTraceContext(headers, { traceStateRules: rules })!;
    expect(parent.traceState).toBe('vendor=safe');
    expect(injectTraceContext(parent, { traceStateRules: rules })).toEqual({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      tracestate: 'vendor=safe',
    });
    expect(
      injectTraceContext({ ...parent, traceState: 'vendor=private' }, { traceStateRules: rules }),
    ).not.toHaveProperty('tracestate');
    expect(extractTraceContext({ traceparent: ['x', 'y'] })).toBeUndefined();
  });
  it.each(['headers', 'joined', 'mixed-case', 'array'])(
    'regression: a future traceparent extension must not accept multiple values from %s',
    (representation) => {
      const first = '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra';
      const second = '00-11111111111111111111111111111111-1111111111111111-01';
      let headers: Headers | Record<string, string | string[]>;
      if (representation === 'headers') {
        headers = new Headers();
        headers.append('traceparent', first);
        headers.append('traceparent', second);
      } else if (representation === 'joined') headers = { traceparent: `${first}, ${second}` };
      else if (representation === 'mixed-case')
        headers = { traceparent: first, Traceparent: second };
      else headers = { traceparent: [first, second] };
      expect(extractTraceContext(headers)).toBeUndefined();
    },
  );
  it('regression: invalid tracestate must not erase valid propagation or parentage', async () => {
    const invalidState = { ...context, traceState: 'invalid tracestate' };
    expect(injectTraceContext(invalidState)).toEqual({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });
    expect(injectTraceContext({ ...invalidState, traceId: '0'.repeat(32) })).toEqual({});
    let decoded: DecodedTraces | undefined;
    const t = tracer({
      transport: async (_url, init) => {
        decoded = decodeTraces(new TextEncoder().encode(init!.body as string), false);
        return Response.json({});
      },
    });
    const child = t.startSpan({
      name: 'child',
      parent: invalidState,
      links: [
        {
          trace_id: context.traceId,
          span_id: context.spanId,
          trace_state: invalidState.traceState,
          flags: 1,
          attributes: [],
          dropped_attributes_count: 0,
        },
      ],
    });
    expect(child.context).toMatchObject({ traceId: context.traceId, traceState: '' });
    child.end();
    expect((await finish(t)).confirmedSpans).toBe(1);
    expect(decoded?.candidates[0]?.span).toMatchObject({
      parent_span_id: context.spanId,
      links: [{ trace_id: context.traceId, span_id: context.spanId, trace_state: '' }],
    });
  });
  it.each([
    [NaN, 'NaN'],
    [Infinity, 'Infinity'],
    [-Infinity, '-Infinity'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['-Infinity', '-Infinity'],
    [1.5, 1.5],
  ] as const)(
    'regression: double %s must survive JSON export without becoming empty',
    async (input, expected) => {
      let decoded: DecodedTraces | undefined;
      const t = tracer({
        transport: async (_url, init) => {
          decoded = decodeTraces(new TextEncoder().encode(init!.body as string), false);
          return Response.json({});
        },
      });
      t.startSpan({
        name: 'numeric',
        attributes: [{ key: 'ratio', value: { type: 'double', value: input } }],
      }).end();
      expect((await finish(t)).confirmedSpans).toBe(1);
      expect(decoded?.rejected).toBe(0);
      expect(decoded?.candidates[0]?.span.attributes).toEqual([
        { key: 'ratio', value: { type: 'double', value: expected } },
      ]);
    },
  );
  it.each([127, 128])(
    'regression: %s user resource attributes must not produce permanently rejected spans',
    (length) => {
      expect(() =>
        tracer({
          resourceAttributes: Array.from({ length }, (_, index) => ({
            key: `a${index}`,
            value: { type: 'bool', value: true },
          })),
        }),
      ).toThrow();
    },
  );
  it('keeps 126 user resource attributes within the Collector limit including system attributes', async () => {
    let decoded: DecodedTraces | undefined;
    const t = tracer({
      resourceAttributes: Array.from({ length: 126 }, (_, index) => ({
        key: `a${index}`,
        value: { type: 'bool', value: true },
      })),
      transport: async (_url, init) => {
        decoded = decodeTraces(new TextEncoder().encode(init!.body as string), false);
        return Response.json({ partialSuccess: { rejectedSpans: String(decoded.rejected) } });
      },
    });
    t.startSpan({ name: 'resource' }).end();
    expect((await finish(t)).confirmedSpans).toBe(1);
    expect(decoded?.candidates[0]?.span.resource.attributes).toHaveLength(128);
    expect(decoded?.candidates[0]?.span.resource.attributes).toContainEqual({
      key: 'a125',
      value: { type: 'bool', value: true },
    });
  });
  it('regression: system resource attributes must participate in initialization node and count budgets', () => {
    expect(() => tracer({ limits: { maxAttributes: 1 } })).toThrow();
    expect(() =>
      tracer({
        limits: { maxValueNodes: 3 },
        resourceAttributes: [{ key: 'a', value: { type: 'bool', value: true } }],
        scope: {
          name: 'manual',
          attributes: [{ key: 'b', value: { type: 'bool', value: false } }],
        },
      }),
    ).toThrow();
  });
  it('rejects invalid configured tracestate syntax while tolerating invalid incoming tracestate', () => {
    expect(() =>
      tracer({ traceStateRules: { 'invalid key': { safe_values: ['safe'], max_value_bytes: 4 } } }),
    ).toThrow();
    expect(() =>
      tracer({
        traceStateRules: { vendor: { safe_values: ['invalid=value'], max_value_bytes: 32 } },
      }),
    ).toThrow();
  });
  it('keeps active and post-close async callbacks isolated until their completion', async () => {
    const t = tracer({ sampleRate: 0 });
    let resume: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const pending = t.withSpan({ name: 'active' }, async (span) => {
      await gate;
      expect(t.currentContext()).toEqual(span.context);
      expect(t.withSpan({ name: 'nested' }, (child) => child.context.traceId)).toBe(
        span.context.traceId,
      );
      expect(t.currentContext()).toEqual(span.context);
    });
    await t.close();
    const late = t.withSpan({ name: 'late' }, async (span) => {
      await Promise.resolve();
      expect(t.currentContext()).toEqual(span.context);
      expect(t.withSpan({ name: 'nested-late' }, (child) => child.context.traceId)).toBe(
        span.context.traceId,
      );
      return 'complete';
    });
    resume();
    await pending;
    expect(await late).toBe('complete');
    expect(t.currentContext()).toBeUndefined();
    expect(t.getDiagnostics()).toMatchObject({ closed: true, activeSpans: 0, queuedSpans: 0 });
  });
  it('regression: oversized initial links are rejected before traversing all attribute values', async () => {
    let reads = 0;
    const value = {
      type: 'string' as const,
      get value() {
        reads++;
        return 'x'.repeat(4096);
      },
    };
    const attributes = Array.from({ length: 128 }, (_, i) => ({ key: `k${i}`, value }));
    const links = Array.from({ length: 128 }, () => ({
      trace_id: '1'.repeat(32),
      span_id: '1'.repeat(16),
      trace_state: '',
      flags: 1,
      attributes,
      dropped_attributes_count: 0,
    }));
    const t = tracer({ limits: { maxSpanBytes: 4096 } });
    t.startSpan({ name: 'bounded', links }).end();
    expect(reads).toBeLessThan(1000);
    expect(t.getDiagnostics().recordingBytes).toBe(0);
    expect((await finish(t)).confirmedSpans).toBe(1);
  });
  it('validates initialization and per-call timeout before starting work', () => {
    expect(() => createTracer(options({ endpoints: ['http://remote.example'] }))).toThrow();
    expect(() => createTracer(options({ sampleRate: NaN }))).toThrow();
    expect(() =>
      createTracer(options({ service: 'x'.repeat(33), environment: 'x'.repeat(33) })),
    ).toThrow();
    expect(() => createTracer(options({ limits: { queueBytes: 1 } }))).toThrow();
    const t = tracer();
    for (const timeoutMs of [0, -1, 0.5, 30001, Infinity])
      expect(() => t.flush({ timeoutMs })).toThrow();
  });
});
describe('export snapshot accounting', () => {
  it.each([{ maxAttempts: 1 }, { retryBudgetMs: 100 }])(
    'regression: terminating a throttled batch must not release later spans before Retry-After: %j',
    async (limits) => {
      const transport = vi.fn<typeof fetch>(async (): Promise<Response> =>
        transport.mock.calls.length === 1
          ? Response.json({}, { status: 429, headers: { 'Retry-After': '1' } })
          : Response.json({}),
      );
      const t = tracer({
        endpoints: ['http://127.0.0.1:4320', 'http://127.0.0.1:4321'],
        transport,
        limits: { ...limits, batchSize: 1 },
      });
      t.startSpan({ name: 'A' }).end();
      t.startSpan({ name: 'B' }).end();
      const first = t.flush({ timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(1);
      expect(transport).toHaveBeenCalledTimes(1);
      t.startSpan({ name: 'C' }).end();
      const second = t.flush({ timeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      expect(await first).toMatchObject({ droppedSpans: 1, pendingSpans: 1, timedOut: true });
      expect(await second).toMatchObject({ droppedSpans: 0, pendingSpans: 2, timedOut: true });
      await vi.advanceTimersByTimeAsync(988);
      expect(transport).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport).toHaveBeenCalledTimes(3);
      expect(
        transport.mock.calls.map(([url]) =>
          typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        ),
      ).toEqual([
        'http://127.0.0.1:4320/v1/traces',
        'http://127.0.0.1:4320/v1/traces',
        'http://127.0.0.1:4320/v1/traces',
      ]);
      expect(t.getDiagnostics()).toMatchObject({ queuedSpans: 0, counts: { confirmed: 2 } });
    },
  );
  it('regression: continuous span arrivals must not starve automatic export or fill a healthy queue', async () => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({}));
    const t = tracer({ transport, limits: { flushIntervalMs: 100, queueCapacity: 5 } });
    for (let index = 0; index < 20; index++) {
      t.startSpan({ name: 'continuous' }).end();
      await vi.advanceTimersByTimeAsync(20);
    }
    await vi.advanceTimersByTimeAsync(100);
    expect(t.getDiagnostics().counts.confirmed).toBe(20);
    expect(t.getDiagnostics().counts.queue_full ?? 0).toBe(0);
    expect(t.getDiagnostics().queuedSpans).toBe(0);
    expect(transport.mock.calls.length).toBeGreaterThan(1);
  });
  it('reports a successful snapshot once and returns an immutable empty subsequent result', async () => {
    const t = tracer();
    t.startSpan({ name: 'A' }).end();
    expect(await finish(t)).toEqual({
      confirmedSpans: 1,
      rejectedSpans: 0,
      unconfirmedSpans: 0,
      pendingSpans: 0,
      droppedSpans: 0,
      timedOut: false,
    });
    const empty = await finish(t);
    expect(empty.confirmedSpans).toBe(0);
    expect(Object.isFrozen(empty)).toBe(true);
  });
  it('retries the same body after an unknown result and counts one confirmation', async () => {
    const transport = vi.fn<typeof fetch>(async () => {
      if (transport.mock.calls.length === 1) throw new Error('lost');
      return Response.json({});
    });
    const t = tracer({ transport, limits: { retryBaseMs: 1 } });
    t.startSpan({ name: 'A' }).end();
    const result = await finish(t);
    expect(result.confirmedSpans).toBe(1);
    expect(result.unconfirmedSpans).toBe(0);
    expect(transport.mock.calls[0][1]?.body).toBe(transport.mock.calls[1][1]?.body);
  });
  it('does not mutate an expired flush result when Retry-After later completes in the background', async () => {
    const transport = vi.fn<typeof fetch>(async (): Promise<Response> =>
      transport.mock.calls.length === 1
        ? Response.json({ code: 8 }, { status: 429, headers: { 'Retry-After': '1' } })
        : Response.json({}),
    );
    const t = tracer({ transport });
    t.startSpan({ name: 'A' }).end();
    const first = await finish(t, 10);
    expect(first).toMatchObject({ pendingSpans: 1, timedOut: true });
    await vi.advanceTimersByTimeAsync(1100);
    expect(first.pendingSpans).toBe(1);
    expect((await finish(t)).confirmedSpans).toBe(0);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('classifies an in-flight unknown and an unsent span separately when close expires', async () => {
    const transport = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const t = tracer({ transport });
    t.startSpan({ name: 'A' }).end();
    const flush = t.flush({ timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(1);
    t.startSpan({ name: 'B' }).end();
    const closing = t.close({ timeoutMs: 10 });
    expect(t.close({ timeoutMs: 1000 })).toBe(closing);
    await vi.advanceTimersByTimeAsync(11);
    expect(await closing).toEqual({
      confirmedSpans: 0,
      rejectedSpans: 0,
      unconfirmedSpans: 1,
      pendingSpans: 0,
      droppedSpans: 1,
      timedOut: true,
    });
    expect(await flush).toMatchObject({ unconfirmedSpans: 1, pendingSpans: 0, timedOut: true });
    expect(t.getDiagnostics().queuedBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('settles partial counts without inventing rejected IDs or retrying', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      Response.json({ partialSuccess: { rejectedSpans: '1', errorMessage: 'rejected' } }),
    );
    const t = tracer({ transport });
    t.startSpan({ name: 'A' }).end();
    t.startSpan({ name: 'B' }).end();
    expect(await finish(t)).toEqual({
      confirmedSpans: 1,
      rejectedSpans: 1,
      unconfirmedSpans: 0,
      pendingSpans: 0,
      droppedSpans: 0,
      timedOut: false,
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('does not batch later spans across an active flush boundary and shares overlapping requests', async () => {
    let resolve: (response: Response) => void = () => undefined;
    const transport = vi.fn<typeof fetch>(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const t = tracer({ transport });
    t.startSpan({ name: 'A' }).end();
    const first = t.flush({ timeoutMs: 1000 });
    const second = t.flush({ timeoutMs: 1000 });
    t.startSpan({ name: 'B' }).end();
    await vi.advanceTimersByTimeAsync(1);
    const wire = JSON.parse(transport.mock.calls[0][1]?.body as string);
    expect(wire.resourceSpans[0].scopeSpans[0].spans.map((s: { name: string }) => s.name)).toEqual([
      'A',
    ]);
    resolve(Response.json({}));
    await vi.advanceTimersByTimeAsync(1);
    expect((await first).confirmedSpans).toBe(1);
    expect((await second).confirmedSpans).toBe(1);
    expect(t.getDiagnostics().counts.confirmed).toBe(1);
    resolve(Response.json({}));
    await vi.advanceTimersByTimeAsync(1);
  });
  it.each([
    null,
    { partialSuccess: false },
    { partialSuccess: 0 },
    { partialSuccess: [] },
    { partialSuccess: 'invalid' },
  ])('regression: malformed 200 body must remain unconfirmed: %j', async (body) => {
    const t = tracer({ transport: async () => Response.json(body), limits: { maxAttempts: 1 } });
    t.startSpan({ name: 'A' }).end();
    expect(await finish(t)).toMatchObject({
      confirmedSpans: 0,
      unconfirmedSpans: 1,
      pendingSpans: 0,
    });
  });
  it('retains unknown classification after a later permanent error and completes partial zero warnings', async () => {
    const transport = vi.fn<typeof fetch>(async (): Promise<Response> =>
      transport.mock.calls.length === 1
        ? Response.json({}, { status: 503 })
        : Response.json({}, { status: 401 }),
    );
    const t = tracer({ transport, limits: { retryBaseMs: 1 } });
    t.startSpan({ name: 'A' }).end();
    expect(await finish(t)).toMatchObject({ unconfirmedSpans: 1, rejectedSpans: 0 });
    const warning = tracer({
      transport: async () =>
        Response.json({ partialSuccess: { rejectedSpans: '0', errorMessage: 'sanitized' } }),
    });
    warning.startSpan({ name: 'A' }).end();
    expect(await finish(warning)).toMatchObject({ confirmedSpans: 1, rejectedSpans: 0 });
  });
});
