import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createBrowserClient } from '../browser.js';
import { createServerClient } from '../server.js';
import {
  initializeNextClient,
  captureHandledResult as captureClientHandledResult,
} from '../next/client.js';
import { captureHandledResult, createOnRequestError } from '../next/server.js';
import type { Envelope } from '../../../protocol/src/types.js';
import type { BrowserOptions, TelemetryClient } from '../types.js';

const projectId = '0fcff045-b764-4f86-a82d-5b999b4b8a4f';
const requestId = 'ee31edb7-81b7-4c6d-afba-225a54f1c4b5';
const clients: TelemetryClient[] = [];
function options(overrides: Partial<BrowserOptions> = {}): BrowserOptions {
  return {
    endpoints: [
      'https://first.example/v1/ingest/browser',
      'https://second.example/v1/ingest/browser',
    ],
    projectKey: 'pub_example',
    environment: 'production',
    service: 'web',
    release: '1',
    buildId: 'web-1',
    projectId,
    events: {
      model_viewed: {
        model_id: { type: 'string' },
        amount: { type: 'number', minimum: 0 },
        status: { type: 'string', enum: ['ok', 'failed'] },
      },
    },
    errorProperties: { operation: { type: 'string', enum: ['generate'] } },
    captureGlobalErrors: false,
    ...overrides,
  };
}
function browser(overrides: Partial<BrowserOptions> = {}) {
  const client = createBrowserClient(options(overrides));
  clients.push(client);
  return client;
}
function wireBody(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON string');
  return init.body;
}
function payload(init: RequestInit | undefined): Envelope {
  return JSON.parse(wireBody(init)) as Envelope;
}
function acknowledgement(body: Envelope, overrides: Record<string, unknown> = {}): Response {
  return Response.json({
    request_id: requestId,
    project_id: projectId,
    environment: body.environment,
    source: body.project_key ? 'browser' : 'server',
    service: body.service,
    acknowledged: body.events.map((event) => ({
      id: event.id,
      status: 'stored',
      received_at: '2026-11-01T02:00:01.000Z',
      retain_until: '2026-12-01T02:00:01.000Z',
    })),
    ...overrides,
  });
}
function failure(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return Response.json(
    {
      request_id: requestId,
      error: {
        code,
        message: 'Request failed.',
        retryable: status >= 429,
        outcome: 'not_committed',
        ...extra,
      },
    },
    { status, headers },
  );
}
const accept = () => vi.fn<typeof fetch>(async (_url, init) => acknowledgement(payload(init)));
async function settle(ms = 1) {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T02:00:00.000Z'));
});
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close({ timeoutMs: 0 });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('SDK capture and immutable context', () => {
  it('rejects invalid configuration during construction', () => {
    expect(() => browser({ projectKey: '' })).toThrow();
    expect(() => browser({ endpoints: [] })).toThrow();
    expect(() => browser({ endpoints: ['https://user:secret@example.com/ingest'] })).toThrow();
    expect(() => browser({ limits: { queueCapacity: 201 } })).toThrow();
    expect(() => browser({ sampleRate: { event: -0.1 } })).toThrow();
    expect(() => browser({ events: { Invalid: {} } })).toThrow();
    expect(() =>
      browser({ events: { test: JSON.parse('{"__proto__":{"type":"string"}}') } }),
    ).toThrow();
    expect(() => createServerClient({ ...options(), writeToken: 'secret' })).toThrow();
  });
  it.each([
    ['browser', 'http://collector.example/v1/ingest/browser'],
    ['browser', 'http://10.0.0.1/v1/ingest/browser'],
    ['server', 'http://collector.example/v1/ingest/server'],
    ['server', 'http://localhost.example/v1/ingest/server'],
  ])('regression: %s clients must reject remote plaintext endpoint %s', (source, endpoint) => {
    const transport = accept();
    const base = options({ endpoints: [endpoint], transport });
    const { projectKey: _key, captureGlobalErrors: _capture, ...server } = base;
    expect(() =>
      source === 'browser'
        ? createBrowserClient(base)
        : createServerClient({ ...server, writeToken: 'writer.' + 's'.repeat(32) }),
    ).toThrow('Invalid telemetry endpoint');
    expect(transport).not.toHaveBeenCalled();
  });
  it.each([
    '/api/ingest',
    'https://collector.example/v1/ingest/browser',
    'http://localhost/v1/ingest/browser',
    'http://127.0.0.1/v1/ingest/browser',
    'http://[::1]/v1/ingest/browser',
  ])('sends to a permitted browser endpoint %s', async (endpoint) => {
    vi.stubGlobal('location', { origin: 'https://application.example' });
    const transport = accept();
    const client = browser({ endpoints: [endpoint], transport });
    const id = client.track('model_viewed');
    const pending = client.flush();
    await settle();
    expect((await pending).acknowledgedIds).toEqual([id]);
    expect(transport.mock.calls[0][0]).toBe(
      endpoint === '/api/ingest' ? 'https://application.example/api/ingest' : endpoint,
    );
  });
  it.each([undefined, 'null'])(
    'rejects relative endpoints without a usable page origin: %s',
    (origin) => {
      vi.stubGlobal('location', origin === undefined ? undefined : { origin });
      const transport = accept();
      expect(() => createBrowserClient(options({ endpoints: ['/api/ingest'], transport }))).toThrow(
        'Invalid telemetry endpoint',
      );
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it('fixes a same-origin relative endpoint to the HTTP page origin', async () => {
    vi.stubGlobal('location', { origin: 'http://application.example' });
    const transport = accept();
    const client = browser({ endpoints: ['/api/ingest'], transport });
    const id = client.track('model_viewed');
    const pending = client.flush();
    await settle();
    expect((await pending).acknowledgedIds).toEqual([id]);
    expect(transport.mock.calls[0][0]).toBe('http://application.example/api/ingest');
  });
  it.each([
    '/\\collector.example/v1/ingest/browser',
    '/\t/collector.example/v1/ingest/browser',
    '/\n/collector.example/v1/ingest/browser',
    '/\r/collector.example/v1/ingest/browser',
  ])(
    'regression: a browser relative endpoint must not escape the application origin: %j',
    (endpoint) => {
      const transport = accept();
      expect(() => createBrowserClient(options({ endpoints: [endpoint], transport }))).toThrow(
        'Invalid telemetry endpoint',
      );
      expect(transport).not.toHaveBeenCalled();
    },
  );
  it('accepts only registered event properties and safe values', async () => {
    const transport = accept();
    const client = browser({ transport });
    expect(client.track('unknown')).toBeNull();
    expect(client.track('model_viewed', { prompt: 'private' })).toBeNull();
    expect(client.track('model_viewed', { amount: -1 })).toBeNull();
    expect(client.track('model_viewed', { status: 'other' })).toBeNull();
    expect(client.track('model_viewed', { model_id: '汉'.repeat(86) })).toBeNull();
    const id = client.track('model_viewed', { amount: 1.5, status: 'ok' });
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toEqual([id]);
    expect(client.getDiagnostics().dropped).toEqual({
      unregistered_event: 1,
      invalid_properties: 4,
    });
  });
  it('keeps capture-time user/session and properties after caller mutation and reset', async () => {
    const transport = accept();
    const client = browser({ transport });
    client.setUser('first-user');
    const properties = { model_id: 'first-model' };
    const context = { requestId: 'first-request', route: '/models?token=private#fragment' };
    const first = client.track('model_viewed', properties, context);
    properties.model_id = 'mutated';
    context.requestId = 'mutated';
    client.reset();
    client.setUser('second-user');
    const second = client.track('model_viewed', { model_id: 'second-model' });
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toEqual([first, second]);
    const events = payload(transport.mock.calls[0][1]).events;
    expect(events[0].properties).toEqual({ model_id: 'first-model' });
    expect(events[0].context).toMatchObject({
      user_id: 'first-user',
      request_id: 'first-request',
      route: '/models',
    });
    expect(events[1].context?.user_id).toBe('second-user');
    expect(events[0].context?.session_id).not.toBe(events[1].context?.session_id);
    expect(events[0].truncated).toBe(true);
  });
  it('contains arbitrary thrown values, malicious getters, circular data and invalid properties', async () => {
    const transport = accept();
    const client = browser({ transport });
    const malicious = new Proxy(
      {},
      {
        get() {
          throw new Error('private');
        },
      },
    );
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    for (const error of [undefined, null, Symbol('private'), 1n, cycle, malicious])
      expect(() => client.captureError(error)).not.toThrow();
    const properties = Object.defineProperty({}, 'model_id', {
      enumerable: true,
      get() {
        throw new Error('private');
      },
    });
    expect(client.track('model_viewed', properties)).toBeNull();
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toHaveLength(6);
    expect(wireBody(transport.mock.calls[0][1])).not.toContain('private');
  });
  it('uploads safe registered code/message without parsing raw stack text or URL secrets', async () => {
    const transport = accept();
    const client = browser({
      transport,
      errorCodes: ['MODEL_FAILED'],
      safeMessages: { MODEL_FAILED: 'Model failed.' },
    });
    const error = Object.assign(new Error('private-prompt'), {
      code: 'MODEL_FAILED',
      stack:
        'Error: private-prompt\n    at run (https://example.com/app.js?secret=private:120:9)\n    at /srv/server.js:1:1',
    });
    client.captureError(error, { operation: 'generate' });
    const result = client.flush();
    await settle();
    await result;
    const event = payload(transport.mock.calls[0][1]).events[0];
    expect(event.error).toEqual({
      type: 'Error',
      mechanism: 'manual',
      handled: true,
      code: 'MODEL_FAILED',
      safe_message: 'Model failed.',
      frames: [],
    });
    expect(event.properties).toEqual({ operation: 'generate' });
    expect(wireBody(transport.mock.calls[0][1])).not.toContain('private');
  });
  it('does not upload inline module source or credentialed special URLs as error frames', async () => {
    const transport = accept();
    const client = browser({ transport });
    const moduleUrl = 'data:text/javascript,throw new Error("PRIVATE_INLINE_SOURCE")';
    try {
      await import(moduleUrl);
    } catch (error) {
      client.captureError(error);
    }
    client.captureError({
      stack:
        'Error: private\n    at run (blob:https://user:PRIVATE_PASSWORD@example.com/source:12:4)',
    });
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toHaveLength(2);
    const bodies = transport.mock.calls.map((call) => wireBody(call[1])).join('');
    expect(bodies).not.toContain('PRIVATE_INLINE_SOURCE');
    expect(bodies).not.toContain('PRIVATE_PASSWORD');
    expect(bodies).not.toContain('data:text/javascript');
    expect(bodies).not.toContain('blob:https:');
  });
  it('does not misidentify a multiline private error message as stack frames', async () => {
    const transport = accept();
    const client = browser({ transport });
    const error = new Error('private\n    at secretPrompt (/user/customer-secret.txt:123:4)');
    client.captureError(error);
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toHaveLength(1);
    const body = wireBody(transport.mock.calls[0][1]);
    expect(body).not.toContain('secretPrompt');
    expect(body).not.toContain('customer-secret.txt');
    expect(payload(transport.mock.calls[0][1]).events[0].error!.frames).toEqual([]);
  });
  it('regression: strict privacy must not read raw message or stack getters while preserving safe error identity and span association', async () => {
    const reads = { message: 0, stack: 0 };
    const transport = accept();
    const client = browser({
      transport,
      errorCodes: ['MODEL_FAILED'],
      safeMessages: { MODEL_FAILED: 'Model failed.' },
    });
    const error = {
      name: 'TypeError',
      code: 'MODEL_FAILED',
      get message() {
        reads.message++;
        return 'PRIVATE_MESSAGE';
      },
      get stack() {
        reads.stack++;
        return 'TypeError: PRIVATE_MESSAGE\n    at PRIVATE_FRAME (/customer/PRIVATE_ACCOUNT.js:123:4)';
      },
    };
    const id = client.captureError(error, {
      requestId: 'strict-privacy',
      traceId: '11111111111111111111111111111111',
      spanId: '2222222222222222',
    });
    const pending = client.flush();
    await settle();
    expect((await pending).acknowledgedIds).toEqual([id]);
    expect(reads).toEqual({ message: 0, stack: 0 });
    expect(payload(transport.mock.calls[0][1]).events[0]).toMatchObject({
      error: {
        type: 'TypeError',
        code: 'MODEL_FAILED',
        safe_message: 'Model failed.',
        frames: [],
      },
      context: {
        request_id: 'strict-privacy',
        trace_id: '11111111111111111111111111111111',
        span_id: '2222222222222222',
      },
    });
    expect(wireBody(transport.mock.calls[0][1])).not.toContain('PRIVATE');
  });
  it('regression: materialized native Error messages with empty names or shortened text must not become uploaded frames', async () => {
    const module = new URL('../server.ts', import.meta.url).href;
    const source = `
import { createServerClient } from ${JSON.stringify(module)};
const bodies = [];
const client = createServerClient({ endpoints: ['https://collector.example/v1/ingest/server'], environment: 'test', service: 'api', release: '1', buildId: '1', writeToken: 'writer.' + 's'.repeat(32), transport: async (_url, init) => {
  const body = JSON.parse(init.body); bodies.push(body);
  return Response.json({ request_id: 'ee31edb7-81b7-4c6d-afba-225a54f1c4b5', project_id: '0fcff045-b764-4f86-a82d-5b999b4b8a4f', environment: 'test', service: 'api', source: 'server', acknowledged: body.events.map((event) => ({ id: event.id, status: 'stored', received_at: '2026-11-01T02:00:01.000Z', retain_until: '2026-12-01T02:00:01.000Z' })) });
} });
for (const name of ['', 'Custom Error']) {
  const error = new Error('PRIVATE_MESSAGE@/customer/PRIVATE_ACCOUNT.txt:123:4');
  error.name = name; void error.stack; error.name = 'RenamedError'; client.captureError(error);
}
const shortened = new Error('safe\\n    at PRIVATE_MESSAGE (/customer/PRIVATE_ACCOUNT.txt:123:4)');
void shortened.stack; shortened.message = 'safe'; client.captureError(shortened);
const result = await client.flush(); await client.close();
console.log(JSON.stringify({ acknowledged: result.acknowledgedIds.length, leaked: JSON.stringify(bodies).includes('PRIVATE'), frames: bodies.flatMap((body) => body.events.map((event) => event.error.frames)) }));
`;
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source],
      { timeout: 3000 },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      acknowledged: 3,
      leaked: false,
      frames: [[], [], []],
    });
  });
  it.each(['name', 'message'] as const)(
    'regression: changing Error %s after stack materialization must not upload the original private message',
    async (field) => {
      const transport = accept();
      const client = browser({ transport });
      const error = new Error(
        'private\n    at PRIVATE_MESSAGE (/customer/PRIVATE_ACCOUNT.txt:123:4)',
      );
      void error.stack;
      error[field] = field === 'name' ? 'RenamedError' : 'Changed message';
      const id = client.captureError(error);
      const result = client.flush();
      await settle();
      expect((await result).acknowledgedIds).toEqual([id]);
      const body = wireBody(transport.mock.calls[0][1]);
      expect(body).not.toContain('PRIVATE_MESSAGE');
      expect(body).not.toContain('PRIVATE_ACCOUNT');
      expect(payload(transport.mock.calls[0][1]).events[0]).toMatchObject({
        error: { frames: [] },
      });
    },
  );
  it.each(['name', 'message'] as const)(
    'regression: a parseable stale Error header must not become a browser frame after %s changes',
    async (field) => {
      const transport = accept();
      const client = browser({ transport });
      const error = new Error('PRIVATE_MESSAGE@/customer/PRIVATE_ACCOUNT.txt:123:4');
      void error.stack;
      error[field] = field === 'name' ? 'RenamedError' : 'Changed message';
      const id = client.captureError(error);
      const result = client.flush();
      await settle();
      expect((await result).acknowledgedIds).toEqual([id]);
      expect(wireBody(transport.mock.calls[0][1])).not.toContain('PRIVATE');
      expect(payload(transport.mock.calls[0][1]).events[0]).toMatchObject({
        error: { frames: [] },
      });
    },
  );
  it('ignores V8 and Firefox text frames without inventing or uploading positions', async () => {
    const transport = accept();
    const client = browser({ transport });
    client.captureError({
      name: 'Error',
      message: 'private',
      stack: [
        'Error: private',
        '    at async run (https://example.com/chunk.js?secret=value#fragment:12:4)',
        '    at async file:///srv/worker.js:2:1',
        'render@webpack-internal:///./src/view.tsx:30:9',
        '@webpack:///src/index.js:1:1',
        '    at execute (C:\\build\\app.js:8:2)',
        '    at node:internal/modules/run_main:10:1',
        '    at unknown (/srv/unknown.js)',
        '    at invalid (/srv/zero.js:0:1)',
        '    at invalid (/srv/zero-column.js:1:0)',
        '    at invalid (/srv/unsafe.js:9007199254740992:1)',
        '    at unsafe (https://user:PRIVATE_PASSWORD@example.com/app.js:1:1)',
        '    at unsafe (javascript:PRIVATE_INLINE_SOURCE:1:1)',
      ].join('\n'),
    });
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toHaveLength(1);
    expect(payload(transport.mock.calls[0][1]).events[0].error!.frames).toEqual([]);
    expect(wireBody(transport.mock.calls[0][1])).not.toContain('PRIVATE');
  });
  it('ignores headerless browser text frames without including the error message', async () => {
    const transport = accept();
    const client = browser({ transport });
    client.captureError({
      name: 'Error',
      message: 'PRIVATE_MESSAGE',
      stack: 'render@https://example.com/view.js?token=PRIVATE_QUERY:12:4',
    });
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toHaveLength(1);
    expect(payload(transport.mock.calls[0][1]).events[0].error!.frames).toEqual([]);
    expect(wireBody(transport.mock.calls[0][1])).not.toContain('PRIVATE');
  });
  it('contains a throwing message getter and does not parse a stack-length message prefix', async () => {
    const transport = accept();
    const client = browser({ transport });
    const unreadable = Object.defineProperty({ name: 'Error', stack: '' }, 'message', {
      get() {
        throw new Error('private');
      },
    });
    expect(() => client.captureError(unreadable)).not.toThrow();
    client.captureError(new Error('private'.repeat(10000)));
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toHaveLength(2);
    const events = payload(transport.mock.calls[0][1]).events;
    expect(events.map((event) => event.error!.frames)).toEqual([[], []]);
    expect(wireBody(transport.mock.calls[0][1])).not.toContain('private');
  });
  it('bounds error context without parsing stack text and deduplicates only the same Error in a finite window', async () => {
    const transport = accept();
    const client = browser({ transport });
    const error = new Error('same');
    error.stack = `Error: same\n${Array.from({ length: 50 }, (_, index) => ` at fn (/long/${'a'.repeat(490)}.js:${index + 1}:2)`).join('\n')}`;
    const first = client.captureError(error, { route: '/route/' + 'a'.repeat(512) });
    expect(client.captureError(error)).toBe(first);
    expect(client.captureError(new Error('same'))).not.toBe(first);
    await settle(1001);
    expect(client.captureError(error)).not.toBe(first);
    const result = client.flush();
    await settle();
    await result;
    const firstEvent = payload(transport.mock.calls[0][1]).events[0];
    expect(new TextEncoder().encode(JSON.stringify(firstEvent)).byteLength).toBeLessThanOrEqual(
      8192,
    );
    expect(firstEvent.truncated).toBe(true);
    expect(firstEvent.error?.frames).toEqual([]);
  });
  it('samples only when configured and marks the retained event ratio', async () => {
    const transport = accept();
    const client = browser({ transport, sampleRate: { event: 0.25 } });
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    expect(client.track('model_viewed')).toBeNull();
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const id = client.track('model_viewed');
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toEqual([id]);
    expect(payload(transport.mock.calls[0][1]).events[0].sample_rate).toBe(0.25);
  });
  it('keeps server user context per call and excludes browser credentials and global user methods', async () => {
    const transport = accept();
    const { projectKey: _key, captureGlobalErrors: _capture, ...base } = options();
    const client = createServerClient({ ...base, writeToken: 'private-write-token', transport });
    clients.push(client);
    expect('setUser' in client).toBe(false);
    expect('reset' in client).toBe(false);
    client.track('model_viewed', {}, { userId: 'request-user' });
    client.track('model_viewed');
    const result = client.flush();
    await settle();
    await result;
    const sent = payload(transport.mock.calls[0][1]);
    expect(sent.project_key).toBeUndefined();
    expect(sent.events[1].context).toEqual({});
    expect(transport.mock.calls[0][1]?.headers).toMatchObject({
      authorization: 'Bearer private-write-token',
    });
  });
});

