import { traceDefaults, emptyTracePolicy } from '../../../protocol/src/traces/types.js';
import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCollector,
  createConfigManager,
  createQueryApi,
  type Configuration,
} from '../index.js';
import type {
  CanonicalBatch,
  EventQuery,
  TelemetryStore,
} from '../../../storage-contract/src/index.js';
import { StoreError } from '../../../storage-contract/src/index.js';
import { createServerClient } from '../../../sdk/src/server.js';
type CallableProperties<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T[K] extends object
      ? CallableProperties<T[K]>
      : T[K];
};
const now = Date.parse('2026-11-01T12:00:00.000Z');
const secret = 'x'.repeat(32);
const token = `reader.${secret}`;
const id = '44bf94dc-17a7-4462-9528-dd16b4978cad';
function configuration(): Configuration {
  return {
    schema_version: '2',
    revision: 1,
    created_at: '2026-11-01T00:00:00.000Z',
    not_before: '2026-11-01T00:00:00.000Z',
    expires_at: '2026-11-02T00:00:00.000Z',
    profile: 'development',
    endpoints: ['http://127.0.0.1:4320'],
    trusted_proxies: [],
    limits: {
      traces: { ...traceDefaults, max_concurrent: 1 },
      trace_queries: { page_bytes: 4194304 },
      max_concurrent: 10,
      request_timeout_ms: 3000,
      body_timeout_ms: 750,
      shutdown_timeout_ms: 15000,
      latency_buckets_ms: [10, 50, 100, 250, 500, 1000, 2000, 3000],
    },
    retention: { trace_days: 30, event_days: 30, receipt_days: 7, audit_days: 90 },
    projects: [
      {
        id: '0fcff045-b764-4f86-a82d-5b999b4b8a4f',
        environments: ['production'],
        services: ['web', 'worker'],
        events: { model_viewed: { model_id: { type: 'string', nullable: false } } },
        error_policy: {
          properties: { operation: { type: 'string', nullable: false, values: ['generate'] } },
          codes: ['generation_failed'],
          safe_messages: ['Safe failure.'],
        },
        browser_keys: [
          {
            key: 'pub_example',
            environment: 'production',
            service: 'web',
            origins: ['https://example.com'],
          },
        ],
        service_accounts: [
          {
            key_id: 'writer',
            secret_sha256: createHash('sha256').update('w'.repeat(32)).digest('hex'),
            environments: ['production'],
            services: ['web'],
            permissions: ['write:server'],
          },
          {
            key_id: 'reader',
            secret_sha256: createHash('sha256').update(secret).digest('hex'),
            environments: ['production'],
            services: ['web'],
            permissions: ['read:events', 'read:errors'],
          },
        ],
        trace_policy: structuredClone(emptyTracePolicy),
        trace_quota: { spans_per_second: 2000, burst: 4000 },
        quota: { events_per_second: 1, burst: 20 },
      },
    ],
  };
}
function storeFixture(): CallableProperties<TelemetryStore> {
  return {
    capabilities: {
      driver: 'test',
      contractVersion: 2,
      durability: 'single_node',
      idempotency: 'strict_receipt',
      readConsistency: 'primary_committed',
      auditedReadBarrier: true,
    },
    traces: {
      appendSpans: vi.fn(async () => {
        throw new Error('unexpected trace write');
      }),
      findSpans: vi.fn(async () => {
        throw new Error('unexpected trace query');
      }),
    },
    writer: {
      appendBatch: vi.fn(async (batch: CanonicalBatch) => ({
        acknowledged: batch.events.map(({ payload }) => ({
          id: payload.id,
          status: 'stored' as const,
          received_at: '2026-11-01T12:00:00.000Z',
          retain_until: '2026-12-01T12:00:00.000Z',
        })),
      })),
    },
    reader: {
      findEvents: vi.fn(async (query: EventQuery) => ({
        items: [],
        next_cursor: null,
        query_id: 'query',
        consistency: 'primary_committed' as const,
        range: { from: query.from, to: query.to },
        pagination: 'live-pagination' as const,
      })),
      findErrors: vi.fn(async (query: EventQuery) => ({
        items: [],
        next_cursor: null,
        query_id: 'query',
        consistency: 'primary_committed' as const,
        range: { from: query.from, to: query.to },
        pagination: 'live-pagination' as const,
      })),
      getEvent: vi.fn(async () => ({ status: 'absent' as const })),
    },
    readiness: vi.fn(async () => ({ ready: true })),
    close: vi.fn(async () => {}),
  };
}
function envelope(browser = false) {
  return {
    schema_version: '1',
    ...(browser ? { project_key: 'pub_example' } : {}),
    environment: 'production',
    service: 'web',
    release: '2026.11.01',
    build_id: 'web-build',
    events: [
      {
        id,
        occurred_at: '2026-11-01T12:00:00.000Z',
        kind: 'event',
        name: 'model_viewed',
        properties: { model_id: 'example' },
      },
    ],
  };
}
const apps: ReturnType<typeof createCollector>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
function setup(query = false, value = configuration(), clock = () => now) {
  const store = storeFixture();
  const config = createConfigManager(value, { now: clock });
  const app = query
    ? createQueryApi({
        store,
        config,
        cursorKeys: [{ id: 'current', secret: 's'.repeat(32) }],
        now: clock,
      })
    : createCollector({ store, config, now: clock });
  apps.push(app);
  return { app, store, config };
}
const headers = { authorization: `Bearer ${token}` };
const writeHeaders = { authorization: `Bearer writer.${'w'.repeat(32)}` };
describe('versioned configuration', () => {
  it('atomically keeps valid policy when updates are invalid or rolled back', () => {
    const manager = createConfigManager(configuration(), { now: () => now });
    expect(() => manager.update({ ...configuration(), revision: 2, unknown: true })).toThrow();
    expect(manager.current().value.revision).toBe(1);
    manager.update({ ...configuration(), revision: 3 });
    expect(() => manager.update({ ...configuration(), revision: 2 })).toThrow();
    expect(manager.status().active_revision).toBe(3);
    expect(Object.isFrozen(manager.current().value.projects[0])).toBe(true);
  });
  it('rejects future validity, duplicate keys and unregistered account scope', () => {
    expect(() =>
      createConfigManager(
        { ...configuration(), not_before: '2026-11-01T13:00:00.000Z' },
        { now: () => now },
      ),
    ).toThrow();
    const value = configuration();
    value.projects[0]!.service_accounts[0]!.services = ['unregistered'];
    expect(() => createConfigManager(value, { now: () => now })).toThrow();
  });
  it('fails closed at expiry while live remains available', async () => {
    let time = now;
    const { app } = setup(false, configuration(), () => time);
    time = Date.parse('2026-11-02T00:00:00.000Z');
    expect((await app.inject({ url: '/ready' })).statusCode).toBe(503);
    expect((await app.inject({ url: '/live' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/metrics' })).body).toContain('telemetry_config_valid 0');
  });
});
describe('collector authentication and ingestion', () => {
  it('acknowledges a server batch with authenticated immutable scope and a cancellable deadline', async () => {
    const { app, store } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest/server',
      headers: writeHeaders,
      payload: envelope(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      project_id: configuration().projects[0]!.id,
      environment: 'production',
      source: 'server',
      service: 'web',
      acknowledged: [{ id, status: 'stored' }],
    });
    const [batch, operation] = vi.mocked(store.writer.appendBatch).mock.calls[0]!;
    expect(batch.scope).toMatchObject({
      source: 'server',
      policyVersion: '1',
      retentionDays: 30,
      receiptDays: 7,
    });
    expect(batch.events[0]!.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(operation.signal).toBeInstanceOf(AbortSignal);
    expect(operation.deadlineAtMs).toBe(now + 3000);
  });
  it('returns SDK-compatible UUID request IDs for successful and rejected HTTP ingestion', async () => {
    const { app } = setup();
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    const accepted = await fetch(`${endpoint}/v1/ingest/server`, {
      method: 'POST',
      headers: { ...writeHeaders, 'content-type': 'application/json' },
      body: JSON.stringify(envelope()),
    });
    const rejected = await fetch(`${endpoint}/v1/ingest/server`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(envelope()),
    });
    const metadata = [
      { status: accepted.status, request_id: (await accepted.json()).request_id },
      { status: rejected.status, request_id: (await rejected.json()).request_id },
    ];
    expect(metadata.map((response) => response.status)).toEqual([200, 401]);
    for (const response of metadata)
      expect(response.request_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    expect(metadata[0]!.request_id).not.toBe(metadata[1]!.request_id);
  });
  it('lets the real SDK stop after a valid HTTP authorization rejection', async () => {
    const { app, store } = setup();
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    const sdk = createServerClient({
      endpoints: [`${endpoint}/v1/ingest/server`],
      writeToken: 'writer.invalid',
      environment: 'production',
      service: 'web',
      release: '1',
      buildId: 'build',
    });
    try {
      const id = sdk.captureError(new Error('private'));
      expect(id).toBeTypeOf('string');
      expect(await sdk.flush({ timeoutMs: 500 })).toMatchObject({
        acknowledgedIds: [],
        pendingIds: [],
        droppedCount: 1,
        timedOut: false,
      });
      expect(sdk.getDiagnostics().dropped.authorization).toBe(1);
      expect(sdk.captureError(new Error('after rejection'))).toBeNull();
      expect(store.writer.appendBatch).not.toHaveBeenCalled();
    } finally {
      await sdk.close({ timeoutMs: 0 });
    }
  });
  it.each([undefined, 'Bearer reader.bad', `Bearer wrong.${secret}`])(
    'rejects invalid server credentials without invoking storage: %s',
    async (authorization) => {
      const { app, store } = setup();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ingest/server',
        headers: authorization ? { authorization } : {},
        payload: envelope(),
      });
      expect(response.statusCode).toBe(401);
      expect(store.writer.appendBatch).not.toHaveBeenCalled();
      expect(response.body).not.toContain(secret);
    },
  );
  it('does not grant write permission to a read-only account', async () => {
    const value = configuration();
    value.projects[0]!.service_accounts[0]!.permissions = ['read:events'];
    const { app } = setup(false, value);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/ingest/server',
          headers: writeHeaders,
          payload: envelope(),
        })
      ).statusCode,
    ).toBe(403);
  });
  it.each(['https://evil.example', 'null', undefined])(
    'rejects an unregistered browser Origin: %s',
    async (origin) => {
      const { app } = setup();
      const response = await app.inject({
        method: 'POST',
        url: '/v1/ingest/browser',
        headers: origin ? { origin } : {},
        payload: envelope(true),
      });
      expect(response.statusCode).toBe(403);
    },
  );
  it('binds browser identity to Origin and marks the source without trusting a payload source', async () => {
    const { app, store } = setup();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest/browser',
      headers: { origin: 'https://example.com' },
      payload: envelope(true),
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('https://example.com');
    expect(vi.mocked(store.writer.appendBatch).mock.calls[0]![0].scope.source).toBe('browser');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/ingest/browser',
          headers: { origin: 'https://example.com' },
          payload: { ...envelope(true), source: 'server' },
        })
      ).statusCode,
    ).toBe(400);
  });
  it('rejects browser ambient credentials and provides bounded preflight', async () => {
    const { app } = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/ingest/browser',
          headers: { origin: 'https://example.com', cookie: 'session=private' },
          payload: envelope(true),
        })
      ).statusCode,
    ).toBe(403);
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/v1/ingest/browser',
      headers: { origin: 'https://example.com' },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers['access-control-allow-credentials']).toBeUndefined();
  });
  it('rejects unregistered event properties with input index only', async () => {
    const { app, store } = setup();
    const data = envelope();
    data.events[0]!.properties = { secret: 'private' } as never;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest/server',
      headers: writeHeaders,
      payload: data,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.items).toEqual([
      { index: 0, id, reason: 'unregistered_event_or_property' },
    ]);
    expect(response.body).not.toContain('private');
    expect(store.writer.appendBatch).not.toHaveBeenCalled();
  });
  it('rejects prototype property event names that were never registered', async () => {
    const { app, store } = setup();
    const data = envelope();
    data.events[0]!.name = 'constructor';
    data.events[0]!.properties = {} as never;
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest/server',
      headers: writeHeaders,
      payload: data,
    });
    expect(response.statusCode).toBe(422);
    expect(store.writer.appendBatch).not.toHaveBeenCalled();
  });
  it('applies safe error projection while preserving digest across policy revisions', async () => {
    const { app, store, config } = setup();
    const data = {
      ...envelope(),
      events: [
        {
          id,
          occurred_at: '2026-11-01T12:00:00.000Z',
          kind: 'error',
          name: 'runtime.error',
          properties: { operation: 'generate' },
          error: {
            type: 'Error',
            mechanism: 'manual',
            handled: true,
            safe_message: 'private message',
            frames: [{ file: '/app.js?secret=private#fragment', line: 1, column: 0 }],
          },
        },
      ],
    };
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/ingest/server',
          headers: writeHeaders,
          payload: data,
        })
      ).statusCode,
    ).toBe(200);
    const value = configuration();
    value.revision = 2;
    value.projects[0]!.error_policy.safe_messages = ['private message'];
    config.update(value);
    await app.inject({
      method: 'POST',
      url: '/v1/ingest/server',
      headers: writeHeaders,
      payload: data,
    });
    const first = vi.mocked(store.writer.appendBatch).mock.calls[0]![0].events[0]!;
    const second = vi.mocked(store.writer.appendBatch).mock.calls[1]![0].events[0]!;
    expect(first.payload.error!.safe_message).toBeUndefined();
    expect(first.payload.error!.frames[0]!.file).toBe('/app.js');
    expect(second.payload.error!.safe_message).toBe('private message');
    expect(first.digest).toBe(second.digest);
    expect(first.fingerprint).toMatch(/^v1:[a-f0-9]{64}$/);
  });
  it('does not persist dangerous frame URLs while digest still identifies the original wire payload', async () => {
    const { app, store } = setup();
    const event = {
      id,
      occurred_at: '2026-11-01T12:00:00.000Z',
      kind: 'error',
      name: 'runtime.error',
      properties: {},
      error: {
        type: 'Error',
        mechanism: 'manual',
        handled: true,
        frames: [
          { file: 'data:text/javascript,PRIVATE_INLINE_SOURCE', line: 1, column: 0 },
          { file: 'blob:https://user:PRIVATE_PASSWORD@example.com/source', line: 2, column: 0 },
          { file: 'https://user:PRIVATE_PASSWORD@example.com/app.js', line: 3, column: 0 },
          { file: 'javascript:PRIVATE_INLINE_SOURCE', line: 4, column: 0 },
          { file: 'https://example.com/app.js?private=value#fragment', line: 5, column: 3 },
          { file: '/srv/server.js', line: 6, column: 0 },
        ],
      },
    };
    const send = (value: unknown) =>
      app.inject({
        method: 'POST',
        url: '/v1/ingest/server',
        headers: writeHeaders,
        payload: { ...envelope(), events: [value] },
      });
    expect((await send(event)).statusCode).toBe(200);
    const modified = structuredClone(event);
    modified.error.frames[0]!.file = 'data:text/javascript,OTHER_PRIVATE_SOURCE';
    expect((await send(modified)).statusCode).toBe(200);
    expect((await send(event)).statusCode).toBe(200);
    const batches = vi
      .mocked(store.writer.appendBatch)
      .mock.calls.map(([batch]) => batch.events[0]!);
    expect(batches[0]!.payload.error!.frames).toEqual([
      { file: '/app.js', line: 5, column: 3 },
      { file: '/srv/server.js', line: 6, column: 0 },
    ]);
    expect(batches[1]!.payload).toEqual(batches[0]!.payload);
    expect(batches[1]!.digest).not.toBe(batches[0]!.digest);
    expect(batches[2]!.digest).toBe(batches[0]!.digest);
  });
  it('uses 429 for project rate limits and reports the per-instance scope', async () => {
    const { app } = setup();
    for (let index = 0; index < 20; index += 1)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/v1/ingest/server',
            headers: writeHeaders,
            payload: envelope(),
          })
        ).statusCode,
      ).toBe(200);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest/server',
      headers: writeHeaders,
      payload: envelope(),
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('1');
    expect(response.json().error.message).toContain('Per-instance');
  });
  it('preserves explicit commit uncertainty without leaking storage error content', async () => {
    const { app, store } = setup();
    vi.mocked(store.writer.appendBatch).mockRejectedValue(
      new StoreError('confirmation_unknown', 'unknown'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest/server',
      headers: writeHeaders,
      payload: envelope(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error).toMatchObject({
      code: 'confirmation_unknown',
      outcome: 'unknown',
      retryable: true,
    });
  });
  it('rejects oversized and compressed bodies without storage calls', async () => {
    const { app, store } = setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/ingest/server',
          headers: { ...writeHeaders, 'content-encoding': 'gzip' },
          payload: envelope(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/v1/ingest/server',
          headers: writeHeaders,
          payload: { ...envelope(), extra: 'x'.repeat(40000) },
        })
      ).statusCode,
    ).toBe(413);
    expect(store.writer.appendBatch).not.toHaveBeenCalled();
  });
  it('releases admission capacity after a client disconnects during an incomplete request body', async () => {
    const value = configuration();
    value.limits.max_concurrent = 1;
    value.limits.traces.max_concurrent = 1;
    value.limits.body_timeout_ms = 50;
    value.limits.request_timeout_ms = 100;
    const { app, store } = setup(false, value);
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(endpoint).port) });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(
        'POST /v1/ingest/server HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{',
      );
      await vi.waitFor(async () => {
        const metrics = await fetch(`${endpoint}/metrics`);
        expect(await metrics.text()).toContain('telemetry_active_requests 1');
      });
      socket.destroy();
      await vi.waitFor(
        async () => {
          const metrics = await fetch(`${endpoint}/metrics`);
          expect(await metrics.text()).toContain('telemetry_active_requests 0');
        },
        { timeout: 500, interval: 10 },
      );
      expect((await fetch(`${endpoint}/ready`)).status).toBe(200);
      expect(store.writer.appendBatch).not.toHaveBeenCalled();
    } finally {
      socket.destroy();
    }
  });
  it('keeps a disconnected write in the admission budget until the store operation exits', async () => {
    const value = configuration();
    value.limits.max_concurrent = 1;
    value.limits.traces.max_concurrent = 1;
    const { app, store } = setup(false, value);
    let release: (() => void) | undefined;
    vi.mocked(store.writer.appendBatch).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ acknowledged: [] });
        }),
    );
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(endpoint).port) });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      const body = JSON.stringify(envelope());
      socket.write(
        `POST /v1/ingest/server HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${writeHeaders.authorization}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
      );
      await vi.waitFor(() => expect(store.writer.appendBatch).toHaveBeenCalledTimes(1));
      socket.destroy();
      await vi.waitFor(() => {
        expect(vi.mocked(store.writer.appendBatch).mock.calls[0]![1].signal.aborted).toBe(true);
      });
      expect((await fetch(`${endpoint}/ready`)).status).toBe(503);
      release!();
      await vi.waitFor(async () => {
        const metrics = await fetch(`${endpoint}/metrics`);
        expect(await metrics.text()).toContain('telemetry_active_requests 0');
      });
      expect((await fetch(`${endpoint}/ready`)).status).toBe(200);
    } finally {
      release?.();
      socket.destroy();
    }
  });
  it('keeps an unfinished timed-out write in the concurrency budget', async () => {
    const value = configuration();
    value.limits.max_concurrent = 1;
    value.limits.traces.max_concurrent = 1;
    value.limits.body_timeout_ms = 10;
    value.limits.request_timeout_ms = 20;
    const { app, store } = setup(false, value);
    let release!: () => void;
    vi.mocked(store.writer.appendBatch).mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ acknowledged: [] });
        }),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/v1/ingest/server',
      headers: writeHeaders,
      payload: envelope(),
    });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.outcome).toBe('unknown');
    expect(vi.mocked(store.writer.appendBatch).mock.calls[0]![1].signal.aborted).toBe(true);
    expect((await app.inject({ url: '/ready' })).json().error.code).toBe('overloaded');
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect((await app.inject({ url: '/ready' })).statusCode).toBe(200);
  });
});
describe('audited queries and signed cursors', () => {
  it('passes every fixed event filter and the current service/category scope', async () => {
    const { app, store } = setup(true);
    const response = await app.inject({
      url: '/v1/events?environment=production&from=2026-11-01T00:00:00.000Z&to=2026-11-01T12:00:00.000Z&source=server&name=model_viewed&service=web&release=v1&request_id=req&trace_id=trace&user_id=user&limit=7',
      headers,
    });
    expect(response.statusCode).toBe(200);
    const [query, access] = vi.mocked(store.reader.findEvents).mock.calls[0]!;
    expect(query).toMatchObject({
      limit: 7,
      source: 'server',
      name: 'model_viewed',
      service: 'web',
      release: 'v1',
      request_id: 'req',
      trace_id: 'trace',
      user_id: 'user',
    });
    expect(access).toMatchObject({
      allowedServices: ['web'],
      allowedKinds: ['error', 'event'],
      actorKeyId: 'reader',
      queryKind: 'events',
      auditRetentionDays: 90,
    });
    expect(access.queryDigest).toMatch(/^[a-f0-9]{64}$/);
  });
  it('restricts error-only permissions to errors and error details', async () => {
    const value = configuration();
    value.projects[0]!.service_accounts[1]!.permissions = ['read:errors'];
    const { app, store } = setup(true, value);
    expect(
      (await app.inject({ url: '/v1/events?environment=production', headers })).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          url: '/v1/errors?environment=production&code=generation_failed&fingerprint=v1:abc',
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(vi.mocked(store.reader.findErrors).mock.calls[0]![1].allowedKinds).toEqual(['error']);
  });
  it.each([
    '&from=2026-10-01T00:00:00.000Z',
    '&limit=501',
    '&limit=0',
    '&source=trusted',
    '&sql=select',
    '&name=x&name=y',
  ])('rejects unsupported or unbounded filters: %s', async (suffix) => {
    const { app, store } = setup(true);
    expect(
      (await app.inject({ url: `/v1/events?environment=production${suffix}`, headers })).statusCode,
    ).toBe(400);
    expect(store.reader.findEvents).not.toHaveBeenCalled();
  });
  it('hides out-of-service details and requires all identity dimensions', async () => {
    const { app, store } = setup(true);
    expect(
      (
        await app.inject({
          url: `/v1/errors/server/${id}?environment=production&service=worker`,
          headers,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await app.inject({ url: `/v1/errors/server/${id}?environment=production`, headers }))
        .statusCode,
    ).toBe(400);
    expect(store.reader.getEvent).not.toHaveBeenCalled();
  });
  it('maps audited expired/absent results to 410/404 and does not mask audit failure', async () => {
    const { app, store } = setup(true);
    const path = `/v1/errors/server/${id}?environment=production&service=web`;
    vi.mocked(store.reader.getEvent).mockResolvedValueOnce({ status: 'expired' });
    expect((await app.inject({ url: path, headers })).statusCode).toBe(410);
    expect((await app.inject({ url: path, headers })).statusCode).toBe(404);
    vi.mocked(store.reader.getEvent).mockRejectedValueOnce(new StoreError('audit_unavailable'));
    expect((await app.inject({ url: path, headers })).json().error.code).toBe('audit_unavailable');
  });
  it('signs pagination and rejects changed filters, tampering, expiry and changed permissions', async () => {
    let time = now;
    const { app, store, config } = setup(true, configuration(), () => time);
    vi.mocked(store.reader.findEvents).mockImplementation(async (query) => ({
      items: [],
      next_cursor: JSON.stringify({
        received_at: '2026-11-01T01:00:00.000Z',
        service: 'web',
        source: 'server',
        id,
      }),
      query_id: 'page',
      consistency: 'primary_committed',
      range: { from: query.from, to: query.to },
      pagination: 'live-pagination',
    }));
    const first = await app.inject({ url: '/v1/events?environment=production', headers });
    const cursor = first.json().next_cursor as string;
    expect(cursor).not.toContain(secret);
    expect(
      (
        await app.inject({
          url: `/v1/events?environment=production&cursor=${encodeURIComponent(cursor)}`,
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(vi.mocked(store.reader.findEvents).mock.calls[1]![0].after).toMatchObject({
      id,
      source: 'server',
    });
    expect(
      (
        await app.inject({
          url: `/v1/events?environment=production&limit=99&cursor=${encodeURIComponent(cursor)}`,
          headers,
        })
      ).json().error.code,
    ).toBe('invalid_cursor');
    expect(
      (
        await app.inject({
          url: `/v1/events?environment=production&cursor=${encodeURIComponent(cursor)}x`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    const changed = configuration();
    changed.revision = 2;
    changed.projects[0]!.service_accounts[1]!.services.push('worker');
    config.update(changed);
    expect(
      (
        await app.inject({
          url: `/v1/events?environment=production&cursor=${encodeURIComponent(cursor)}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
    time += 15 * 60 * 1000;
    expect(
      (
        await app.inject({
          url: `/v1/events?environment=production&cursor=${encodeURIComponent(cursor)}`,
          headers,
        })
      ).statusCode,
    ).toBe(400);
  });
  it('returns doctor scope without credentials and checks readiness dependency', async () => {
    const { app, store } = setup(true);
    const response = await app.inject({ url: '/v1/doctor', headers });
    expect(response.json()).toMatchObject({
      services: ['web'],
      permissions: ['read:events', 'read:errors'],
    });
    expect(response.body).not.toContain(secret);
    vi.mocked(store.readiness).mockResolvedValue({
      ready: false,
      reason: 'private connection string',
    });
    const readiness = await app.inject({ url: '/ready' });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.body).not.toContain('private');
  });
});
it('exports bounded route/status counters, latency buckets, expiry and digest without query values', async () => {
  const { app, store, config } = setup(true);
  await app.inject({
    url: '/v1/events?environment=production&user_id=private-user-query',
    headers,
  });
  vi.mocked(store.reader.findEvents).mockRejectedValueOnce(
    new StoreError('private-database-failure'),
  );
  const failed = await app.inject({ url: '/v1/events?environment=production', headers });
  expect(failed.json().error.code).toBe('storage_unavailable');
  const metrics = (await app.inject({ url: '/metrics' })).body;
  expect(metrics).toContain(
    'telemetry_requests_total{route="/v1/events",method="GET",status="200"} 1',
  );
  expect(metrics).toContain(
    'telemetry_requests_total{route="/v1/events",method="GET",status="503"} 1',
  );
  expect(metrics).toContain(
    'telemetry_request_duration_seconds_bucket{route="/v1/events",method="GET",le="+Inf"} 2',
  );
  expect(metrics).toContain(
    'telemetry_request_duration_seconds_bucket{route="/v1/events",method="GET",le="1"}',
  );
  expect(metrics).toContain(`telemetry_config_info{digest="${config.status().digest}"} 1`);
  expect(metrics).toContain(
    `telemetry_config_expires_at_seconds ${Date.parse(config.status().expires_at) / 1000}`,
  );
  expect(metrics).not.toContain('private-user-query');
  expect(metrics).not.toContain('private-database-failure');
});
it('returns only an audited found detail and carries the observed clock difference', async () => {
  const { app, store } = setup(true);
  vi.mocked(store.reader.getEvent).mockResolvedValue({
    status: 'found',
    event: {
      ...envelope().events[0]!,
      kind: 'event',
      project_id: configuration().projects[0]!.id,
      environment: 'production',
      service: 'web',
      source: 'server',
      release: 'v1',
      build_id: 'build',
      received_at: '2026-11-01T12:00:01.000Z',
      retain_until: '2026-12-01T12:00:01.000Z',
      policy_version: '1',
      clock_skew_ms: 1000,
    },
  });
  const response = await app.inject({
    url: `/v1/events/server/${id}?environment=production&service=web`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ id, clock_skew_ms: 1000 });
});
it('rejects a configuration key that combines write and read credentials', () => {
  const value = configuration();
  value.projects[0]!.service_accounts[0]!.permissions = ['write:server', 'read:events'];
  expect(() => createConfigManager(value, { now: () => now })).toThrow();
});

