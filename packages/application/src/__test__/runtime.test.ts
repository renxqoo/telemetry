import { traceDefaults, emptyTracePolicy } from '../../../protocol/src/traces/types.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startService } from '../runtime.js';
import type { TelemetryStore } from '../../../storage-contract/src/index.js';
type CallableProperties<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R
    : T[K] extends object
      ? CallableProperties<T[K]>
      : T[K];
};
const directories: string[] = [];
const services: Awaited<ReturnType<typeof startService>>[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.useRealTimers();
  vi.restoreAllMocks();
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'telemetry-runtime-'));
  directories.push(directory);
  const created = new Date(Date.now() - 60000).toISOString();
  const expires = new Date(Date.now() + 3600000).toISOString();
  const configuration = {
    schema_version: '2',
    revision: 1,
    created_at: created,
    not_before: created,
    expires_at: expires,
    profile: 'development',
    endpoints: ['http://127.0.0.1:4320'],
    trusted_proxies: [],
    limits: {
      traces: { ...traceDefaults, max_concurrent: 1 },
      trace_queries: { page_bytes: 4194304 },
      max_concurrent: 2,
      request_timeout_ms: 100,
      body_timeout_ms: 50,
      shutdown_timeout_ms: 100,
      latency_buckets_ms: [10, 100],
    },
    retention: { trace_days: 30, event_days: 30, receipt_days: 7, audit_days: 90 },
    projects: [
      {
        id: '0fcff045-b764-4f86-a82d-5b999b4b8a4f',
        environments: ['production'],
        services: ['web'],
        events: {},
        error_policy: { properties: {}, codes: [], safe_messages: [] },
        browser_keys: [],
        service_accounts: [],
        trace_policy: structuredClone(emptyTracePolicy),
        trace_quota: { spans_per_second: 2000, burst: 4000 },
        quota: { events_per_second: 100, burst: 100 },
      },
    ],
  };
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(configuration));
  const secretsPath = join(directory, 'secrets.json');
  await writeFile(
    secretsPath,
    JSON.stringify({
      database_url: 'postgres://private.example/database',
      store_options: { instanceId: 'instance', nodeId: 'node' },
    }),
    { mode: 0o600 },
  );
  const store: CallableProperties<TelemetryStore> = {
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
      appendBatch: vi.fn(async () => {
        throw new Error('unexpected write');
      }),
    },
    reader: {
      findEvents: vi.fn(async () => {
        throw new Error('unexpected read');
      }),
      findErrors: vi.fn(async () => {
        throw new Error('unexpected read');
      }),
      getEvent: vi.fn(async () => {
        throw new Error('unexpected read');
      }),
    },
    readiness: vi.fn(async () => ({ ready: true })),
    close: vi.fn(async () => {}),
  };
  const factory = vi.fn(() => store);
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve, reject) =>
    listener.close((error) => (error ? reject(error) : resolve())),
  );
  const env = {
    TELEMETRY_CONFIG: configPath,
    TELEMETRY_SECRETS_FILE: secretsPath,
    PORT: String(port),
  };
  return { configuration, configPath, secretsPath, store, factory, env };
}
it('starts a real HTTP listener only after readiness and closes the owned store', async () => {
  const { factory, env, store } = await fixture();
  const service = await startService('collector', factory, {
    ...env,
    TELEMETRY_INSTANCE_ID: 'collector-0',
  });
  services.push(service);
  expect(factory.mock.calls).toEqual([
    [
      expect.objectContaining({
        instanceId: 'collector-0',
        role: 'collector',
        profile: 'development',
      }),
    ],
  ]);
  expect(store.readiness).toHaveBeenCalledTimes(1);
  const response = await fetch(`http://127.0.0.1:${env.PORT}/live`);
  expect(response.status).toBe(200);
  const before = Date.now();
  await service.close();
  const after = Date.now();
  expect(store.close).toHaveBeenCalledTimes(1);
  const deadline = vi.mocked(store.close).mock.calls[0]![0].deadlineAtMs;
  expect(deadline).toBeGreaterThanOrEqual(before + 100);
  expect(deadline).toBeLessThanOrEqual(after + 100);
});
it('rejects unsafe secrets before constructing a driver and supports injected secrets', async () => {
  const { factory, env, secretsPath } = await fixture();
  await writeFile(secretsPath, await readFile(secretsPath), { mode: 0o644 });
  const handle = await import('node:fs/promises');
  await handle.chmod(secretsPath, 0o644);
  await expect(startService('collector', factory, env)).rejects.toThrow('0600');
  expect(factory).not.toHaveBeenCalled();
  const service = await startService('collector', factory, {
    TELEMETRY_CONFIG: env.TELEMETRY_CONFIG,
    PORT: env.PORT,
    DATABASE_URL: 'postgres://private.example/database',
    TELEMETRY_STORE_OPTIONS_JSON: JSON.stringify({
      instanceId: 'injected',
      nodeId: 'node',
      physicalNodes: [
        {
          id: 'node',
          connectionString: 'postgres://node',
          cleanupConnectionString: 'postgres://cleanup',
        },
      ],
    }),
  });
  services.push(service);
  expect(factory.mock.calls[0]).toEqual([
    expect.objectContaining({
      instanceId: 'injected',
      physicalNodes: [
        {
          id: 'node',
          connectionString: 'postgres://node',
          cleanupConnectionString: 'postgres://cleanup',
        },
      ],
    }),
  ]);
});
it('cleans up startup resources when readiness fails or a key is invalid', async () => {
  const { factory, env, store, secretsPath } = await fixture();
  vi.mocked(store.readiness).mockResolvedValue({ ready: false });
  await expect(startService('collector', factory, env)).rejects.toThrow('readiness');
  expect(store.close).toHaveBeenCalledTimes(1);
  await writeFile(
    secretsPath,
    JSON.stringify({
      database_url: 'postgres://private.example/database',
      cursor_keys: [{ id: 'key', secret: 'short' }],
      store_options: { instanceId: 'instance', nodeId: 'node' },
    }),
  );
  await expect(startService('query', factory, env)).rejects.toThrow('signing');
  expect(store.close).toHaveBeenCalledTimes(2);
});
it('bounds a stalled startup readiness check and aborts the store operation', async () => {
  const { factory, env, store } = await fixture();
  vi.mocked(store.readiness).mockImplementation(
    (options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        }),
      ),
  );
  await expect(startService('collector', factory, env)).rejects.toThrow();
  expect(vi.mocked(store.readiness).mock.calls[0]![0].signal.aborted).toBe(true);
  expect(store.close).toHaveBeenCalledTimes(1);
});
it('atomically reloads only valid newer configurations and keeps expiry visible', async () => {
  const { factory, env, configuration, configPath } = await fixture();
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const service = await startService('collector', factory, env);
  services.push(service);
  await writeFile(configPath, JSON.stringify({ ...configuration, revision: 2 }));
  await vi.advanceTimersByTimeAsync(15000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(service.config.status().active_revision).toBe(2);
  await writeFile(configPath, JSON.stringify({ ...configuration, revision: 1 }));
  await vi.advanceTimersByTimeAsync(15000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(service.config.status().active_revision).toBe(2);
  expect(stderr).toHaveBeenCalledWith('Configuration update rejected.\n');
});
it('rejects missing config, invalid port, and missing query signing keys before opening a store', async () => {
  const { factory, env } = await fixture();
  await expect(startService('collector', factory, {})).rejects.toThrow('TELEMETRY_CONFIG');
  await expect(startService('collector', factory, { ...env, PORT: '0' })).rejects.toThrow('PORT');
  await expect(startService('query', factory, env)).rejects.toThrow('cursor keys');
  expect(factory).not.toHaveBeenCalled();
});