describe('SDK bounded scheduling and delivery', () => {
  it.each(['flush', 'close'] as const)(
    'regression: wall-clock rollback must not extend the %s deadline',
    async (operation) => {
      let resolveRequest: (() => void) | undefined;
      let signal: AbortSignal | undefined;
      const transport = vi.fn<typeof fetch>(
        async (_url, init) =>
          await new Promise<Response>((resolve) => {
            signal = init?.signal as AbortSignal;
            resolveRequest = () => resolve(acknowledgement(payload(init)));
          }),
      );
      const client = browser({ transport });
      const id = client.track('model_viewed');
      const wall = Date.now();
      let completed = false;
      const pending = client[operation]({ timeoutMs: 30 }).then((result) => {
        completed = true;
        return result;
      });
      try {
        await settle(1);
        vi.setSystemTime(wall - 3600000);
        await settle(30);
        expect(completed).toBe(true);
        expect(await pending).toMatchObject({ pendingIds: [id], timedOut: true });
        expect(signal?.aborted).toBe(operation === 'close');
        if (operation === 'close') {
          expect(client.getDiagnostics()).toMatchObject({ state: 'closed', queuedEvents: 0 });
          expect(vi.getTimerCount()).toBe(0);
        }
      } finally {
        vi.setSystemTime(wall + 31);
        resolveRequest?.();
        await settle(1);
        await client.close({ timeoutMs: 0 });
        await pending;
      }
    },
  );
  it('regression: wall-clock rollback must not postpone an automatic event send', async () => {
    const transport = accept();
    const client = browser({ transport });
    client.track('model_viewed');
    vi.setSystemTime(Date.now() - 3600000);
    await settle(1000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(client.getDiagnostics().queuedEvents).toBe(0);
  });
  it('regression: wall-clock rollback must not restart or stall the event retry budget', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const transport = vi.fn<typeof fetch>(async () => failure(503, 'storage_unavailable'));
    const client = browser({
      transport,
      limits: { retryBaseMs: 5, retryMaxMs: 5, retryBudgetMs: 20 },
    });
    client.track('model_viewed');
    let completed = false;
    const pending = client.flush({ timeoutMs: 30 }).then((result) => {
      completed = true;
      return result;
    });
    await settle(1);
    vi.setSystemTime(Date.now() - 3600000);
    await settle(30);
    expect(completed).toBe(true);
    expect(await pending).toMatchObject({ pendingIds: [], droppedCount: 1, timedOut: false });
    expect(transport).toHaveBeenCalledTimes(5);
  });
  it('regression: wall-clock rollback must not extend Error object deduplication', async () => {
    const transport = accept();
    const client = browser({ transport });
    const error = new Error('private');
    const first = client.captureError(error);
    await settle(1);
    vi.setSystemTime(Date.now() - 3600000);
    await settle(1001);
    const second = client.captureError(error);
    expect(second).not.toBe(first);
    await settle(1);
    expect(
      transport.mock.calls.flatMap((call) => payload(call[1]).events.map((event) => event.id)),
    ).toEqual([first, second]);
  });
  it('reserves error capacity and sends errors before ordinary events in one request at a time', async () => {
    const transport = accept();
    const client = browser({ transport, limits: { queueCapacity: 4, errorReserve: 2 } });
    client.track('model_viewed');
    client.track('model_viewed');
    expect(client.track('model_viewed')).toBeNull();
    const errorId = client.captureError(new Error('failure'));
    await settle();
    expect(payload(transport.mock.calls[0][1]).events.map((event) => event.id)).toEqual([errorId]);
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toHaveLength(2);
    expect(client.getDiagnostics().queuedEvents).toBe(0);
  });
  it('prioritizes error admission by evicting ordinary events while respecting total bytes', async () => {
    const transport = accept();
    const client = browser({
      transport,
      limits: { queueCapacity: 3, errorReserve: 0, queueBytes: 1000 },
    });
    client.track('model_viewed', { model_id: 'a'.repeat(200) });
    client.track('model_viewed', { model_id: 'b'.repeat(200) });
    expect(client.captureError({ name: 'Error', stack: 'Error: failure' })).not.toBeNull();
    expect(client.getDiagnostics().queuedBytes).toBeLessThanOrEqual(1000);
    expect(client.getDiagnostics().dropped.evicted_event).toBeGreaterThan(0);
    const result = client.flush();
    await settle();
    await result;
  });
  it('bounds queue memory including events already in flight', async () => {
    const transport = vi.fn<typeof fetch>(() => new Promise(() => undefined));
    const client = browser({ transport, limits: { queueCapacity: 2, errorReserve: 0 } });
    client.track('model_viewed');
    const result = client.flush({ timeoutMs: 10 });
    await settle();
    client.track('model_viewed');
    expect(client.track('model_viewed')).toBeNull();
    expect(client.getDiagnostics().queuedEvents).toBe(2);
    expect(transport).toHaveBeenCalledTimes(1);
    await settle(10);
    expect((await result).timedOut).toBe(true);
  });
  it('retries the same immutable body on another endpoint after an unknown network outcome', async () => {
    let first = true;
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      if (first) {
        first = false;
        throw new Error('offline');
      }
      return acknowledgement(payload(init));
    });
    const client = browser({ transport, limits: { retryBaseMs: 10 } });
    const id = client.track('model_viewed', { model_id: 'm' });
    const result = client.flush();
    await settle(30);
    expect((await result).acknowledgedIds).toEqual([id]);
    expect(transport.mock.calls[0][1]?.body).toBe(transport.mock.calls[1][1]?.body);
    expect(transport.mock.calls.map((call) => call[0])).toEqual([
      'https://first.example/v1/ingest/browser',
      'https://second.example/v1/ingest/browser',
    ]);
  });
  it.each([
    'missing',
    'duplicate',
    'foreign',
    'wrong-source',
    'wrong-project',
    'wrong-environment',
    'wrong-service',
    'extra-field',
    'bad-retention',
  ])('rejects invalid successful ACK: %s', async (mode) => {
    let attempts = 0;
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = payload(init);
      attempts += 1;
      if (attempts > 1) return acknowledgement(body);
      const valid = (await acknowledgement(body).json()) as Record<string, unknown>;
      if (mode === 'missing') valid.acknowledged = [];
      if (mode === 'duplicate') valid.acknowledged = [body.events[0], body.events[0]];
      if (mode === 'foreign')
        valid.acknowledged = [
          {
            id: requestId,
            status: 'stored',
            received_at: '2026-11-01T02:00:01.000Z',
            retain_until: '2026-12-01T02:00:01.000Z',
          },
        ];
      if (mode === 'wrong-source') valid.source = 'server';
      if (mode === 'wrong-project') valid.project_id = requestId;
      if (mode === 'wrong-environment') valid.environment = 'staging';
      if (mode === 'wrong-service') valid.service = 'other-service';
      if (mode === 'extra-field') valid.secret = 'unexpected';
      if (mode === 'bad-retention')
        valid.acknowledged = [
          {
            id: body.events[0].id,
            status: 'stored',
            received_at: '2026-11-01T02:00:01.000Z',
            retain_until: '2026-10-01T02:00:01.000Z',
          },
        ];
      return Response.json(valid);
    });
    const client = browser({ transport, limits: { retryBaseMs: 10 } });
    const id = client.track('model_viewed');
    const result = client.flush();
    await settle(30);
    expect((await result).acknowledgedIds).toEqual([id]);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('rejects structurally valid duplicate ACK IDs even when the ACK count matches the batch', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const body = payload(init);
      if (transport.mock.calls.length > 1) return acknowledgement(body);
      const valid = (await acknowledgement(body).json()) as { acknowledged: unknown[] };
      valid.acknowledged = [valid.acknowledged[0], valid.acknowledged[0]];
      return Response.json(valid);
    });
    const client = browser({ transport, limits: { retryBaseMs: 10 } });
    const ids = [client.track('model_viewed'), client.track('model_viewed')];
    const result = client.flush();
    await settle(1);
    expect(await client.flush({ timeoutMs: 0 })).toMatchObject({
      acknowledgedIds: [],
      pendingIds: ids,
      droppedCount: 0,
      timedOut: true,
    });
    await settle(30);
    expect((await result).acknowledgedIds).toEqual(ids);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(wireBody(transport.mock.calls[0][1])).toBe(wireBody(transport.mock.calls[1][1]));
  });
  it('accepts reordered stored and already-present ACKs for exactly the submitted IDs', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      const valid = (await acknowledgement(payload(init)).json()) as {
        acknowledged: { id: string; status: string }[];
      };
      valid.acknowledged.reverse();
      valid.acknowledged[0].status = 'already_present';
      return Response.json(valid);
    });
    const client = browser({ transport });
    const ids = [client.track('model_viewed'), client.track('model_viewed')];
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toEqual(ids);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(client.getDiagnostics()).toMatchObject({ queuedEvents: 0, queuedBytes: 0, dropped: {} });
  });
  it('keeps the first acknowledged project identity when later responses switch projects', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init): Promise<Response> =>
      acknowledgement(
        payload(init),
        transport.mock.calls.length === 2 ? { project_id: requestId } : {},
      ),
    );
    const client = browser({ transport, projectId: undefined, limits: { retryBaseMs: 10 } });
    const firstId = client.track('model_viewed');
    const first = client.flush();
    await settle();
    expect((await first).acknowledgedIds).toEqual([firstId]);
    const secondId = client.track('model_viewed');
    const second = client.flush();
    await settle(1);
    expect(await client.flush({ timeoutMs: 0 })).toMatchObject({
      acknowledgedIds: [],
      pendingIds: [secondId],
      timedOut: true,
    });
    await settle(30);
    expect((await second).acknowledgedIds).toEqual([secondId]);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(wireBody(transport.mock.calls[1][1])).toBe(wireBody(transport.mock.calls[2][1]));
  });
  it('honors Retry-After on the same endpoint and never overlaps requests', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init): Promise<Response> =>
      transport.mock.calls.length === 1
        ? failure(429, 'quota_exceeded', { retry_after_ms: 1500 }, { 'retry-after': '2' })
        : acknowledgement(payload(init)),
    );
    const client = browser({ transport });
    client.track('model_viewed');
    const result = client.flush();
    await settle(1999);
    expect(transport).toHaveBeenCalledTimes(1);
    await settle(2);
    expect((await result).acknowledgedIds).toHaveLength(1);
    expect(transport.mock.calls[1][0]).toBe(transport.mock.calls[0][0]);
  });
  it.each(['text', 'invalid-schema', 'invalid-items', 'empty'])(
    'regression: a %s 429 body must not bypass Retry-After or rotate endpoints',
    async (mode) => {
      const transport = vi.fn<typeof fetch>(async (_url, init) => {
        if (transport.mock.calls.length > 1) return acknowledgement(payload(init));
        const headers = { 'retry-after': '1' };
        if (mode === 'text') return new Response('Rate limited', { status: 429, headers });
        if (mode === 'empty') return new Response(null, { status: 429, headers });
        if (mode === 'invalid-schema')
          return Response.json({ message: 'Rate limited' }, { status: 429, headers });
        return failure(
          429,
          'quota_exceeded',
          { items: [{ index: 99, reason: 'invalid' }] },
          headers,
        );
      });
      const client = browser({ transport, limits: { retryBaseMs: 10, retryMaxMs: 10 } });
      const original = client.track('model_viewed');
      const result = client.flush();
      await settle();
      const added = client.captureError(new Error('new error'));
      await client.flush({ timeoutMs: 0 });
      await settle(998);
      expect(transport).toHaveBeenCalledTimes(1);
      await settle(2);
      expect((await result).acknowledgedIds).toEqual([added, original]);
      expect(transport.mock.calls.map((call) => call[0])).toEqual([
        'https://first.example/v1/ingest/browser',
        'https://first.example/v1/ingest/browser',
      ]);
    },
  );
  it('regression: a stalled 429 response body must not turn its request timeout into endpoint failover', async () => {
    const cancel = vi.fn();
    const transport = vi.fn<typeof fetch>(async (_url, init): Promise<Response> =>
      transport.mock.calls.length === 1
        ? new Response(new ReadableStream({ cancel }), {
            status: 429,
            headers: { 'retry-after': '1' },
          })
        : acknowledgement(payload(init)),
    );
    const client = browser({
      transport,
      limits: { requestTimeoutMs: 10, retryBaseMs: 1, retryMaxMs: 1 },
    });
    const id = client.track('model_viewed');
    const pending = client.flush();
    await settle(1000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
    await settle(20);
    expect((await pending).acknowledgedIds).toEqual([id]);
    expect(transport.mock.calls[1][0]).toBe(transport.mock.calls[0][0]);
    expect(transport.mock.calls[1][1]?.body).toBe(transport.mock.calls[0][1]?.body);
  });
  it('regression: a large Retry-After must not overflow timers into a busy loop', async () => {
    const module = new URL('../browser.ts', import.meta.url).href;
    const source = `
import { createBrowserClient } from ${JSON.stringify(module)};
import { setImmediate } from 'node:timers/promises';
let overflowWarnings = 0;
let requests = 0;
process.on('warning', (warning) => { if (warning.name === 'TimeoutOverflowWarning') overflowWarnings++; });
const client = createBrowserClient({ endpoints: ['https://first.example/ingest'], projectKey: 'pub_example', environment: 'test', service: 'web', release: '1', buildId: '1', events: { viewed: {} }, captureGlobalErrors: false,
  transport: async () => { requests++; return new Response('quota', { status: 429, headers: { 'retry-after': '9999999999' } }); }
});
client.track('viewed');
await client.flush({ timeoutMs: 100 });
client.track('viewed');
await setImmediate();
await client.close({ timeoutMs: 0 });
console.log(JSON.stringify({ requests, overflowWarnings }));
`;
    const result = await promisify(execFile)(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', source],
      { timeout: 3000 },
    );
    expect(JSON.parse(result.stdout)).toEqual({ requests: 1, overflowWarnings: 0 });
  });
  it('does not bypass instance Retry-After with a new error, flush, or Beacon', async () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      addEventListener(name: string, callback: EventListener) {
        listeners.set(name, callback);
      },
      removeEventListener(name: string) {
        listeners.delete(name);
      },
    });
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const transport = vi.fn<typeof fetch>(async (_url, init): Promise<Response> =>
      transport.mock.calls.length === 1
        ? failure(429, 'quota_exceeded', { retry_after_ms: 2000 }, { 'retry-after': '2' })
        : acknowledgement(payload(init)),
    );
    const client = browser({ transport, captureGlobalErrors: true });
    const original = client.track('model_viewed');
    const result = client.flush();
    await settle(28);
    const added = client.captureError(new Error('new error'));
    listeners.get('visibilitychange')?.({} as Event);
    expect(beacon).not.toHaveBeenCalled();
    const additionalFlush = client.flush();
    await settle(100);
    listeners.get('visibilitychange')?.({} as Event);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(beacon).not.toHaveBeenCalled();
    await settle(1873);
    expect((await result).acknowledgedIds).toEqual([added, original]);
    expect((await additionalFlush).acknowledgedIds).toEqual([added, original]);
    expect(transport.mock.calls[1][0]).toBe(transport.mock.calls[0][0]);
  });
  it('does not bypass instance quota backoff when Retry-After is absent', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const transport = vi.fn<typeof fetch>(async (_url, init): Promise<Response> =>
      transport.mock.calls.length === 1
        ? failure(429, 'quota_exceeded')
        : acknowledgement(payload(init)),
    );
    const client = browser({ transport });
    const original = client.captureError(new Error('original'));
    const result = client.flush();
    await settle(10);
    const added = client.captureError(new Error('new error'));
    await settle(989);
    expect(transport).toHaveBeenCalledTimes(1);
    await settle(2);
    expect((await result).acknowledgedIds).toEqual([original, added]);
    expect(transport.mock.calls[1][0]).toBe(transport.mock.calls[0][0]);
  });
  it('drops conflicts by validated index then regroups unchanged survivors once', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init): Promise<Response> =>
      transport.mock.calls.length === 1
        ? failure(409, 'event_conflict', {
            items: [{ index: 0, id: payload(init).events[0].id, reason: 'payload_mismatch' }],
          })
        : acknowledgement(payload(init)),
    );
    const client = browser({ transport, limits: { retryBaseMs: 10 } });
    const conflict = client.track('model_viewed');
    const kept = client.track('model_viewed');
    const result = client.flush();
    await settle(30);
    expect(await result).toEqual({
      acknowledgedIds: [kept],
      pendingIds: [],
      droppedCount: 1,
      timedOut: false,
    });
    expect(payload(transport.mock.calls[1][1]).events.map((event) => event.id)).toEqual([kept]);
    expect(kept).not.toBe(conflict);
  });
  it('does not trust mismatched item IDs to delete unrelated input events', async () => {
    const transport = vi.fn<typeof fetch>(async (_url, init): Promise<Response> =>
      transport.mock.calls.length === 1
        ? failure(422, 'invalid_event', { items: [{ index: 0, id: requestId, reason: 'policy' }] })
        : acknowledgement(payload(init)),
    );
    const client = browser({ transport, limits: { retryBaseMs: 10 } });
    const id = client.track('model_viewed');
    const result = client.flush();
    await settle(30);
    expect(await result).toMatchObject({ acknowledgedIds: [id], droppedCount: 0 });
  });
  it('splits a rejected batch once without recreating event identities', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const transport = vi.fn<typeof fetch>(async (_url, init): Promise<Response> =>
      transport.mock.calls.length === 1
        ? failure(413, 'payload_too_large')
        : acknowledgement(payload(init)),
    );
    const client = browser({ transport, limits: { retryBaseMs: 10 } });
    const ids = [
      client.track('model_viewed'),
      client.track('model_viewed'),
      client.track('model_viewed'),
      client.track('model_viewed'),
    ];
    const result = client.flush();
    await settle(30);
    expect((await result).acknowledgedIds.sort((a, b) => a.localeCompare(b))).toEqual(
      ids.sort((a, b) => (a ?? '').localeCompare(b ?? '')),
    );
    expect(transport.mock.calls.slice(1).map((call) => payload(call[1]).events.length)).toEqual([
      2, 2,
    ]);
  });
  it('exhausts the HTTP attempt budget and reports unconfirmed drops', async () => {
    const transport = vi.fn<typeof fetch>(async () => {
      throw new Error('offline');
    });
    const client = browser({
      transport,
      limits: { maxAttempts: 3, retryBaseMs: 10, retryMaxMs: 20 },
    });
    client.track('model_viewed');
    const result = client.flush();
    await settle(100);
    expect(await result).toEqual({
      acknowledgedIds: [],
      pendingIds: [],
      droppedCount: 1,
      timedOut: false,
    });
    expect(transport).toHaveBeenCalledTimes(3);
    expect(client.getDiagnostics().dropped.retry_attempts).toBe(1);
  });
  it('terminates retries when the server rejects credentials', async () => {
    const transport = vi.fn<typeof fetch>(async () => failure(401, 'unauthenticated'));
    const client = browser({ transport });
    client.track('model_viewed');
    const result = client.flush();
    await settle();
    expect((await result).droppedCount).toBe(1);
    expect(client.track('model_viewed')).toBeNull();
    await settle(60000);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('cancels unresolved requests at close deadline, clears timers, and rejects future capture', async () => {
    let signal: AbortSignal | undefined;
    const transport = vi.fn<typeof fetch>(async (_url, init) => {
      signal = init?.signal as AbortSignal;
      return await new Promise(() => undefined);
    });
    const client = browser({ transport });
    const id = client.track('model_viewed');
    const closing = client.close({ timeoutMs: 20 });
    await settle();
    expect(client.captureError(new Error())).toBeNull();
    await settle(20);
    expect(await closing).toMatchObject({ pendingIds: [id], droppedCount: 2, timedOut: true });
    expect(signal?.aborted).toBe(true);
    expect(client.getDiagnostics()).toMatchObject({
      queuedEvents: 0,
      queuedBytes: 0,
      state: 'closed',
    });
    await settle(100000);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(client.track('model_viewed')).toBeNull();
  });
});

