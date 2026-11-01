import { it, expect, vi } from 'vitest';
import { createCollector, createConfigManager } from '../index.js';
import { createTestConfiguration } from '../../../../tests/support/config.js';
import type { TelemetryStore } from '../../../storage-contract/src/index.js';
const gate = vi.hoisted(() => ({ finish: undefined as undefined | (() => void), calls: 0 }));
vi.mock('node:zlib', async (importActual) => ({
  ...(await importActual<typeof import('node:zlib')>()),
  gunzip: (
    _body: unknown,
    _options: unknown,
    callback: (error: Error | null, body: Buffer) => void,
  ) => {
    gate.calls++;
    gate.finish = () => callback(null, Buffer.from('{}'));
  },
}));
it('regression: timed-out decompression holds trace admission until the task actually exits', async () => {
  const fixture = createTestConfiguration();
  fixture.configuration.limits.request_timeout_ms = 25;
  fixture.configuration.limits.body_timeout_ms = 10;
  fixture.configuration.limits.traces.max_concurrent = 1;
  fixture.configuration.projects[0].service_accounts[0].permissions.push('write:traces');
  const unexpected = async () => {
    throw new Error('Unexpected storage operation');
  };
  const store: TelemetryStore = {
    capabilities: {
      driver: 'test',
      contractVersion: 2,
      durability: 'single_node',
      idempotency: 'strict_receipt',
      readConsistency: 'primary_committed',
      auditedReadBarrier: true,
    },
    writer: { appendBatch: unexpected },
    reader: { findEvents: unexpected, findErrors: unexpected, getEvent: unexpected },
    traces: { appendSpans: unexpected, findSpans: unexpected },
    readiness: async () => ({ ready: true }),
    close: async () => undefined,
  };
  const app = createCollector({ store, config: createConfigManager(fixture.configuration) });
  const input = {
    method: 'POST' as const,
    url: '/v1/traces',
    headers: {
      authorization: `Bearer ${fixture.writeToken}`,
      'x-oneaster-environment': 'test',
      'content-type': 'application/json',
      'content-encoding': 'gzip',
    },
    payload: Buffer.from('compressed'),
  };
  try {
    const first = await app.inject(input);
    expect(first.statusCode).toBe(503);
    expect(gate.calls).toBe(1);
    const second = await app.inject(input);
    expect(second.statusCode).toBe(503);
    expect(gate.calls).toBe(1);
    gate.finish?.();
    await vi.waitFor(async () => {
      const metrics = await app.inject({ method: 'GET', url: '/metrics' });
      expect(metrics.body).toContain('telemetry_active_requests 0');
    });
    const empty = await app.inject({
      ...input,
      headers: { ...input.headers, 'content-encoding': 'identity' },
      payload: Buffer.from('{}'),
    });
    expect(empty.statusCode).toBe(200);
  } finally {
    gate.finish?.();
    await app.close();
  }
});
