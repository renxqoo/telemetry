import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { cpus, totalmem } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from 'pg';
import {
  createCollector,
  createConfigManager,
  createQueryApi,
} from '../packages/application/src/index.js';
import { createPostgresStore, migrate } from '../packages/storage-postgres/src/index.js';
import type {
  Envelope,
  IngestResponse,
  EventPage,
  TelemetryEvent,
} from '../packages/protocol/src/types.js';
import { startPostgres } from '../tests/support/postgres.js';
import { createTestConfiguration } from '../tests/support/config.js';
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index],
    value = process.argv[index + 1];
  if (!key?.startsWith('--') || !value || args.has(key))
    throw new Error('Use --duration-ms NUMBER --rate NUMBER --query-rate NUMBER --out PATH');
  args.set(key, value);
}
for (const key of args.keys())
  if (!['--duration-ms', '--rate', '--query-rate', '--out'].includes(key))
    throw new Error('Unknown load option');
function integer(key: string, fallback: number, max: number) {
  const value = Number(args.get(key) ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${key}`);
  return value;
}
const duration = integer('--duration-ms', 600000, 3600000),
  rate = integer('--rate', 500, 5000),
  queryRate = integer('--query-rate', 10, 100);
const output = resolve(args.get('--out') ?? 'artifacts/load.json');
const externalDatabaseUrl = process.env.TELEMETRY_LOAD_DATABASE_URL;
const managedDatabase = externalDatabaseUrl ? undefined : await startPostgres();
const databaseUrl = externalDatabaseUrl ?? managedDatabase!.url;
const fixture = createTestConfiguration();
fixture.configuration.projects[0].quota = {
  events_per_second: rate * 2,
  burst: Math.max(20, rate * 4),
};
const config = createConfigManager(fixture.configuration);
const collectorStore = createPostgresStore({
  connectionString: databaseUrl,
  profile: 'development',
  role: 'collector',
  instanceId: 'load-collector',
  nodeId: 'local',
  maxConnections: 10,
});
const queryStore = createPostgresStore({
  connectionString: databaseUrl,
  profile: 'development',
  role: 'query',
  instanceId: 'load-query',
  nodeId: 'local',
  maxConnections: 5,
});
const collector = createCollector({ store: collectorStore, config });
const query = createQueryApi({
  store: queryStore,
  config,
  cursorKeys: [{ id: 'load', secret: fixture.cursorSecret }],
});
const admin = new Client({ connectionString: databaseUrl });
const runId = randomUUID();
const writeLatencies: number[] = [],
  queryLatencies: number[] = [],
  failures: Record<string, number> = {};
const failureSamples: { at_ms: number; reason: string; count: number }[] = [];
let measuredAt = 0;
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
let written = 0,
  queried = 0,
  scheduled = 0,
  payloadBytes = 0,
  maxRss = process.memoryUsage().rss;
const pending = new Set<Promise<void>>();
function failed(reason: string, count = 1) {
  failures[reason] = (failures[reason] ?? 0) + count;
  if (failureSamples.length < 20)
    failureSamples.push({ at_ms: performance.now() - measuredAt, reason, count });
}
function launch(work: () => Promise<void>) {
  const task = work().finally(() => pending.delete(task));
  pending.add(task);
}
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
try {
  await migrate(databaseUrl);
  await admin.connect();
  const readiness = { signal: AbortSignal.timeout(3000), deadlineAtMs: Date.now() + 3000 };
  const ready = await Promise.all([
    collectorStore.readiness(readiness),
    queryStore.readiness(readiness),
  ]);
  if (ready.some((item) => !item.ready))
    throw new Error('Load services must pass normal startup readiness before measurement');
  const collectorUrl = await collector.listen({ host: '127.0.0.1', port: 0 });
  const queryUrl = await query.listen({ host: '127.0.0.1', port: 0 });
  const started = performance.now();
  measuredAt = started;
  loopDelay.enable();
  let nextWrite = started,
    nextQuery = started;
  while (!abort.signal.aborted && performance.now() < started + duration) {
    const now = performance.now();
    if (now >= nextWrite) {
      const count = Math.min(20, rate);
      scheduled += count;
      nextWrite += (count / rate) * 1000;
      if (pending.size >= 40) {
        failed('load_generator_concurrency', count);
      } else {
        const envelope: Envelope = {
          schema_version: '1',
          environment: 'test',
          service: 'api',
          release: 'load-v1',
          build_id: 'load-build',
          events: Array.from({ length: count }, (_, index): TelemetryEvent => ({
            id: randomUUID(),
            occurred_at: new Date().toISOString(),
            kind: index === 0 ? 'error' : 'event',
            name: index === 0 ? 'runtime.error' : 'load_event',
            properties:
              index === 0
                ? { operation: 'load' }
                : {
                    p0: 'a'.repeat(200),
                    p1: 'b'.repeat(200),
                    p2: 'c'.repeat(200),
                    p3: 'd'.repeat(200),
                  },
            context: { request_id: runId },
            ...(index === 0
              ? {
                  error: { type: 'Error', mechanism: 'manual' as const, handled: true, frames: [] },
                }
              : {}),
          })),
        };
        const body = JSON.stringify(envelope);
        payloadBytes += Buffer.byteLength(body);
        launch(async () => {
          const start = performance.now();
          try {
            const response = await fetch(`${collectorUrl}/v1/ingest/server`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${fixture.writeToken}`,
                'content-type': 'application/json',
              },
              body,
              signal: AbortSignal.timeout(5000),
            });
            const receipt = (await response.json()) as IngestResponse;
            if (response.status !== 200) {
              const code = (receipt as unknown as { error?: { code?: unknown } }).error?.code;
              failed(
                `http_${response.status}_${typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'unknown'}`,
                count,
              );
              return;
            }
            const ids = new Set(receipt.acknowledged?.map((item) => item.id));
            if (
              receipt.project_id !== fixture.projectId ||
              receipt.source !== 'server' ||
              ids.size !== count ||
              !envelope.events.every((event) => ids.has(event.id))
            ) {
              failed('invalid_ack', count);
              return;
            }
            written += count;
            writeLatencies.push(performance.now() - start);
          } catch {
            failed('write_connection', count);
          }
        });
      }
    }
    if (now >= nextQuery) {
      nextQuery += 1000 / queryRate;
      if (pending.size >= 40) failed('query_generator_concurrency');
      else
        launch(async () => {
          const start = performance.now();
          try {
            const response = await fetch(`${queryUrl}/v1/events?environment=test&limit=100`, {
              headers: { authorization: `Bearer ${fixture.readToken}` },
              signal: AbortSignal.timeout(5000),
            });
            const page = (await response.json()) as EventPage;
            if (response.status !== 200 || page.consistency !== 'primary_committed') {
              failed(`query_http_${response.status}`);
              return;
            }
            queried++;
            queryLatencies.push(performance.now() - start);
          } catch {
            failed('query_connection');
          }
        });
    }
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
    await delay(
      Math.max(1, Math.min(nextWrite, nextQuery, started + duration) - performance.now()),
    );
  }
  await Promise.all(pending);
  const observed = await admin.query(
    "SELECT count(*)::integer AS count,count(DISTINCT event_id)::integer AS unique_count FROM telemetry.telemetry_events WHERE project_id=$1 AND context->>'request_id'=$2",
    [fixture.projectId, runId],
  );
  const percentile = (values: number[], fraction: number) =>
    values.length
      ? [...values].sort((a, b) => a - b)[
          Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)
        ]
      : null;
  const summary = (values: number[]) => ({
    requests: values.length,
    p50_ms: percentile(values, 0.5),
    p95_ms: percentile(values, 0.95),
    p99_ms: percentile(values, 0.99),
  });
  const result = {
    profile: 'development',
    fault_domains: 1,
    node: process.version,
    postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
    cpu: cpus()[0]?.model,
    logical_cpus: cpus().length,
    host_memory_bytes: totalmem(),
    duration_ms: performance.now() - started,
    target_duration_ms: duration,
    target_events_per_second: rate,
    target_query_requests_per_second: queryRate,
    event_mix: '95% event / 5% error for batches of 20',
    mean_request_event_bytes: payloadBytes / Math.max(1, scheduled),
    scheduled_events: scheduled,
    acknowledged_events: written,
    stored_events: observed.rows[0].count,
    unique_events: observed.rows[0].unique_count,
    query_requests: queried,
    failures,
    failure_samples: failureSamples,
    event_loop_delay_max_ms: loopDelay.max / 1e6,
    event_loop_delay_p99_ms: loopDelay.percentile(99) / 1e6,
    max_process_rss_bytes: maxRss,
    ingest: summary(writeLatencies),
    query: summary(queryLatencies),
    interrupted: abort.signal.aborted,
    production_ha_verified: false,
  };
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (
    abort.signal.aborted ||
    Object.keys(failures).length ||
    written !== observed.rows[0].unique_count ||
    (result.ingest.p99_ms ?? Infinity) > 1000 ||
    (result.query.p99_ms ?? Infinity) > 2000
  )
    process.exitCode = 1;
} finally {
  loopDelay.disable();
  await Promise.allSettled([collector.close(), query.close(), admin.end()]);
  const options = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 3000 };
  await Promise.allSettled([collectorStore.close(options), queryStore.close(options)]);
  await managedDatabase?.stop();
}
