import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { Client } from 'pg';
import { createCollector, createConfigManager } from '../index.js';
import { createPostgresStore, migrate } from '../../../storage-postgres/src/index.js';
import { createTestConfiguration } from '../../../../tests/support/config.js';

const connectionString = process.env.TELEMETRY_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error('Use the integration runner with TELEMETRY_TEST_DATABASE_URL');
const admin = new Client({ connectionString });
beforeAll(async () => {
  await admin.connect();
  await migrate(connectionString!);
});
afterAll(async () => {
  await admin.end();
});

it('does not disconnect a fully received write when COMMIT outlasts the body timeout', async () => {
  const fixture = createTestConfiguration();
  fixture.configuration.limits.body_timeout_ms = 50;
  fixture.configuration.limits.request_timeout_ms = 1000;
  const store = createPostgresStore({
    connectionString: connectionString!,
    profile: 'development',
    role: 'collector',
    instanceId: 'http-timeout',
    nodeId: 'local',
  });
  const app = createCollector({ store, config: createConfigManager(fixture.configuration) });
  const id = randomUUID();
  await admin.query(
    'CREATE FUNCTION telemetry.test_http_commit_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.2); RETURN NEW; END $$',
  );
  await admin.query(
    'CREATE CONSTRAINT TRIGGER test_http_commit_delay AFTER INSERT ON telemetry.ingest_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION telemetry.test_http_commit_delay()',
  );
  try {
    const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
    const response = await fetch(`${endpoint}/v1/ingest/server`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${fixture.writeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        schema_version: '1',
        environment: 'test',
        service: 'api',
        release: 'v1',
        build_id: 'build',
        events: [
          {
            id,
            occurred_at: new Date().toISOString(),
            kind: 'event',
            name: 'smoke_event',
            properties: { action: 'complete' },
          },
        ],
      }),
      signal: AbortSignal.timeout(2000),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).acknowledged).toEqual([
      expect.objectContaining({ id, status: 'stored' }),
    ]);
    const observed = await admin.query(
      'SELECT count(*)::integer AS count FROM telemetry.telemetry_events WHERE project_id=$1 AND event_id=$2',
      [fixture.projectId, id],
    );
    expect(observed.rows[0].count).toBe(1);
  } finally {
    await app.close();
    await store.close({ signal: new AbortController().signal, deadlineAtMs: Date.now() + 2000 });
    await admin.query('DROP TRIGGER test_http_commit_delay ON telemetry.ingest_receipts');
    await admin.query('DROP FUNCTION telemetry.test_http_commit_delay()');
  }
});

it('still closes a stalled incomplete body within its receive timeout and releases admission', async () => {
  const fixture = createTestConfiguration();
  fixture.configuration.limits.body_timeout_ms = 50;
  fixture.configuration.limits.request_timeout_ms = 1000;
  fixture.configuration.limits.max_concurrent = 1;
  const store = createPostgresStore({
    connectionString: connectionString!,
    profile: 'development',
    role: 'collector',
    instanceId: 'http-body-time',
    nodeId: 'local',
  });
  const app = createCollector({ store, config: createConfigManager(fixture.configuration) });
  const endpoint = await app.listen({ host: '127.0.0.1', port: 0 });
  const socket = createConnection({ host: '127.0.0.1', port: Number(new URL(endpoint).port) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const closed = new Promise<void>((resolve, reject) => {
      socket.once('close', () => resolve());
      timer = setTimeout(() => reject(new Error('Incomplete body was not closed')), 500);
    });
    socket.write(
      'POST /v1/ingest/server HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{',
    );
    await closed;
    const metrics = await fetch(`${endpoint}/metrics`);
    expect(await metrics.text()).toContain('telemetry_active_requests 0');
    expect((await fetch(`${endpoint}/ready`)).status).toBe(200);
    const observed = await admin.query(
      'SELECT count(*)::integer AS count FROM telemetry.ingest_receipts WHERE project_id=$1',
      [fixture.projectId],
    );
    expect(observed.rows[0].count).toBe(0);
  } finally {
    clearTimeout(timer);
    socket.destroy();
    await app.close();
    await store.close({ signal: new AbortController().signal, deadlineAtMs: Date.now() + 2000 });
  }
});
