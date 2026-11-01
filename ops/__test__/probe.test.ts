import { randomUUID } from 'node:crypto';
import { afterEach, expect, test, vi } from 'vitest';
import { runProbe } from '../probe.js';

const project = '873f33a6-02cf-4110-96bd-fde46f4a63a3';
const configuration = {
  collector_endpoints: ['https://collector-a.example', 'https://collector-b.example'],
  query_endpoints: ['https://query-a.example', 'https://query-b.example'],
  project_id: project,
  environment: 'production',
  service: 'api',
  release: 'probe-test',
  build_id: 'probe-test',
  event_name: 'availability_probe',
};
const secrets = { writeToken: `writer.${'w'.repeat(32)}`, readToken: `reader.${'r'.repeat(32)}` };

afterEach(() => vi.unstubAllGlobals());

test.each(['collector', 'query'] as const)(
  'regression: a blackholed first %s endpoint cannot hide a healthy later endpoint',
  async (blackhole) => {
    const calls: string[] = [];
    let storedId = '';
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(input);
        calls.push(url.hostname);
        if (url.hostname === `${blackhole}-a.example`)
          return await new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) reject(signal.reason);
            else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        if (init?.method === 'POST') {
          if (typeof init.body !== 'string') throw new Error('Expected serialized request');
          const payload = JSON.parse(init.body) as { events: { id: string }[] };
          storedId = payload.events[0]!.id;
          return Response.json({
            request_id: randomUUID(),
            project_id: project,
            environment: 'production',
            service: 'api',
            source: 'server',
            acknowledged: [
              {
                id: storedId,
                status: 'stored',
                received_at: '2026-11-01T00:00:00.000Z',
                retain_until: '2026-12-01T00:00:00.000Z',
              },
            ],
          });
        }
        return Response.json({
          id: storedId,
          project_id: project,
          environment: 'production',
          service: 'api',
          source: 'server',
        });
      }),
    );
    const result = await runProbe(configuration, secrets);
    expect(result.success).toBe(true);
    expect(calls).toContain(`${blackhole}-b.example`);
    expect(result.durationMs).toBeLessThan(5000);
  },
);

test('regression: a stalled query body is cancelled before trying a healthy endpoint', async () => {
  let storedId = '';
  let cancelled = false;
  const queries: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(input);
      if (init?.method === 'POST') {
        if (typeof init.body !== 'string') throw new Error('Expected serialized request');
        storedId = (JSON.parse(init.body) as { events: { id: string }[] }).events[0]!.id;
        return Response.json({
          request_id: randomUUID(),
          project_id: project,
          environment: 'production',
          service: 'api',
          source: 'server',
          acknowledged: [
            {
              id: storedId,
              status: 'stored',
              received_at: '2026-11-01T00:00:00.000Z',
              retain_until: '2026-12-01T00:00:00.000Z',
            },
          ],
        });
      }
      queries.push(url.hostname);
      if (url.hostname === 'query-a.example')
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{'));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      return Response.json({
        id: storedId,
        project_id: project,
        environment: 'production',
        service: 'api',
        source: 'server',
      });
    }),
  );
  const result = await runProbe(
    { ...configuration, timeouts: { total_ms: 300, write_ms: 100 } },
    secrets,
  );
  expect(result.success).toBe(true);
  expect(cancelled).toBe(true);
  expect(queries).toEqual(['query-a.example', 'query-b.example']);
});

test('unavailable collectors fail without performing an unconfirmed read', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    throw new Error('Unreachable endpoint');
  });
  vi.stubGlobal('fetch', fetch);
  const result = await runProbe(configuration, secrets);
  expect(result.success).toBe(false);
  expect(fetch).toHaveBeenCalledTimes(2);
  for (const [, init] of fetch.mock.calls) expect(init?.method).toBe('POST');
});
