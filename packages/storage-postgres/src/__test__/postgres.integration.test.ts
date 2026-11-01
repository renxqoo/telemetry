import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { createServer, type Socket } from 'node:net';
import { createPostgresStore, maintain, migrate } from '../index.js';
import type {
  CanonicalBatch,
  QueryAccess,
  TelemetryStore,
} from '../../../storage-contract/src/index.js';

const connectionString = process.env.TELEMETRY_TEST_DATABASE_URL;
if (!connectionString)
  throw new Error('Use the integration runner with TELEMETRY_TEST_DATABASE_URL');
const admin = new Client({ connectionString });
const stores: TelemetryStore[] = [];
const project = randomUUID();
const operation = (ms = 5000) => ({
  signal: new AbortController().signal,
  deadlineAtMs: Date.now() + ms,
});
let instance = 0;
function store(role: 'collector' | 'query', extra = {}) {
  const result = createPostgresStore({
    connectionString: connectionString!,
    profile: 'development',
    role,
    instanceId: `test${++instance}`,
    nodeId: 'test-node',
    ...extra,
  });
  stores.push(result);
  return result;
}
async function readyPool(value: TelemetryStore) {
  const deadlineAtMs = Date.now() + 5000;
  const signal = new AbortController().signal;
  const started = Date.now();
  const failures: string[] = [];
  while (Date.now() < deadlineAtMs) {
    const result = await value.readiness({ signal, deadlineAtMs });
    if (result.ready) return;
    failures.push(result.reason ?? 'unspecified');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `Pool setup readiness deadline exceeded after ${Date.now() - started}ms and ${failures.length} attempts: ${failures.join(',')}`,
  );
}
function batch(
  id: string = randomUUID(),
  extra: Partial<CanonicalBatch['scope']> = {},
): CanonicalBatch {
  return {
    scope: {
      projectId: project,
      environment: 'production',
      service: 'api',
      source: 'server',
      release: 'v1',
      buildId: 'b1',
      policyVersion: 'p1',
      retentionDays: 30,
      receiptDays: 7,
      ...extra,
    },
    events: [
      {
        digest: 'a'.repeat(64),
        payload: {
          id,
          occurred_at: '2026-01-01T00:00:00.000Z',
          kind: 'event',
          name: 'order.created',
          properties: { count: 1 },
          context: { request_id: 'request-a' },
        },
      },
    ],
  };
}
function access(extra: Partial<QueryAccess> = {}): QueryAccess {
  return {
    projectId: project,
    environment: 'production',
    allowedServices: ['api'],
    allowedKinds: ['event', 'error'],
    actorKeyId: 'reader',
    requestId: randomUUID(),
    queryKind: 'events',
    queryDigest: 'digest',
    auditRetentionDays: 90,
    ...extra,
  };
}
function range(limit = 100) {
  return {
    from: new Date(Date.now() - 3600000).toISOString(),
    to: new Date(Date.now() + 3600000).toISOString(),
    limit,
  };
}