it.each([
  ['event_days', 3661],
  ['receipt_days', 0],
  ['receipt_days', 3661],
  ['audit_days', 3661],
] as const)(
  'regression: unsupported %s=%s cannot activate a configuration that makes requests fail',
  (key, days) => {
    const value = configuration();
    value.retention[key] = days;
    expect(() => createConfigManager(value, { now: () => now })).toThrow();
    const active = createConfigManager(configuration(), { now: () => now });
    expect(() => active.update({ ...value, revision: 2 })).toThrow();
    expect(active.current().value.retention).toEqual({
      trace_days: 30,
      event_days: 30,
      receipt_days: 7,
      audit_days: 90,
    });
    expect(active.status().active_revision).toBe(1);
  },
);

it.each([
  ['019a3f9d-7400-7000-8000-000000000001', false],
  ['019a3f9d-7400-7000-8000-000000000001', true],
  ['0FCFF045-B764-4F86-A82D-5B999B4B8A4F', true],
] as const)(
  'regression: configured project %s receives a usable SDK acknowledgement with expected identity %s',
  async (projectId, expected) => {
    const value = configuration();
    value.projects[0]!.id = projectId;
    const { app, store } = setup(false, value);
    const statuses: number[] = [];
    const client = createServerClient({
      endpoints: ['https://collector.example/v1/ingest/server'],
      writeToken: `writer.${'w'.repeat(32)}`,
      ...(expected ? { projectId } : {}),
      environment: 'production',
      service: 'web',
      release: 'v1',
      buildId: 'build',
      events: { model_viewed: { model_id: { type: 'string' } } },
      limits: { maxAttempts: 1 },
      transport: async (_url, init) => {
        const response = await app.inject({
          method: 'POST',
          url: '/v1/ingest/server',
          headers: init!.headers as Record<string, string>,
          payload: init!.body as string,
        });
        statuses.push(response.statusCode);
        return new Response(response.body, { status: response.statusCode });
      },
    });
    try {
      const eventId = client.track('model_viewed', { model_id: 'example' });
      const result = await client.flush({ timeoutMs: 1000 });
      expect(statuses).toEqual([200]);
      expect(result.acknowledgedIds).toEqual([eventId]);
      expect(result.droppedCount).toBe(0);
      expect(store.writer.appendBatch).toHaveBeenCalledTimes(1);
      expect(vi.mocked(store.writer.appendBatch).mock.calls[0]![0].scope.projectId).toBe(projectId);
    } finally {
      await client.close({ timeoutMs: 0 });
    }
  },
);
