import { expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createPostgresStore, migrate } from '../index.js';
import { startPostgres } from '../../../../tests/support/postgres.js';
import type { CanonicalBatch } from '../../../storage-contract/src/index.js';

it('a retry waiting behind another write cannot exceed the original data-stage budget or cancel that write', async () => {
  const database = await startPostgres();
  const admin = new Client({ connectionString: database.url });
  const writer = createPostgresStore({
    connectionString: database.url,
    profile: 'development',
    role: 'collector',
    instanceId: 'retry-admission',
    nodeId: 'local',
    maxConnections: 1,
  });
  const projectId = randomUUID();
  const batch = (): CanonicalBatch => ({
    scope: {
      projectId,
      environment: 'test',
      service: 'api',
      source: 'server',
      release: 'v1',
      buildId: 'build',
      policyVersion: '1',
      retentionDays: 30,
      receiptDays: 7,
    },
    events: [
      {
        digest: 'a'.repeat(64),
        payload: {
          id: randomUUID(),
          occurred_at: new Date().toISOString(),
          kind: 'event',
          name: 'retry_admission',
          properties: {},
        },
      },
    ],
  });
  const operation = () => ({
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 3000,
  });
  try {
    await migrate(database.url);
    await admin.connect();
    expect(await writer.readiness(operation())).toEqual({ ready: true });
    const retried = batch();
    const occupying = batch();
    await admin.query('CREATE SEQUENCE telemetry.test_admission_retry_sequence');
    await admin.query(
      'GRANT USAGE ON SEQUENCE telemetry.test_admission_retry_sequence TO telemetry_collector',
    );
    await admin.query(
      `CREATE FUNCTION telemetry.test_admission_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='${retried.events[0].payload.id}' THEN IF nextval('telemetry.test_admission_retry_sequence')=1 THEN PERFORM pg_sleep(0.35); RAISE EXCEPTION 'retry' USING ERRCODE='40001'; END IF; ELSIF NEW.event_id='${occupying.events[0].payload.id}' THEN PERFORM pg_sleep(0.35); END IF; RETURN NEW; END $$`,
    );
    await admin.query(
      'CREATE TRIGGER test_admission_retry BEFORE INSERT ON telemetry.ingest_receipts FOR EACH ROW EXECUTE FUNCTION telemetry.test_admission_retry()',
    );
    const started = performance.now();
    const pending = writer.writer.appendBatch(retried, operation()).then(
      () => ({ error: undefined, elapsed: performance.now() - started }),
      (error: unknown) => ({ error, elapsed: performance.now() - started }),
    );
    let sleeping = false;
    while (performance.now() - started < 300) {
      const activity = await admin.query(
        `SELECT 1 FROM pg_stat_activity WHERE starts_with(application_name,'telemetry:retry-admission:')
 AND wait_event='PgSleep' AND clock_timestamp()-query_start >= interval '150 milliseconds'`,
      );
      if (activity.rowCount) {
        sleeping = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(sleeping).toBe(true);
    const admitted = writer.writer.appendBatch(occupying, operation());
    const [failed, receipt] = await Promise.all([pending, admitted]);
    expect(failed.error).toMatchObject({ code: 'overloaded', outcome: 'not_committed' });
    expect(failed.elapsed).toBeGreaterThanOrEqual(450);
    expect(failed.elapsed).toBeLessThan(575);
    expect(receipt.acknowledged).toMatchObject([
      { id: occupying.events[0].payload.id, status: 'stored' },
    ]);
    expect(
      (await admin.query('SELECT last_value FROM telemetry.test_admission_retry_sequence')).rows[0]
        .last_value,
    ).toBe('1');
    const persisted = await admin.query(
      'SELECT event_id FROM telemetry.telemetry_events WHERE project_id=$1 ORDER BY event_id',
      [projectId],
    );
    expect(persisted.rows).toEqual([{ event_id: occupying.events[0].payload.id }]);
  } finally {
    await writer.close(operation());
    await admin.end();
    await database.stop();
  }
});