async function synchronousStandbys(value: string) {
  await admin.query(`ALTER SYSTEM SET synchronous_standby_names=${admin.escapeLiteral(value)}`);
  await admin.query('SELECT pg_reload_conf()');
  const until = Date.now() + 1000;
  while (Date.now() < until) {
    if (
      (await admin.query('SHOW synchronous_standby_names')).rows[0].synchronous_standby_names ===
      value
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Synchronous replication configuration did not reload');
}

beforeAll(async () => {
  await admin.connect();
  await migrate(connectionString!);
});
afterAll(async () => {
  await Promise.all(stores.map((value) => value.close(operation())));
  await admin.end();
});

describe('PostgreSQL storage public contract', () => {
  it('replays keep first timestamps and safe projection while changed payload rolls the whole batch back', async () => {
    const writer = store('collector');
    const data = batch();
    const first = await writer.writer.appendBatch(data, operation());
    const replay = structuredClone(data);
    replay.scope.policyVersion = 'p2';
    replay.events[0].payload.properties = { count: 2 };
    expect(await writer.writer.appendBatch(replay, operation())).toEqual({
      acknowledged: [{ ...first.acknowledged[0], status: 'already_present' }],
    });
    const conflicting = structuredClone(data);
    conflicting.events[0].digest = 'b'.repeat(64);
    conflicting.events.push(batch().events[0]);
    await expect(writer.writer.appendBatch(conflicting, operation())).rejects.toMatchObject({
      code: 'event_conflict',
      outcome: 'not_committed',
      items: [{ index: 0, id: data.events[0].payload.id, reason: 'payload_mismatch' }],
    });
    const reader = store('query');
    const key = {
      environment: 'production',
      service: 'api',
      source: 'server' as const,
      id: data.events[0].payload.id,
    };
    const found = await reader.reader.getEvent(key, access({ queryKind: 'event' }), operation());
    expect(found).toMatchObject({
      status: 'found',
      event: { properties: { count: 1 }, policy_version: 'p1' },
    });
    const absent = await reader.reader.getEvent(
      { ...key, id: conflicting.events[1].payload.id },
      access({ queryKind: 'event' }),
      operation(),
    );
    expect(absent).toEqual({ status: 'absent' });
  });

  it('concurrent duplicates never fail on the second uniqueness constraint and every replay changes the WAL barrier', async () => {
    const writers = Array.from({ length: 6 }, () => store('collector'));
    let data = batch();
    for (let round = 0; round < 20; round++) {
      data = batch();
      const results = await Promise.all(
        writers.map((writer) => writer.writer.appendBatch(data, operation())),
      );
      expect(results.filter((result) => result.acknowledged[0].status === 'stored')).toHaveLength(
        1,
      );
      expect(
        results.filter((result) => result.acknowledged[0].status === 'already_present'),
      ).toHaveLength(5);
    }
    const nonce = await admin.query(
      'SELECT confirmation_nonce FROM telemetry.ingest_receipts WHERE project_id=$1 AND event_id=$2',
      [project, data.events[0].payload.id],
    );
    await writers[0].writer.appendBatch(data, operation());
    const after = await admin.query(
      'SELECT confirmation_nonce FROM telemetry.ingest_receipts WHERE project_id=$1 AND event_id=$2',
      [project, data.events[0].payload.id],
    );
    expect(after.rows[0].confirmation_nonce).not.toBe(nonce.rows[0].confirmation_nonce);
    const count = await admin.query(
      'SELECT count(*)::int AS count FROM telemetry.telemetry_events WHERE project_id=$1 AND event_id=$2',
      [project, data.events[0].payload.id],
    );
    expect(count.rows[0].count).toBe(1);
  });

  it('kind changes conflict and errors details hide ordinary receipts even after expiry', async () => {
    const writer = store('collector');
    const reader = store('query');
    const data = batch();
    await writer.writer.appendBatch(data, operation());
    const changed = structuredClone(data);
    changed.events[0].payload.kind = 'error';
    await expect(writer.writer.appendBatch(changed, operation())).rejects.toMatchObject({
      code: 'event_conflict',
    });
    await admin.query(
      "UPDATE telemetry.ingest_receipts SET retain_until=first_received_at+interval '1 millisecond' WHERE project_id=$1 AND event_id=$2",
      [project, data.events[0].payload.id],
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const key = {
      environment: 'production',
      service: 'api',
      source: 'server' as const,
      id: data.events[0].payload.id,
    };
    expect(
      await reader.reader.getEvent(
        key,
        access({ queryKind: 'error', allowedKinds: ['error'] }),
        operation(),
      ),
    ).toEqual({ status: 'absent' });
    expect(await reader.reader.getEvent(key, access({ queryKind: 'event' }), operation())).toEqual({
      status: 'expired',
    });
    await expect(writer.writer.appendBatch(data, operation())).rejects.toMatchObject({
      code: 'event_expired',
    });
  });

  it('keyset pagination respects service and kind scope without duplicates at equal timestamps', async () => {
    const localProject = randomUUID();
    const writer = store('collector');
    const reader = store('query');
    const data = batch('page-a', { projectId: localProject });
    data.events.push({ ...batch('page-b').events[0] }, { ...batch('page-c').events[0] });
    await writer.writer.appendBatch(data, operation());
    const secret = batch('secret', { projectId: localProject, service: 'secret' });
    await writer.writer.appendBatch(secret, operation());
    const allowed = access({ projectId: localProject });
    const first = await reader.reader.findEvents(range(2), allowed, operation());
    expect(first.items.map((item) => item.id)).toEqual(['page-c', 'page-b']);
    expect(first.next_cursor).not.toBeNull();
    const next = await reader.reader.findEvents(
      { ...range(2), after: JSON.parse(first.next_cursor!) },
      allowed,
      operation(),
    );
    expect(next.items.map((item) => item.id)).toEqual(['page-a']);
    expect(next.next_cursor).toBeNull();
    expect(
      (
        await reader.reader.findErrors(
          range(),
          access({ projectId: localProject, queryKind: 'errors', allowedKinds: ['error'] }),
          operation(),
        )
      ).items,
    ).toEqual([]);
    expect(
      await reader.reader.getEvent(
        { environment: 'production', service: 'secret', source: 'server', id: 'secret' },
        access({ projectId: localProject, queryKind: 'event' }),
        operation(),
      ),
    ).toEqual({ status: 'absent' });
    const audit = await admin.query(
      'SELECT row_count,allowed_kinds FROM telemetry.query_audit WHERE request_id=$1',
      [allowed.requestId],
    );
    expect(audit.rows.map((row) => row.row_count).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('RLS denies missing scope and direct child-table access and immutable event updates', async () => {
    await admin.query('BEGIN');
    try {
      await admin.query('SET LOCAL ROLE telemetry_query');
      expect((await admin.query('SELECT event_id FROM telemetry.ingest_receipts')).rowCount).toBe(
        0,
      );
      expect((await admin.query('SELECT event_id FROM telemetry.telemetry_events')).rowCount).toBe(
        0,
      );
    } finally {
      await admin.query('ROLLBACK');
    }
    const client = new Client({ connectionString });
    await client.connect();
    try {
      await client.query('SET ROLE telemetry_collector');
      await expect(
        client.query("UPDATE telemetry.telemetry_events SET name='changed'"),
      ).rejects.toMatchObject({ code: '42501' });
      const partition = await admin.query(
        "SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent='telemetry.telemetry_events'::regclass LIMIT 1",
      );
      await expect(
        client.query(`SELECT * FROM telemetry.${partition.rows[0].relname}`),
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await client.end();
    }
  });

  it('audit insertion failure prevents even an absent detail conclusion from escaping', async () => {
    const reader = store('query');
    await admin.query('REVOKE INSERT ON telemetry.query_audit FROM telemetry_query');
    try {
      await expect(
        reader.reader.getEvent(
          { environment: 'production', service: 'api', source: 'server', id: randomUUID() },
          access({ queryKind: 'event' }),
          operation(),
        ),
      ).rejects.toMatchObject({ code: 'audit_unavailable', outcome: 'not_committed' });
    } finally {
      await admin.query('GRANT INSERT ON telemetry.query_audit TO telemetry_query');
    }
  });

  it('a COMMIT notice makes confirmation irreversibly unknown even when COMMIT completes', async () => {
    const writer = store('collector');
    const data = batch();
    await admin.query(
      "CREATE OR REPLACE FUNCTION telemetry.test_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE WARNING 'commit notification'; RETURN NEW; END $$",
    );
    await admin.query(
      'CREATE CONSTRAINT TRIGGER test_notice AFTER INSERT OR UPDATE ON telemetry.ingest_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION telemetry.test_notice()',
    );
    try {
      await expect(writer.writer.appendBatch(data, operation())).rejects.toMatchObject({
        code: 'confirmation_unknown',
        outcome: 'unknown',
      });
    } finally {
      await admin.query('DROP TRIGGER test_notice ON telemetry.ingest_receipts');
      await admin.query('DROP FUNCTION telemetry.test_notice()');
    }
    const response = await writer.writer.appendBatch(data, operation());
    expect(['stored', 'already_present']).toContain(response.acknowledged[0].status);
  });

  it('a separate COMMIT deadline returns unknown within budget and permits a safe retry', async () => {
    const writer = store('collector', { commitTimeoutMs: 30, cleanupTimeoutMs: 200 });
    const data = batch();
    await admin.query(
      'CREATE OR REPLACE FUNCTION telemetry.test_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$',
    );
    await admin.query(
      'CREATE CONSTRAINT TRIGGER test_delay AFTER INSERT OR UPDATE ON telemetry.ingest_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION telemetry.test_delay()',
    );
    const started = Date.now();
    try {
      await expect(writer.writer.appendBatch(data, operation())).rejects.toMatchObject({
        code: 'confirmation_unknown',
        outcome: 'unknown',
      });
      expect(Date.now() - started).toBeLessThan(200);
    } finally {
      await admin.query('DROP TRIGGER test_delay ON telemetry.ingest_receipts');
      await admin.query('DROP FUNCTION telemetry.test_delay()');
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    const response = await writer.writer.appendBatch(data, operation());
    expect(response.acknowledged).toHaveLength(1);
  });

  it('maintenance serializes metadata work and preserves unexpired event partitions', async () => {
    const writer = store('collector');
    const reader = store('query');
    const data = batch();
    await writer.writer.appendBatch(data, operation());
    await admin.query('BEGIN');
    await admin.query("SELECT pg_advisory_xact_lock(hashtextextended('telemetry:maintain:v1',0))");
    try {
      expect((await maintain(connectionString!, { prebuildDays: 7 })).acquired).toBe(false);
    } finally {
      await admin.query('ROLLBACK');
    }
    expect((await maintain(connectionString!, { prebuildDays: 7 })).acquired).toBe(true);
    expect(
      await reader.reader.getEvent(
        {
          environment: 'production',
          service: 'api',
          source: 'server',
          id: data.events[0].payload.id,
        },
        access({ queryKind: 'event' }),
        operation(),
      ),
    ).toMatchObject({ status: 'found' });
  });

  it('pool exhaustion is bounded and an aborted operation never returns an acknowledgement', async () => {
    const writer = store('collector', { maxConnections: 1, poolWaitMs: 20 });
    const data = batch();
    const controller = new AbortController();
    controller.abort();
    await expect(
      writer.writer.appendBatch(data, {
        signal: controller.signal,
        deadlineAtMs: Date.now() + 1000,
      }),
    ).rejects.toMatchObject({ code: 'storage_unavailable' });
    await expect(
      writer.writer.appendBatch({ ...data, events: [data.events[0], data.events[0]] }, operation()),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
  it('returned clock skew uses the immutable timestamps with an independent 1250 millisecond example', async () => {
    const writer = store('collector');
    const reader = store('query');
    const data = batch();
    await writer.writer.appendBatch(data, operation());
    const day = new Date().toISOString().slice(0, 10);
    await admin.query(
      'UPDATE telemetry.telemetry_events SET received_at=$1,occurred_at=$2 WHERE project_id=$3 AND event_id=$4',
      [`${day}T12:00:00.000Z`, `${day}T11:59:58.750Z`, project, data.events[0].payload.id],
    );
    await admin.query(
      'UPDATE telemetry.ingest_receipts SET first_received_at=$1 WHERE project_id=$2 AND event_id=$3',
      [`${day}T12:00:00.000Z`, project, data.events[0].payload.id],
    );
    expect(
      await reader.reader.getEvent(
        {
          environment: 'production',
          service: 'api',
          source: 'server',
          id: data.events[0].payload.id,
        },
        access({ queryKind: 'event' }),
        operation(),
      ),
    ).toMatchObject({ status: 'found', event: { clock_skew_ms: 1250 } });
  });

  it('a process replacement reconciles the complete precision identity of its prior backend', async () => {
    const instanceId = `restart${++instance}`;
    const residue = new Client({
      connectionString,
      application_name: `telemetry:${instanceId}:previous:nonce`,
    });
    residue.on('error', () => undefined);
    await residue.connect();
    try {
      const restarted = store('collector', { instanceId });
      expect(await restarted.readiness(operation())).toEqual({ ready: true });
      const count = await admin.query(
        'SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name=$1',
        [`telemetry:${instanceId}:previous:nonce`],
      );
      expect(count.rows[0].count).toBe(0);
    } finally {
      await residue.end().catch(() => undefined);
    }
  });

  it('an unexpired authorized receipt without its event is an integrity failure rather than a false absent result', async () => {
    const writer = store('collector');
    const reader = store('query');
    const data = batch();
    await writer.writer.appendBatch(data, operation());
    await admin.query(
      'DELETE FROM telemetry.telemetry_events WHERE project_id=$1 AND event_id=$2',
      [project, data.events[0].payload.id],
    );
    await expect(
      reader.reader.getEvent(
        {
          environment: 'production',
          service: 'api',
          source: 'server',
          id: data.events[0].payload.id,
        },
        access({ queryKind: 'event' }),
        operation(),
      ),
    ).rejects.toMatchObject({ code: 'storage_integrity_error' });
    await expect(writer.writer.appendBatch(data, operation())).rejects.toMatchObject({
      code: 'storage_integrity_error',
    });
  });

  it('a busy one-connection pool rejects a second call within its admission budget', async () => {
    const writer = store('collector', {
      maxConnections: 1,
      poolWaitMs: 20,
      lockTimeoutMs: 200,
      statementTimeoutMs: 500,
    });
    await readyPool(writer);
    const data = batch();
    await writer.writer.appendBatch(data, operation());
    const blocker = new Client({ connectionString });
    await blocker.connect();
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT 1 FROM telemetry.ingest_receipts WHERE project_id=$1 AND event_id=$2 FOR UPDATE',
      [project, data.events[0].payload.id],
    );
    const held = writer.writer.appendBatch(data, operation()).catch((error: unknown) => error);
    try {
      let blocked = false;
      const until = Date.now() + 150;
      while (Date.now() < until) {
        const activity = await admin.query(
          'SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND datname=current_database()',
          [blockerPid],
        );
        if (activity.rowCount) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      const started = Date.now();
      await expect(writer.writer.appendBatch(batch(), operation())).rejects.toMatchObject({
        code: 'overloaded',
      });
      expect(Date.now() - started).toBeLessThan(150);
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
    }
    expect(await held).toMatchObject({
      acknowledged: [{ id: data.events[0].payload.id, status: 'already_present' }],
    });
  });
  it('regression: a cold data connection still expires within its short admission budget', async () => {
    const sockets = new Set<Socket>();
    let accepted = 0;
    async function expectConnectionsClosed() {
      const until = Date.now() + 150;
      while (sockets.size && Date.now() < until)
        await new Promise((resolve) => setTimeout(resolve, 5));
      expect(sockets.size).toBe(0);
    }
    const gate = createServer((socket) => {
      accepted++;
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
      socket.resume();
    });
    await new Promise<void>((resolve, reject) => {
      gate.once('error', reject);
      gate.listen(0, '127.0.0.1', resolve);
    });
    const address = gate.address();
    if (!address || typeof address === 'string') throw new Error('TCP gate address missing');
    const endpoint = new URL(connectionString!);
    endpoint.hostname = '127.0.0.1';
    endpoint.port = String(address.port);
    const writer = store('collector', {
      connectionString: endpoint.href,
      cleanupConnectionString: connectionString,
      maxConnections: 1,
      poolWaitMs: 20,
    });
    const data = batch();
    try {
      expect(await writer.readiness(operation())).toEqual({
        ready: false,
        reason: 'storage_unavailable',
      });
      expect(accepted).toBe(1);
      await expectConnectionsClosed();
      const started = Date.now();
      await expect(writer.writer.appendBatch(data, operation())).rejects.toMatchObject({
        code: 'storage_unavailable',
        outcome: 'not_committed',
      });
      expect(Date.now() - started).toBeLessThan(150);
      await expectConnectionsClosed();
      expect(
        (
          await admin.query('SELECT 1 FROM telemetry.ingest_receipts WHERE event_id=$1', [
            data.events[0].payload.id,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await writer.close(operation());
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        gate.close((error) => (error ? reject(error) : resolve())),
      );
    }
    expect(sockets.size).toBe(0);
  });
  it('regression: a connection admission timeout cannot shorten the SQL budget after pooling', async () => {
    const writer = store('collector', {
      instanceId: 'ready-sql',
      poolWaitMs: 250,
      statementTimeoutMs: 1000,
    });
    expect(await writer.readiness(operation())).toEqual({ ready: true });
    const blocker = new Client({ connectionString });
    await blocker.connect();
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await blocker.query('BEGIN');
    await blocker.query('LOCK telemetry.schema_version IN ACCESS EXCLUSIVE MODE');
    const pending = writer.readiness(operation());
    try {
      let blocked = false;
      const until = Date.now() + 200;
      while (Date.now() < until) {
        const activity = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE starts_with(application_name,'telemetry:ready-sql:') AND $1=ANY(pg_blocking_pids(pid))",
          [blockerPid],
        );
        if (activity.rowCount) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(blocked).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 350));
      await blocker.query('ROLLBACK');
      expect(await pending).toEqual({ ready: true });
    } finally {
      await blocker.query('ROLLBACK');
      await blocker.end();
      await pending;
    }
  });
  it('physical expiry hides events immediately and preserves their tombstone until its own deadline', async () => {
    const writer = store('collector');
    const reader = store('query');
    const data = batch();
    await writer.writer.appendBatch(data, operation());
    await admin.query(
      "UPDATE telemetry.telemetry_events SET retain_until=received_at+interval '1 millisecond' WHERE project_id=$1 AND event_id=$2",
      [project, data.events[0].payload.id],
    );
    await admin.query(
      "UPDATE telemetry.ingest_receipts SET retain_until=first_received_at+interval '1 millisecond' WHERE project_id=$1 AND event_id=$2",
      [project, data.events[0].payload.id],
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const key = {
      environment: 'production',
      service: 'api',
      source: 'server' as const,
      id: data.events[0].payload.id,
    };
    expect(await reader.reader.getEvent(key, access({ queryKind: 'event' }), operation())).toEqual({
      status: 'expired',
    });
    const cleaned = await maintain(connectionString!, { batchSize: 1000 });
    expect(cleaned.eventsDeleted).toBeGreaterThanOrEqual(1);
    expect(await reader.reader.getEvent(key, access({ queryKind: 'event' }), operation())).toEqual({
      status: 'expired',
    });
    await admin.query(
      "UPDATE telemetry.ingest_receipts SET tombstone_until=retain_until+interval '1 millisecond' WHERE project_id=$1 AND event_id=$2",
      [project, data.events[0].payload.id],
    );
    expect(
      (await maintain(connectionString!, { batchSize: 1000 })).receiptsDeleted,
    ).toBeGreaterThanOrEqual(1);
    expect(await reader.reader.getEvent(key, access({ queryKind: 'event' }), operation())).toEqual({
      status: 'absent',
    });
  });

  it('a reader holds the parent partition lock through audit and returns its pre-expiry snapshot', async () => {
    const writer = store('collector');
    const reader = store('query');
    const data = batch();
    await writer.writer.appendBatch(data, operation());
    const old = new Date(Date.now() - 3 * 86400000);
    old.setUTCHours(0, 0, 0, 0);
    const end = new Date(old.getTime() + 86400000);
    const partition = `events_${old.toISOString().slice(0, 10).replaceAll('-', '')}`;
    await admin.query(
      `CREATE TABLE IF NOT EXISTS telemetry.${partition} PARTITION OF telemetry.telemetry_events FOR VALUES FROM ('${old.toISOString()}') TO ('${end.toISOString()}')`,
    );
    await admin.query(`ALTER TABLE telemetry.${partition} OWNER TO telemetry_owner`);
    await admin.query(
      'UPDATE telemetry.telemetry_events SET received_at=$1 WHERE project_id=$2 AND event_id=$3',
      [old, project, data.events[0].payload.id],
    );
    await admin.query(
      'UPDATE telemetry.ingest_receipts SET first_received_at=$1 WHERE project_id=$2 AND event_id=$3',
      [old, project, data.events[0].payload.id],
    );
    const requestId = randomUUID();
    const lockKey = Math.floor(Math.random() * 1000000000) + 1;
    await admin.query(
      `CREATE OR REPLACE FUNCTION telemetry.test_audit_lock() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.request_id='${requestId}' THEN PERFORM pg_advisory_xact_lock(${lockKey}); END IF; RETURN NEW; END $$`,
    );
    await admin.query('DROP TRIGGER IF EXISTS test_audit_lock ON telemetry.query_audit');
    await admin.query(
      'CREATE TRIGGER test_audit_lock BEFORE INSERT ON telemetry.query_audit FOR EACH ROW EXECUTE FUNCTION telemetry.test_audit_lock()',
    );
    const blocker = new Client({ connectionString });
    await blocker.connect();
    await blocker.query('SELECT pg_advisory_lock($1)', [lockKey]);
    const key = {
      environment: 'production',
      service: 'api',
      source: 'server' as const,
      id: data.events[0].payload.id,
    };
    const pending = reader.reader.getEvent(
      key,
      access({ queryKind: 'event', requestId }),
      operation(),
    );
    void pending.catch(() => undefined);
    try {
      try {
        const until = Date.now() + 1000;
        let blocked = false;
        while (Date.now() < until) {
          const waiting = await admin.query(
            "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted",
            [lockKey],
          );
          if (waiting.rowCount) {
            blocked = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(blocked).toBe(true);
        await admin.query(
          "UPDATE telemetry.telemetry_events SET retain_until=received_at+interval '1 millisecond' WHERE project_id=$1 AND event_id=$2",
          [project, data.events[0].payload.id],
        );
        await admin.query(
          "UPDATE telemetry.ingest_receipts SET retain_until=first_received_at+interval '1 millisecond' WHERE project_id=$1 AND event_id=$2",
          [project, data.events[0].payload.id],
        );
        await expect(maintain(connectionString!, { lockTimeoutMs: 20 })).rejects.toMatchObject({
          code: '55P03',
        });
      } finally {
        await blocker.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        await blocker.end();
      }
      expect(await pending).toMatchObject({ status: 'found' });
      expect(
        await reader.reader.getEvent(key, access({ queryKind: 'event' }), operation()),
      ).toEqual({ status: 'expired' });
      expect((await maintain(connectionString!)).partitionsDropped).toBeGreaterThanOrEqual(1);
    } finally {
      await pending.catch(() => undefined);
      await admin.query('DROP TRIGGER test_audit_lock ON telemetry.query_audit');
      await admin.query('DROP FUNCTION telemetry.test_audit_lock()');
    }
  });
  it('readiness rejects a missing schema version and unavailable audit permissions', async () => {
    const reader = store('query');
    expect(await reader.readiness(operation())).toEqual({ ready: true });
    await admin.query('DELETE FROM telemetry.schema_version');
    try {
      expect(await reader.readiness(operation())).toEqual({
        ready: false,
        reason: 'storage_unavailable',
      });
    } finally {
      await admin.query('INSERT INTO telemetry.schema_version VALUES (2)');
    }
    await admin.query('REVOKE INSERT ON telemetry.query_audit FROM telemetry_query');
    try {
      expect(await reader.readiness(operation())).toEqual({
        ready: false,
        reason: 'storage_unavailable',
      });
    } finally {
      await admin.query('GRANT INSERT ON telemetry.query_audit TO telemetry_query');
    }
  });

  it('startup cleans excess prior-generation backends before admitting a reduced connection budget', async () => {
    const instanceId = `reduced${++instance}`;
    const residues: Client[] = [];
    const incidents: string[] = [];
    try {
      for (let index = 0; index < 2; index++) {
        const client = new Client({
          connectionString,
          application_name: `telemetry:${instanceId}:old:nonce${index}`,
        });
        client.on('error', () => undefined);
        await client.connect();
        residues.push(client);
      }
      const restarted = store('collector', {
        instanceId,
        maxConnections: 1,
        onIncident: (incident: { code: string }) => incidents.push(incident.code),
      });
      expect(await restarted.readiness(operation())).toEqual({ ready: true });
      expect(incidents).toContain('startup_backend_budget_exceeded');
      expect(
        (
          await admin.query(
            'SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name LIKE $1',
            [`telemetry:${instanceId}:old:%`],
          )
        ).rows[0].count,
      ).toBe(0);
    } finally {
      await Promise.all(residues.map((client) => client.end().catch(() => undefined)));
    }
  });

  it('an underscore instance slot preserves adjacent live sessions while reclaiming its own prior generation', async () => {
    const suffix = ++instance;
    const instanceId = `app_${suffix}`;
    const adjacent = store('collector', { instanceId: `appX${suffix}` });
    expect(await adjacent.readiness(operation())).toEqual({ ready: true });
    const live = await admin.query(
      'SELECT pid FROM pg_stat_activity WHERE starts_with(application_name,$1)',
      [`telemetry:appX${suffix}:`],
    );
    expect(live.rows).toHaveLength(1);
    const residue = new Client({
      connectionString,
      application_name: `telemetry:${instanceId}:previous:nonce`,
    });
    residue.on('error', () => undefined);
    await residue.connect();
    try {
      const prior = await residue.query('SELECT pg_backend_pid() AS pid');
      const restarted = store('collector', { instanceId });
      expect(await restarted.readiness(operation())).toEqual({ ready: true });
      const remaining = await admin.query(
        'SELECT pid FROM pg_stat_activity WHERE pid=ANY($1::integer[]) ORDER BY pid',
        [[live.rows[0].pid, prior.rows[0].pid]],
      );
      expect(remaining.rows).toEqual([{ pid: live.rows[0].pid }]);
      expect(await adjacent.readiness(operation())).toEqual({ ready: true });
    } finally {
      await residue.end().catch(() => undefined);
    }
  });

  it.each(['40001', '40P01'])(
    'a %s retry cannot reset the total 500 millisecond data-stage budget',
    async (sqlstate) => {
      const writer = store('collector');
      expect(await writer.readiness(operation())).toEqual({ ready: true });
      const data = batch();
      await admin.query('CREATE SEQUENCE telemetry.test_retry_sequence');
      await admin.query(
        'GRANT USAGE ON SEQUENCE telemetry.test_retry_sequence TO telemetry_collector',
      );
      await admin.query(
        `CREATE FUNCTION telemetry.test_retry_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='${data.events[0].payload.id}' THEN PERFORM pg_sleep(0.35); IF nextval('telemetry.test_retry_sequence')=1 THEN RAISE EXCEPTION 'retry' USING ERRCODE='${sqlstate}'; END IF; END IF; RETURN NEW; END $$`,
      );
      await admin.query(
        'CREATE TRIGGER test_retry_delay BEFORE INSERT ON telemetry.ingest_receipts FOR EACH ROW EXECUTE FUNCTION telemetry.test_retry_delay()',
      );
      const started = Date.now();
      try {
        await expect(writer.writer.appendBatch(data, operation(2000))).rejects.toMatchObject({
          code: 'storage_unavailable',
          outcome: 'not_committed',
        });
        expect(Date.now() - started).toBeLessThan(650);
        expect(
          (await admin.query('SELECT last_value FROM telemetry.test_retry_sequence')).rows[0]
            .last_value,
        ).toBe('1');
        expect(
          (
            await admin.query('SELECT 1 FROM telemetry.ingest_receipts WHERE event_id=$1', [
              data.events[0].payload.id,
            ])
          ).rowCount,
        ).toBe(0);
      } finally {
        await admin.query('DROP TRIGGER test_retry_delay ON telemetry.ingest_receipts');
        await admin.query('DROP FUNCTION telemetry.test_retry_delay()');
        await admin.query('DROP SEQUENCE telemetry.test_retry_sequence');
      }
    },
  );

  it('maintenance returns unknown within its deadline instead of waiting indefinitely in synchronous COMMIT', async () => {
    const auditId = randomUUID();
    await admin.query(
      `INSERT INTO telemetry.query_audit
 (audit_id,project_id,environment,actor_key_id,request_id,query_kind,query_digest,services_digest,allowed_kinds,as_of,row_count,created_at,retain_until)
 VALUES ($1,$2,'production','reader',$3,'events','commit-budget','services',ARRAY['event','error'],clock_timestamp(),0,clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second')`,
      [auditId, project, randomUUID()],
    );
    const original = (await admin.query('SHOW synchronous_standby_names')).rows[0]
      .synchronous_standby_names;
    await admin.query('SET synchronous_commit=off');
    await synchronousStandbys('telemetry_missing_replica');
    let pending: Promise<unknown> | undefined;
    let emergency: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const started = Date.now();
      pending = maintain(connectionString!, { deadlineAtMs: started + 150 }).catch(
        (error: unknown) => error,
      );
      emergency = setTimeout(() => {
        void admin.query(
          "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE starts_with(application_name,'telemetry:maintenance-admin:')",
        );
      }, 450);
      let waitingForReplication = false;
      while (Date.now() < started + 150) {
        const activity = await admin.query(
          "SELECT 1 FROM pg_stat_activity WHERE starts_with(application_name,'telemetry:maintenance-admin:') AND datname=current_database() AND query='COMMIT' AND wait_event='SyncRep'",
        );
        if (activity.rowCount) {
          waitingForReplication = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(await pending).toMatchObject({ code: 'confirmation_unknown', outcome: 'unknown' });
      expect(waitingForReplication).toBe(true);
      expect(Date.now() - started).toBeLessThan(350);
      clearTimeout(emergency);
      emergency = undefined;
      const until = Date.now() + 1500;
      let sessions = 1;
      while (sessions && Date.now() < until) {
        sessions = (
          await admin.query(
            "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE starts_with(application_name,'telemetry:maintenance-admin:')",
          )
        ).rows[0].count;
        if (sessions) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(sessions).toBe(0);
      expect(
        (await admin.query('SELECT 1 FROM telemetry.query_audit WHERE audit_id=$1', [auditId]))
          .rowCount,
      ).toBe(0);
    } finally {
      if (emergency) clearTimeout(emergency);
      await admin.query(
        "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE starts_with(application_name,'telemetry:maintenance-admin:')",
      );
      await synchronousStandbys(original);
      if (pending) await pending;
      await admin.query('SET synchronous_commit=on');
    }
  });

  it.each(['40001', '40P01'])(
    'a rolled-back %s failure can retry once within the shared data-stage budget',
    async (sqlstate) => {
      const writer = store('collector');
      const data = batch();
      await admin.query('CREATE SEQUENCE telemetry.test_success_retry_sequence');
      await admin.query(
        'GRANT USAGE ON SEQUENCE telemetry.test_success_retry_sequence TO telemetry_collector',
      );
      await admin.query(
        `CREATE FUNCTION telemetry.test_success_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='${data.events[0].payload.id}' THEN PERFORM pg_sleep(0.1); IF nextval('telemetry.test_success_retry_sequence')=1 THEN RAISE EXCEPTION 'retry' USING ERRCODE='${sqlstate}'; END IF; END IF; RETURN NEW; END $$`,
      );
      await admin.query(
        'CREATE TRIGGER test_success_retry BEFORE INSERT ON telemetry.ingest_receipts FOR EACH ROW EXECUTE FUNCTION telemetry.test_success_retry()',
      );
      try {
        expect(await writer.writer.appendBatch(data, operation(2000))).toMatchObject({
          acknowledged: [{ id: data.events[0].payload.id, status: 'stored' }],
        });
        expect(
          (await admin.query('SELECT last_value FROM telemetry.test_success_retry_sequence'))
            .rows[0].last_value,
        ).toBe('2');
      } finally {
        await admin.query('DROP TRIGGER test_success_retry ON telemetry.ingest_receipts');
        await admin.query('DROP FUNCTION telemetry.test_success_retry()');
        await admin.query('DROP SEQUENCE telemetry.test_success_retry_sequence');
      }
    },
  );

  it('a second serialization failure does not open a third transaction', async () => {
    const writer = store('collector');
    const data = batch();
    await admin.query('CREATE SEQUENCE telemetry.test_failed_retry_sequence');
    await admin.query(
      'GRANT USAGE ON SEQUENCE telemetry.test_failed_retry_sequence TO telemetry_collector',
    );
    await admin.query(
      `CREATE FUNCTION telemetry.test_failed_retry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='${data.events[0].payload.id}' THEN PERFORM nextval('telemetry.test_failed_retry_sequence'); RAISE EXCEPTION 'retry' USING ERRCODE='40001'; END IF; RETURN NEW; END $$`,
    );
    await admin.query(
      'CREATE TRIGGER test_failed_retry BEFORE INSERT ON telemetry.ingest_receipts FOR EACH ROW EXECUTE FUNCTION telemetry.test_failed_retry()',
    );
    try {
      await expect(writer.writer.appendBatch(data, operation(2000))).rejects.toMatchObject({
        code: 'storage_unavailable',
        outcome: 'not_committed',
      });
      expect(
        (await admin.query('SELECT last_value FROM telemetry.test_failed_retry_sequence')).rows[0]
          .last_value,
      ).toBe('2');
      expect(
        (
          await admin.query('SELECT 1 FROM telemetry.ingest_receipts WHERE event_id=$1', [
            data.events[0].payload.id,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await admin.query('DROP TRIGGER test_failed_retry ON telemetry.ingest_receipts');
      await admin.query('DROP FUNCTION telemetry.test_failed_retry()');
      await admin.query('DROP SEQUENCE telemetry.test_failed_retry_sequence');
    }
  });

  it('a synchronous COMMIT cancellation WARNING cannot turn maintenance into false success', async () => {
    const future = new Date(Date.now() + 8 * 86400000)
      .toISOString()
      .slice(0, 10)
      .replaceAll('-', '');
    await admin.query(`DROP TABLE IF EXISTS telemetry.events_${future}`);
    const original = (await admin.query('SHOW synchronous_standby_names')).rows[0]
      .synchronous_standby_names;
    await admin.query('SET synchronous_commit=off');
    await synchronousStandbys('telemetry_missing_replica');
    let pending: Promise<unknown> | undefined;
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      pending = maintain(connectionString!, {
        prebuildDays: 8,
        deadlineAtMs: Date.now() + 2000,
      }).catch((error: unknown) => error);
      const until = Date.now() + 500;
      let pid: number | undefined;
      while (!pid && Date.now() < until) {
        pid = (
          await admin.query(
            "SELECT pid FROM pg_stat_activity WHERE starts_with(application_name,'telemetry:maintenance-admin:') AND wait_event='SyncRep'",
          )
        ).rows[0]?.pid;
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(pid).toBeTypeOf('number');
      await admin.query('SELECT pg_cancel_backend($1)', [pid]);
      expect(await pending).toMatchObject({ code: 'confirmation_unknown', outcome: 'unknown' });
    } finally {
      await admin.query(
        "SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE starts_with(application_name,'telemetry:maintenance-admin:')",
      );
      await synchronousStandbys(original);
      if (pending) await pending;
      await admin.query('SET synchronous_commit=on');
    }
  });

  it('maintenance preserves a live predecessor and repeated restarts cannot bypass failed cleanup of its expired SyncRep backend', async () => {
    const original = (await admin.query('SHOW synchronous_standby_names')).rows[0]
      .synchronous_standby_names;
    const role = `test_maint_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const password = randomUUID();
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD ${admin.escapeLiteral(password)}`);
    await admin.query(`GRANT telemetry_owner,telemetry_cleanup TO ${role}`);
    const restricted = new URL(connectionString!);
    restricted.username = role;
    restricted.password = password;
    await admin.query('SET synchronous_commit=off');
    await synchronousStandbys('telemetry_missing_replica');
    const deadline = Date.now() + 500;
    const application = `telemetry:maintenance-admin:${deadline}:previous:nonce`;
    const residue = new Client({ connectionString, application_name: application });
    residue.on('error', () => undefined);
    let pending: Promise<unknown> | undefined;
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await residue.connect();
      const backend = (await residue.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await residue.query('BEGIN');
      await residue.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('telemetry:maintain:v1',0))",
      );
      await residue.query('CREATE TABLE telemetry.test_maintenance_orphan (id integer)');
      pending = residue.query('COMMIT').catch((error: unknown) => error);
      const until = Date.now() + 200;
      let waiting = false;
      while (!waiting && Date.now() < until) {
        waiting =
          (
            await admin.query(
              "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='SyncRep'",
              [backend],
            )
          ).rowCount === 1;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true);
      expect(
        (
          await admin.query(
            "SELECT pg_try_advisory_xact_lock(hashtextextended('telemetry:maintain:v1',0)) AS acquired",
          )
        ).rows[0].acquired,
      ).toBe(false);
      expect(await maintain(connectionString!, { deadlineAtMs: Date.now() + 1000 })).toMatchObject({
        acquired: false,
      });
      expect(
        (await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [backend])).rowCount,
      ).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now() + 10)));
      for (let restart = 0; restart < 3; restart++) {
        await expect(
          maintain(restricted.toString(), { deadlineAtMs: Date.now() + 500 }),
        ).rejects.toMatchObject({ code: '42501' });
        expect(
          (
            await admin.query(
              "SELECT pid FROM pg_stat_activity WHERE starts_with(application_name,'telemetry:maintenance-admin:')",
            )
          ).rows,
        ).toEqual([{ pid: backend }]);
      }
    } finally {
      await admin.query(
        'SELECT pg_cancel_backend(pid) FROM pg_stat_activity WHERE application_name=$1',
        [application],
      );
      if (pending) await pending;
      await residue.end().catch(() => undefined);
      await synchronousStandbys(original);
      await admin.query('DROP TABLE IF EXISTS telemetry.test_maintenance_orphan');
      await admin.query(`DROP ROLE ${role}`);
      await admin.query('SET synchronous_commit=on');
    }
  });

  it('maintenance reclaims an expired prior process before opening its metadata transaction', async () => {
    const residue = new Client({
      connectionString,
      application_name: `telemetry:maintenance-admin:${Date.now() - 1000}:previous:nonce`,
    });
    residue.on('error', () => undefined);
    await residue.connect();
    try {
      const backend = (await residue.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      expect(await maintain(connectionString!)).toMatchObject({ acquired: true });
      expect(
        (await admin.query('SELECT 1 FROM pg_stat_activity WHERE pid=$1', [backend])).rowCount,
      ).toBe(0);
    } finally {
      await residue.end().catch(() => undefined);
    }
  });

  it('list limits 101 and 500 return the requested count while 501 is rejected', async () => {
    const writer = store('collector');
    const reader = store('query');
    const localProject = randomUUID();
    const events = Array.from({ length: 501 }, () => batch().events[0]);
    for (let offset = 0; offset < events.length; offset += 20) {
      const data = batch(randomUUID(), { projectId: localProject });
      data.events = events.slice(offset, offset + 20);
      await writer.writer.appendBatch(data, operation());
    }
    const allowed = access({ projectId: localProject });
    expect((await reader.reader.findEvents(range(101), allowed, operation())).items).toHaveLength(
      101,
    );
    expect((await reader.reader.findEvents(range(500), allowed, operation())).items).toHaveLength(
      500,
    );
    await expect(reader.reader.findEvents(range(501), allowed, operation())).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});
