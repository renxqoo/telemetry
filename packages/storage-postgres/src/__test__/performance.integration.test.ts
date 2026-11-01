import { expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { createPostgresStore, migrate } from '../index.js';
import { startPostgres } from '../../../../tests/support/postgres.js';
import type { CanonicalBatch } from '../../../storage-contract/src/index.js';

it('keeps a full batch within its data budget before initial table statistics exist', async () => {
  const database = await startPostgres();
  const admin = new Client({ connectionString: database.url });
  const writer = createPostgresStore({
    connectionString: database.url,
    profile: 'development',
    role: 'collector',
    instanceId: 'initial-stats',
    nodeId: 'local',
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
    events: Array.from({ length: 20 }, () => ({
      digest: 'a'.repeat(64),
      payload: {
        id: randomUUID(),
        occurred_at: new Date().toISOString(),
        kind: 'event',
        name: 'load_event',
        properties: { value: 'x'.repeat(900) },
      },
    })),
  });
  const operation = () => ({
    signal: new AbortController().signal,
    deadlineAtMs: Date.now() + 3000,
  });
  try {
    await migrate(database.url);
    await admin.connect();
    await admin.query('ALTER TABLE telemetry.ingest_receipts SET (autovacuum_enabled=false)');
    const partitions = await admin.query(
      "SELECT relid::regclass::text AS name FROM pg_partition_tree('telemetry.telemetry_events') WHERE isleaf",
    );
    for (const row of partitions.rows)
      await admin.query(`ALTER TABLE ${row.name} SET (autovacuum_enabled=false)`);
    const seed = batch();
    await writer.writer.appendBatch(seed, operation());
    await admin.query(
      `INSERT INTO telemetry.ingest_receipts
 SELECT project_id,environment,service,source,gen_random_uuid()::text,kind,payload_digest,
 first_received_at,retain_until,tombstone_until,first_operation_id,confirmation_nonce,policy_version
 FROM telemetry.ingest_receipts CROSS JOIN generate_series(1,5000) WHERE project_id=$1`,
      [projectId],
    );
    await admin.query(
      `INSERT INTO telemetry.telemetry_events
 SELECT r.project_id,r.environment,r.service,r.source,r.first_received_at,r.event_id,r.kind,
 e.occurred_at,e.release,e.build_id,e.name,e.properties,e.context,e.error,e.fingerprint,e.truncated,
 e.sample_rate,r.policy_version,r.retain_until
 FROM telemetry.ingest_receipts r CROSS JOIN LATERAL
 (SELECT * FROM telemetry.telemetry_events WHERE project_id=$1 LIMIT 1) e
 WHERE r.project_id=$1 AND r.event_id<>ALL($2::text[])`,
      [projectId, seed.events.map((event) => event.payload.id)],
    );
    const fresh = batch();
    const receipt = await writer.writer.appendBatch(fresh, operation());
    expect(receipt.acknowledged).toHaveLength(20);
    expect(receipt.acknowledged.every((item) => item.status === 'stored')).toBe(true);
    const replay = await writer.writer.appendBatch(fresh, operation());
    expect(replay.acknowledged).toHaveLength(20);
    expect(replay.acknowledged.every((item) => item.status === 'already_present')).toBe(true);
    const stored = await admin.query(
      'SELECT count(*)::integer AS count FROM telemetry.telemetry_events WHERE project_id=$1 AND event_id=ANY($2::text[])',
      [projectId, fresh.events.map((event) => event.payload.id)],
    );
    expect(stored.rows[0].count).toBe(20);
  } finally {
    await writer.close(operation());
    await admin.end();
    await database.stop();
  }
});
