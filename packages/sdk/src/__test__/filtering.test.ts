import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserClient } from '../browser.js';
import { createServerClient } from '../server.js';
import type { BrowserOptions, CaptureEvent, TelemetryClient } from '../types.js';
import type { Envelope } from '../../../protocol/src/types.js';

const clients: TelemetryClient[] = [];
const projectId = '0fcff045-b764-4f86-a82d-5b999b4b8a4f';
function options(overrides: Partial<BrowserOptions> = {}): BrowserOptions {
  return {
    endpoints: ['https://telemetry.example/v1/ingest/browser'],
    projectKey: 'public-example',
    projectId,
    environment: 'production',
    service: 'web',
    release: '1',
    buildId: 'web-1',
    events: { action: { status: { type: 'string', enum: ['ok', 'noise'] } } },
    captureGlobalErrors: false,
    ...overrides,
  };
}
function browser(overrides: Partial<BrowserOptions> = {}) {
  const client = createBrowserClient(options(overrides));
  clients.push(client);
  return client;
}
function payload(init: RequestInit | undefined): Envelope {
  if (typeof init?.body !== 'string') throw new Error('Expected JSON string');
  return JSON.parse(init.body) as Envelope;
}
function accept() {
  return vi.fn<typeof fetch>(async (_url, init) => {
    const body = payload(init);
    return Response.json({
      request_id: 'ee31edb7-81b7-4c6d-afba-225a54f1c4b5',
      project_id: projectId,
      environment: body.environment,
      source: body.project_key ? 'browser' : 'server',
      service: body.service,
      acknowledged: body.events.map(({ id }) => ({
        id,
        status: 'stored',
        received_at: '2026-11-01T02:00:01.000Z',
        retain_until: '2026-12-01T02:00:01.000Z',
      })),
    });
  });
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

describe('capture filtering', () => {
  it('filters ordinary events and normalized errors before queue admission', async () => {
    const transport = accept();
    const eventFilter = vi.fn((event: CaptureEvent) =>
      event.kind === 'event'
        ? event.properties.status !== 'noise'
        : event.error?.type !== 'TypeError',
    );
    const client = browser({ transport, eventFilter });
    expect(client.track('action', { status: 'noise' })).toBeNull();
    expect(client.captureError(new TypeError('private'))).toBeNull();
    const eventId = client.track('action', { status: 'ok' });
    const errorId = client.captureError(new Error('private'));
    const result = client.flush();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).acknowledgedIds).toEqual([errorId, eventId]);
    expect(eventFilter).toHaveBeenCalledTimes(4);
    expect(client.getDiagnostics().dropped).toEqual({ filtered: 2 });
    expect(payload(transport.mock.calls[0][1]).events.map(({ id }) => id)).toEqual([
      errorId,
      eventId,
    ]);
  });

  it('exposes only sanitized deeply immutable snapshots and does not rerun filtering on retries', async () => {
    const acceptTransport = accept();
    const transport = vi.fn<typeof fetch>(async (url, init) => {
      if (transport.mock.calls.length === 1) throw new Error('lost response');
      return acceptTransport(url, init);
    });
    let observed: CaptureEvent | undefined;
    const eventFilter = vi.fn((event: CaptureEvent) => {
      observed = event;
      return true;
    });
    const client = browser({ transport, eventFilter, limits: { retryBaseMs: 10 } });
    const error = new Error('private-message');
    error.stack =
      'Error: private-message\n    at run (https://app.example/app.js?token=private:8:4)';
    const id = client.captureError(error, { route: '/account?token=private#secret' });
    expect(observed?.context?.route).toBe('/account');
    expect(observed?.error?.frames).toEqual([]);
    expect(JSON.stringify(observed)).not.toContain('private');
    expect(Reflect.set(observed!, 'name', 'injected')).toBe(false);
    expect(Reflect.set(observed!.properties, 'secret', 'private')).toBe(false);
    expect(Reflect.set(observed!.context!, 'route', '/secret')).toBe(false);
    expect(Reflect.set(observed!.error!, 'safe_message', 'private')).toBe(false);
    expect(Reflect.set(observed!.error!.frames, 'length', 0)).toBe(false);
    expect(Reflect.set(observed!.error!.frames, '0', { file: '/secret' })).toBe(false);
    expect(client.captureError(error)).toBe(id);
    const result = client.flush();
    await vi.advanceTimersByTimeAsync(30);
    expect((await result).acknowledgedIds).toEqual([id]);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0][1]?.body).toBe(transport.mock.calls[1][1]?.body);
    expect(eventFilter).toHaveBeenCalledTimes(1);
  });

  it('rejects throwing filters without evicting an already queued ordinary event', async () => {
    const transport = accept();
    const client = browser({
      transport,
      limits: { queueCapacity: 1, errorReserve: 0 },
      eventFilter(event) {
        if (event.kind === 'error') throw new Error('filter failure');
        return true;
      },
    });
    const id = client.track('action');
    expect(client.captureError(new Error('private'))).toBeNull();
    expect(client.getDiagnostics()).toMatchObject({
      queuedEvents: 1,
      dropped: { filter_failure: 1 },
    });
    const result = client.flush();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).acknowledgedIds).toEqual([id]);
  });

  it('rejects false filters without evicting an already queued ordinary event', () => {
    const client = browser({
      limits: { queueCapacity: 1, errorReserve: 0 },
      eventFilter: (event) => event.kind === 'event',
    });
    expect(client.track('action')).not.toBeNull();
    expect(client.captureError(new Error('noise'))).toBeNull();
    expect(client.getDiagnostics()).toMatchObject({ queuedEvents: 1, dropped: { filtered: 1 } });
  });

  it.each([undefined, null, 1, 'true', {}, Promise.resolve(true)])(
    'rejects non-boolean filter results without sending: %s',
    async (value) => {
      const transport = accept();
      const client = browser({
        transport,
        eventFilter: (() => value) as NonNullable<BrowserOptions['eventFilter']>,
      });
      expect(client.track('action')).toBeNull();
      expect(client.getDiagnostics().dropped).toEqual({ filter_failure: 1 });
      expect(await client.flush()).toMatchObject({ acknowledgedIds: [], pendingIds: [] });
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it('contains rejected async filters without an unhandled rejection or queued data', async () => {
    const client = browser({
      eventFilter: (async () => {
        throw new Error('private');
      }) as unknown as NonNullable<BrowserOptions['eventFilter']>,
    });
    expect(client.captureError(new Error('private'))).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.getDiagnostics()).toMatchObject({
      queuedEvents: 0,
      dropped: { filter_failure: 1 },
    });
  });

  it('blocks recursive capture from a filter and keeps the outer event', () => {
    const eventFilter = vi.fn(() => {
      expect(client.track('action')).toBeNull();
      expect(client.captureError(new Error('nested'))).toBeNull();
      return true;
    });
    const client = browser({ eventFilter });
    expect(client.track('action')).not.toBeNull();
    expect(eventFilter).toHaveBeenCalledTimes(1);
    expect(client.getDiagnostics()).toMatchObject({
      queuedEvents: 1,
      dropped: { filter_failure: 2 },
    });
  });

  it('does not enqueue an accepted event after the filter closes its client', async () => {
    let closing: ReturnType<TelemetryClient['close']> | undefined;
    const client = browser({
      eventFilter: () => {
        closing = client.close({ timeoutMs: 0 });
        return true;
      },
    });
    expect(client.track('action')).toBeNull();
    await closing;
    expect(client.getDiagnostics()).toMatchObject({
      state: 'closed',
      queuedEvents: 0,
      queuedBytes: 0,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not pass invalid input to a filter and supports the server public entrypoint', async () => {
    const transport = accept();
    const eventFilter = vi.fn(() => true);
    const { projectKey: _projectKey, captureGlobalErrors: _capture, ...common } = options();
    const client = createServerClient({
      ...common,
      writeToken: 'write-secret',
      transport,
      eventFilter,
    });
    clients.push(client);
    expect(client.track('unknown')).toBeNull();
    expect(client.track('action', { secret: 'private' })).toBeNull();
    const id = client.captureError(new Error('private'));
    const result = client.flush();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).acknowledgedIds).toEqual([id]);
    expect(eventFilter).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(eventFilter.mock.calls)).not.toContain('write-secret');
  });

  it('rejects non-function filters at construction', () => {
    expect(() =>
      browser({ eventFilter: true as unknown as BrowserOptions['eventFilter'] }),
    ).toThrow();
  });

  it('sends only accepted snapshots through Beacon without evaluating the filter again', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const sendBeacon = vi.fn<(url: string, body: Blob) => boolean>(() => true);
    vi.stubGlobal('navigator', { sendBeacon });
    const transport = accept();
    let enabled = true;
    const eventFilter = vi.fn(
      (event: CaptureEvent) => enabled && event.properties.status !== 'noise',
    );
    const client = browser({ captureGlobalErrors: true, transport, eventFilter });
    expect(client.track('action', { status: 'noise' })).toBeNull();
    const id = client.track('action', { status: 'ok' });
    enabled = false;
    target.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = JSON.parse(await sendBeacon.mock.calls[0][1].text()) as Envelope;
    expect(body.events.map((event) => event.id)).toEqual([id]);
    expect(eventFilter).toHaveBeenCalledTimes(2);
    expect(transport).not.toHaveBeenCalled();
    expect(await client.close({ timeoutMs: 0 })).toMatchObject({
      acknowledgedIds: [],
      pendingIds: [id],
    });
    target.dispatchEvent(new Event('pagehide'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('regression: ordinary function filters must not receive private configuration through this', () => {
    const observeReceiver = vi.fn<(receiver: unknown) => void>();
    const { projectKey: _projectKey, captureGlobalErrors: _capture, ...common } = options();
    const client = createServerClient({
      ...common,
      writeToken: 'write-secret',
      eventFilter: function (this: void) {
        observeReceiver(this);
        return false;
      },
    });
    clients.push(client);
    expect(client.captureError(new Error('private'))).toBeNull();
    expect(observeReceiver).toHaveBeenCalledExactlyOnceWith(undefined);
  });
});

describe('category sampling boundaries', () => {
  it.each(['event', 'error'] as const)(
    'disables only %s collection at zero without invoking its filter',
    async (kind) => {
      const transport = accept();
      const eventFilter = vi.fn(() => true);
      const client = browser({ transport, eventFilter, sampleRate: { [kind]: 0 } });
      const eventId = client.track('action');
      const errorId = client.captureError(new Error('private'));
      expect(kind === 'event' ? eventId : errorId).toBeNull();
      expect(kind === 'event' ? errorId : eventId).not.toBeNull();
      const result = client.flush();
      await vi.advanceTimersByTimeAsync(1);
      expect((await result).acknowledgedIds).toEqual([kind === 'event' ? errorId : eventId]);
      expect(eventFilter).toHaveBeenCalledTimes(1);
      expect(client.getDiagnostics().dropped).toEqual({ sampled: 1 });
      expect(payload(transport.mock.calls[0][1]).events[0].sample_rate).toBeUndefined();
    },
  );

  it('keeps both zero-rate categories out of the queue and transport', async () => {
    const transport = accept();
    const eventFilter = vi.fn(() => true);
    const client = browser({ transport, eventFilter, sampleRate: { event: 0, error: 0 } });
    expect(client.track('action')).toBeNull();
    expect(client.captureError(new Error('private'))).toBeNull();
    expect(await client.flush()).toMatchObject({
      acknowledgedIds: [],
      pendingIds: [],
      timedOut: false,
    });
    expect(client.getDiagnostics()).toMatchObject({
      queuedEvents: 0,
      queuedBytes: 0,
      dropped: { sampled: 2 },
    });
    expect(eventFilter).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-0.01, 1.01, NaN, Infinity, -Infinity])(
    'rejects invalid rates for either category: %s',
    (rate) => {
      expect(() => browser({ sampleRate: { event: rate } })).toThrow();
      expect(() => browser({ sampleRate: { error: rate } })).toThrow();
    },
  );
});