describe('additional delivery boundaries', () => {
  it('defers normal sends to the configured interval and caps batch event count', async () => {
    const transport = accept();
    const client = browser({ transport });
    for (let index = 0; index < 25; index += 1) client.track('model_viewed');
    await settle(999);
    expect(transport).not.toHaveBeenCalled();
    await settle(1);
    expect(transport.mock.calls.map((call) => payload(call[1]).events.length)).toEqual([20, 5]);
  });
  it('caps final JSON batch bytes even when all individual events are legal', async () => {
    const transport = accept();
    const client = browser({ transport, limits: { batchBytes: 900 } });
    const ids = [
      client.track('model_viewed', { model_id: 'a'.repeat(256) }),
      client.track('model_viewed', { model_id: 'b'.repeat(256) }),
    ];
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toEqual(ids);
    expect(transport).toHaveBeenCalledTimes(2);
    for (const call of transport.mock.calls)
      expect(new TextEncoder().encode(wireBody(call[1])).byteLength).toBeLessThanOrEqual(900);
  });
  it('bounds a hung response body by the request deadline then retries with original IDs', async () => {
    const cancel = vi.fn();
    const transport = vi.fn<typeof fetch>(async (_url, init): Promise<Response> =>
      transport.mock.calls.length === 1
        ? new Response(new ReadableStream({ start() {}, cancel }))
        : acknowledgement(payload(init)),
    );
    const client = browser({ transport, limits: { requestTimeoutMs: 10, retryBaseMs: 1 } });
    const id = client.track('model_viewed');
    const result = client.flush();
    await settle(30);
    expect((await result).acknowledgedIds).toEqual([id]);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('drops malformed requests and expired IDs without retrying or recreating them', async () => {
    const transport = vi.fn<typeof fetch>(async () => failure(400, 'invalid_request'));
    const client = browser({ transport });
    client.track('model_viewed');
    const result = client.flush();
    await settle();
    expect((await result).droppedCount).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
    const expiredTransport = vi.fn<typeof fetch>(async () => failure(410, 'event_expired'));
    const expired = browser({ transport: expiredTransport });
    expired.track('model_viewed');
    const expiredResult = expired.flush();
    await settle();
    expect((await expiredResult).droppedCount).toBe(1);
    expect(expired.getDiagnostics().dropped.event_expired).toBe(1);
  });
  it('stops quota retry rather than violating the total retry budget', async () => {
    const transport = vi.fn<typeof fetch>(async () =>
      failure(429, 'quota_exceeded', { retry_after_ms: 61000 }),
    );
    const client = browser({ transport });
    client.track('model_viewed');
    const result = client.flush();
    await settle();
    expect((await result).droppedCount).toBe(1);
    expect(client.getDiagnostics().dropped.retry_budget).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('treats Beacon acceptance as unconfirmed and closes with an explicit unconfirmed drop', async () => {
    const listeners = new Map<string, EventListener>();
    vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {} });
    vi.stubGlobal('document', {
      visibilityState: 'hidden',
      addEventListener(name: string, callback: EventListener) {
        listeners.set(name, callback);
      },
      removeEventListener(name: string) {
        listeners.delete(name);
      },
    });
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const transport = accept();
    const client = browser({ captureGlobalErrors: true, transport });
    const id = client.track('model_viewed');
    listeners.get('visibilitychange')?.({} as Event);
    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0]).toHaveLength(2);
    const blob = beacon.mock.calls[0] as unknown as [string, Blob];
    expect(blob[1].type).toBe('application/json');
    const wire = JSON.parse(await blob[1].text()) as Envelope;
    expect(wire.events[0].id).toBe(id);
    const result = await client.close({ timeoutMs: 0 });
    expect(result.acknowledgedIds).toEqual([]);
    expect(result.pendingIds).toEqual([id]);
    expect(result.droppedCount).toBe(1);
    expect(transport).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });
});

