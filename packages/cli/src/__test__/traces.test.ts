import { it, expect, vi } from 'vitest';
import { runCli } from '../index.js';
const trace = '1'.repeat(32);
const env = {
  TELEMETRY_TOKEN: `reader.${'s'.repeat(32)}`,
  TELEMETRY_ENDPOINTS: 'https://telemetry.example',
};
function page(id: string, time: string, next_cursor: string | null) {
  return {
    items: [
      {
        trace_id: trace,
        span_id: id.repeat(16),
        service: 'web',
        received_at: time,
        duration_ns: '123456789',
        attributes: [],
        events: [],
        links: [],
      },
    ],
    next_cursor,
    query_id: 'query',
    consistency: 'primary_committed',
    pagination: 'live-pagination',
    scope: 'authorized_services',
    range: { from: '2026-11-01T00:00:00.000Z', to: '2026-11-02T00:00:00.000Z' },
  };
}
it('streams across short trace pages and sends the supplied exact filters without credentials in URLs', async () => {
  let output = '',
    errors = '';
  const transport = vi.fn<typeof fetch>(async (): Promise<Response> =>
    Response.json(
      transport.mock.calls.length === 1
        ? page('2', '2026-11-01T00:00:00.001Z', 'next')
        : page('1', '2026-11-01T00:00:00.000Z', null),
    ),
  );
  const result = await runCli(
    [
      'traces',
      'get',
      '--environment',
      'test',
      '--id',
      trace,
      '--format',
      'ndjson',
      '--limit',
      '100',
    ],
    {
      env,
      fetch: transport,
      stdout: (s) => {
        output += s;
      },
      stderr: (s) => {
        errors += s;
      },
    },
  );
  expect(result).toBe(0);
  expect(output.trim().split('\n')).toHaveLength(2);
  expect(transport).toHaveBeenCalledTimes(2);
  expect((transport.mock.calls[1][0] as URL).href).toContain('cursor=next');
  expect((transport.mock.calls[0][0] as URL).href).toContain(`/v1/traces/${trace}?`);
  expect((transport.mock.calls[0][0] as URL).href).not.toContain(env.TELEMETRY_TOKEN);
  expect(errors).toContain('"complete":true');
});
it('returns nonzero after a later page failure and never reports a complete partial export', async () => {
  let output = '',
    errors = '';
  const transport = vi.fn<typeof fetch>(async (): Promise<Response> =>
    transport.mock.calls.length === 1
      ? Response.json(page('2', '2026-11-01T00:00:00.001Z', 'next'))
      : Response.json({ code: 14 }, { status: 503 }),
  );
  const result = await runCli(
    ['traces', 'get', '--environment', 'test', '--id', trace, '--format', 'ndjson'],
    {
      env,
      fetch: transport,
      stdout: (s) => {
        output += s;
      },
      stderr: (s) => {
        errors += s;
      },
    },
  );
  expect(result).toBe(3);
  expect(output.trim().split('\n')).toHaveLength(1);
  expect(errors).toContain('"complete":false');
});
it('rejects invalid pages and non-advancing trace traversal', async () => {
  for (const malformed of [null, { items: [] }, page('z', '2026-11-01T00:00:00.000Z', null)]) {
    let output = '';
    expect(
      await runCli(['traces', 'list', '--environment', 'test'], {
        env,
        fetch: async () => Response.json(malformed),
        stdout: (s) => {
          output += s;
        },
        stderr: () => undefined,
      }),
    ).toBe(1);
    expect(output).toBe('');
  }
  const repeated = page('1', '2026-11-01T00:00:00.000Z', 'same');
  expect(
    await runCli(['traces', 'list', '--environment', 'test', '--format', 'ndjson'], {
      env,
      fetch: async () => Response.json(repeated),
      stdout: () => undefined,
      stderr: () => undefined,
    }),
  ).toBe(3);
});

it('waits for asynchronous output backpressure before requesting another trace page', async () => {
  let release: () => void = () => undefined;
  let wrote = false;
  const transport = vi.fn<typeof fetch>(async (): Promise<Response> =>
    Response.json(
      transport.mock.calls.length === 1
        ? page('2', '2026-11-01T00:00:00.001Z', 'next')
        : page('1', '2026-11-01T00:00:00.000Z', null),
    ),
  );
  const running = runCli(['traces', 'list', '--environment', 'test', '--format', 'ndjson'], {
    env,
    fetch: transport,
    stdout: () => {
      if (wrote) return;
      wrote = true;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    stderr: () => undefined,
  });
  await vi.waitFor(() => expect(wrote).toBe(true));
  expect(transport).toHaveBeenCalledTimes(1);
  release();
  expect(await running).toBe(0);
  expect(transport).toHaveBeenCalledTimes(2);
});