describe('framework and browser lifecycle', () => {
  it.each(['pagehide', 'visibilitychange'])(
    'regression: disabling global errors must preserve %s Beacon delivery for manual events',
    async (eventName) => {
      const target = new EventTarget();
      const document = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
      vi.stubGlobal('window', target);
      vi.stubGlobal('document', document);
      const beacon = vi.fn(() => true);
      vi.stubGlobal('navigator', { sendBeacon: beacon });
      const transport = accept();
      const client = browser({ captureGlobalErrors: false, transport });
      const id = client.track('model_viewed');
      target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('private') }));
      target.dispatchEvent(
        Object.assign(new Event('unhandledrejection'), { reason: new Error('private') }),
      );
      (eventName === 'pagehide' ? target : document).dispatchEvent(new Event(eventName));
      expect(beacon).toHaveBeenCalledTimes(1);
      const [, blob] = beacon.mock.calls[0] as unknown as [string, Blob];
      expect((JSON.parse(await blob.text()) as Envelope).events.map((event) => event.id)).toEqual([
        id,
      ]);
      expect(client.getDiagnostics().queuedEvents).toBe(1);
      expect(transport).not.toHaveBeenCalled();
      await client.close({ timeoutMs: 0 });
      target.dispatchEvent(new Event('pagehide'));
      document.dispatchEvent(new Event('visibilitychange'));
      expect(beacon).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('regression: the latest manual-only instance must receive Beacon without disabling an earlier automatic error subscriber', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const beacon = vi.fn(() => true);
    vi.stubGlobal('navigator', { sendBeacon: beacon });
    const firstTransport = accept();
    const secondTransport = accept();
    const first = browser({ captureGlobalErrors: true, transport: firstTransport });
    const second = browser({ captureGlobalErrors: false, transport: secondTransport });
    const secondId = second.track('model_viewed');
    target.dispatchEvent(Object.assign(new Event('error'), { error: new Error('private') }));
    await settle(1);
    expect(payload(firstTransport.mock.calls[0][1]).events[0].error?.mechanism).toBe(
      'window_error',
    );
    expect(secondTransport).not.toHaveBeenCalled();
    target.dispatchEvent(new Event('pagehide'));
    expect(beacon).toHaveBeenCalledTimes(1);
    const secondBlob = (beacon.mock.calls[0] as unknown as [string, Blob])[1];
    expect(
      (JSON.parse(await secondBlob.text()) as Envelope).events.map((event) => event.id),
    ).toEqual([secondId]);
    await second.close({ timeoutMs: 0 });
    const firstId = first.track('model_viewed');
    target.dispatchEvent(new Event('pagehide'));
    expect(beacon).toHaveBeenCalledTimes(2);
    const firstBlob = (beacon.mock.calls[1] as unknown as [string, Blob])[1];
    expect(
      (JSON.parse(await firstBlob.text()) as Envelope).events.map((event) => event.id),
    ).toEqual([firstId]);
    await first.close({ timeoutMs: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('installs one global listener set across instances and restores the previous scope subscriber on close', async () => {
    const listeners = new Map<string, EventListener>();
    const add = vi.fn((name: string, handler: EventListener) => listeners.set(name, handler));
    const remove = vi.fn((name: string) => listeners.delete(name));
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove });
    const firstTransport = accept();
    const secondTransport = accept();
    const first = browser({ captureGlobalErrors: true, transport: firstTransport });
    const second = browser({ captureGlobalErrors: true, transport: secondTransport });
    expect(add).toHaveBeenCalledTimes(3);
    listeners.get('error')?.({ error: new Error('observed') } as unknown as Event);
    await settle();
    expect(firstTransport).not.toHaveBeenCalled();
    expect(secondTransport).toHaveBeenCalledTimes(1);
    await second.close();
    listeners.get('unhandledrejection')?.({ reason: new Error('rejection') } as unknown as Event);
    await settle();
    expect(payload(firstTransport.mock.calls[0][1]).events[0].error).toMatchObject({
      mechanism: 'unhandled_rejection',
      handled: false,
    });
    await first.close();
    expect(remove).toHaveBeenCalledTimes(3);
  });
  it('keeps one global listener set after hot module replacement and captures with the replacement instance', async () => {
    const listeners = new Map<string, EventListener>();
    const add = vi.fn((name: string, handler: EventListener) => listeners.set(name, handler));
    const remove = vi.fn((name: string) => listeners.delete(name));
    vi.stubGlobal('window', { addEventListener: add, removeEventListener: remove });
    const first = browser({ captureGlobalErrors: true, transport: accept() });
    vi.resetModules();
    const replacementModule = await import('../browser.js');
    const transport = accept();
    const replacement = replacementModule.createBrowserClient(
      options({ captureGlobalErrors: true, transport }),
    );
    clients.push(replacement);
    listeners.get('error')?.({ error: new Error('replacement') } as unknown as Event);
    await settle();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(3);
    await replacement.close();
    await first.close();
    expect(remove).toHaveBeenCalledTimes(3);
  });
  it('initializes Next client synchronously and marks handled results while excluding expected control flow', async () => {
    const transport = accept();
    const client = initializeNextClient(options({ transport }));
    clients.push(client);
    expect(
      captureHandledResult(client, Object.assign(new Error(), { name: 'AbortError' })),
    ).toBeNull();
    expect(
      captureHandledResult(client, { digest: 'NEXT_REDIRECT;replace;/login;307;' }),
    ).toBeNull();
    expect(captureHandledResult(client, { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' })).toBeNull();
    const id = captureClientHandledResult(client, new Error('business-failure'), {
      operation: 'generate',
    });
    const result = client.flush();
    await settle();
    expect((await result).acknowledgedIds).toEqual([id]);
    expect(payload(transport.mock.calls[0][1]).events[0].error).toMatchObject({
      mechanism: 'handled_result',
      handled: true,
    });
  });
  it('captures Next request errors using route templates and bounds request-hook waiting', async () => {
    const transport = accept();
    const { projectKey: _key, captureGlobalErrors: _capture, ...base } = options();
    const client = createServerClient({ ...base, writeToken: 'private-token', transport });
    clients.push(client);
    const hook = createOnRequestError(client, { timeoutMs: 20 });
    const result = hook(
      new Error('private-next-hook-message'),
      {
        path: '/users/private-next-hook-user?token=private-next-hook-query',
        method: 'GET',
        headers: { authorization: 'private-next-hook-authorization' },
      },
      {
        routerKind: 'App Router',
        routePath: '/users/[id]',
        routeType: 'render',
        revalidateReason: undefined,
      },
    );
    await settle();
    await result;
    const event = payload(transport.mock.calls[0][1]).events[0];
    expect(event.context).toEqual({ route: '/users/[id]' });
    expect(event.error?.mechanism).toBe('next_request');
    for (const sensitive of [
      'private-next-hook-message',
      'private-next-hook-user',
      'private-next-hook-query',
      'private-next-hook-authorization',
    ])
      expect(wireBody(transport.mock.calls[0][1])).not.toContain(sensitive);
  });
});
