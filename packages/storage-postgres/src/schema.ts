import { Client } from 'pg';
import { traceSchema } from './trace-schema.js';
import { StoreError } from '../../storage-contract/src/index.js';
import { budget, createConnections, remaining, type Connection } from './connections.js';
import { positiveInteger, type MaintenanceOptions, type MaintenanceResult } from './options.js';

const roles = [
  'telemetry_owner',
  'telemetry_collector',
  'telemetry_query',
  'telemetry_maintainer',
  'telemetry_cleanup',
];

const schema = `
CREATE SCHEMA IF NOT EXISTS telemetry AUTHORIZATION telemetry_owner;
REVOKE ALL ON SCHEMA telemetry FROM PUBLIC;
GRANT USAGE ON SCHEMA telemetry TO telemetry_collector, telemetry_query, telemetry_maintainer;
SET LOCAL ROLE telemetry_owner;
CREATE OR REPLACE FUNCTION telemetry.sync_replica_available() RETURNS boolean
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_stat_replication WHERE state='streaming' AND sync_state IN ('sync','quorum'))
 $$;
REVOKE ALL ON FUNCTION telemetry.sync_replica_available() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION telemetry.sync_replica_available() TO telemetry_collector,telemetry_query;
CREATE TABLE IF NOT EXISTS telemetry.schema_version (version integer PRIMARY KEY CHECK (version = 1));
ALTER TABLE telemetry.schema_version DROP CONSTRAINT IF EXISTS schema_version_version_check;
ALTER TABLE telemetry.schema_version ADD CONSTRAINT schema_version_version_check CHECK(version IN (1,2));
INSERT INTO telemetry.schema_version VALUES (2) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS telemetry.ingest_receipts (
 project_id text NOT NULL, environment text NOT NULL, service text NOT NULL,
 source text NOT NULL CHECK (source IN ('browser','server')), event_id text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('event','error')), payload_digest text NOT NULL,
 first_received_at timestamptz NOT NULL, retain_until timestamptz NOT NULL, tombstone_until timestamptz NOT NULL,
 first_operation_id uuid NOT NULL, confirmation_nonce uuid NOT NULL, policy_version text NOT NULL,
 PRIMARY KEY (project_id,environment,service,source,event_id),
 UNIQUE (project_id,environment,service,source,event_id,kind),
 CHECK (retain_until > first_received_at AND tombstone_until > retain_until)
);
CREATE TABLE IF NOT EXISTS telemetry.telemetry_events (
 project_id text NOT NULL, environment text NOT NULL, service text NOT NULL,
 source text NOT NULL CHECK (source IN ('browser','server')), received_at timestamptz NOT NULL, event_id text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('event','error')), occurred_at timestamptz NOT NULL,
 release text NOT NULL, build_id text NOT NULL, name text NOT NULL, properties jsonb NOT NULL,
 context jsonb, error jsonb, fingerprint text, truncated boolean, sample_rate double precision,
 policy_version text NOT NULL, retain_until timestamptz NOT NULL,
 PRIMARY KEY (project_id,environment,service,source,received_at,event_id),
 FOREIGN KEY (project_id,environment,service,source,event_id,kind)
 REFERENCES telemetry.ingest_receipts (project_id,environment,service,source,event_id,kind),
 CHECK (retain_until > received_at)
) PARTITION BY RANGE (received_at);
CREATE INDEX IF NOT EXISTS telemetry_page_idx ON telemetry.telemetry_events
 (project_id,environment,received_at DESC,service DESC,source DESC,event_id DESC);
CREATE INDEX IF NOT EXISTS telemetry_detail_idx ON telemetry.telemetry_events
 (project_id,environment,service,source,event_id);
CREATE INDEX IF NOT EXISTS telemetry_request_idx ON telemetry.telemetry_events
 (project_id,environment,(context->>'request_id'),received_at DESC) WHERE context->>'request_id' IS NOT NULL;
CREATE INDEX IF NOT EXISTS telemetry_release_idx ON telemetry.telemetry_events
 (project_id,environment,service,release,received_at DESC);
CREATE INDEX IF NOT EXISTS telemetry_fingerprint_idx ON telemetry.telemetry_events
 (project_id,environment,fingerprint,received_at DESC) WHERE kind='error';
CREATE INDEX IF NOT EXISTS receipts_expiry_idx ON telemetry.ingest_receipts (tombstone_until);
CREATE TABLE IF NOT EXISTS telemetry.query_audit (
 audit_id uuid PRIMARY KEY, project_id text NOT NULL, environment text NOT NULL,
 actor_key_id text NOT NULL, request_id text NOT NULL, query_kind text NOT NULL CHECK (query_kind IN ('events','errors','event','error')),
 query_digest text NOT NULL, services_digest text NOT NULL, allowed_kinds text[] NOT NULL,
 as_of timestamptz NOT NULL, row_count integer NOT NULL CHECK (row_count >= 0),
 created_at timestamptz NOT NULL, retain_until timestamptz NOT NULL CHECK (retain_until > created_at)
);
CREATE INDEX IF NOT EXISTS audit_expiry_idx ON telemetry.query_audit (retain_until);
ALTER TABLE telemetry.ingest_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.ingest_receipts FORCE ROW LEVEL SECURITY;
ALTER TABLE telemetry.telemetry_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.telemetry_events FORCE ROW LEVEL SECURITY;
ALTER TABLE telemetry.query_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE telemetry.query_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS receipt_collector ON telemetry.ingest_receipts;
CREATE POLICY receipt_collector ON telemetry.ingest_receipts TO telemetry_collector
 USING (project_id=current_setting('telemetry.project_id',true) AND environment=current_setting('telemetry.environment',true)
 AND service=ANY(COALESCE(NULLIF(current_setting('telemetry.services',true),'')::text[],ARRAY[]::text[])))
 WITH CHECK (project_id=current_setting('telemetry.project_id',true) AND environment=current_setting('telemetry.environment',true)
 AND service=ANY(COALESCE(NULLIF(current_setting('telemetry.services',true),'')::text[],ARRAY[]::text[])));
DROP POLICY IF EXISTS event_collector ON telemetry.telemetry_events;
CREATE POLICY event_collector ON telemetry.telemetry_events TO telemetry_collector
 USING (project_id=current_setting('telemetry.project_id',true) AND environment=current_setting('telemetry.environment',true)
 AND service=ANY(COALESCE(NULLIF(current_setting('telemetry.services',true),'')::text[],ARRAY[]::text[])))
 WITH CHECK (project_id=current_setting('telemetry.project_id',true) AND environment=current_setting('telemetry.environment',true)
 AND service=ANY(COALESCE(NULLIF(current_setting('telemetry.services',true),'')::text[],ARRAY[]::text[])));
DROP POLICY IF EXISTS receipt_query ON telemetry.ingest_receipts;
CREATE POLICY receipt_query ON telemetry.ingest_receipts FOR SELECT TO telemetry_query
 USING (project_id=current_setting('telemetry.project_id',true) AND environment=current_setting('telemetry.environment',true)
 AND service=ANY(COALESCE(NULLIF(current_setting('telemetry.services',true),'')::text[],ARRAY[]::text[]))
 AND kind=ANY(COALESCE(NULLIF(current_setting('telemetry.kinds',true),'')::text[],ARRAY[]::text[])));
DROP POLICY IF EXISTS event_query ON telemetry.telemetry_events;
CREATE POLICY event_query ON telemetry.telemetry_events FOR SELECT TO telemetry_query
 USING (project_id=current_setting('telemetry.project_id',true) AND environment=current_setting('telemetry.environment',true)
 AND service=ANY(COALESCE(NULLIF(current_setting('telemetry.services',true),'')::text[],ARRAY[]::text[]))
 AND kind=ANY(COALESCE(NULLIF(current_setting('telemetry.kinds',true),'')::text[],ARRAY[]::text[])));
DROP POLICY IF EXISTS audit_query ON telemetry.query_audit;
CREATE POLICY audit_query ON telemetry.query_audit FOR INSERT TO telemetry_query
 WITH CHECK (project_id=current_setting('telemetry.project_id',true) AND environment=current_setting('telemetry.environment',true)
 AND cardinality(allowed_kinds)>0 AND allowed_kinds<@COALESCE(NULLIF(current_setting('telemetry.kinds',true),'')::text[],ARRAY[]::text[]));
DROP POLICY IF EXISTS receipt_maintenance ON telemetry.ingest_receipts;
CREATE POLICY receipt_maintenance ON telemetry.ingest_receipts TO telemetry_owner USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS event_maintenance ON telemetry.telemetry_events;
CREATE POLICY event_maintenance ON telemetry.telemetry_events TO telemetry_owner USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS audit_maintenance ON telemetry.query_audit;
CREATE POLICY audit_maintenance ON telemetry.query_audit TO telemetry_owner USING (true) WITH CHECK (true);
REVOKE ALL ON ALL TABLES IN SCHEMA telemetry FROM PUBLIC;
GRANT SELECT ON telemetry.schema_version TO telemetry_collector, telemetry_query;
GRANT SELECT,INSERT ON telemetry.ingest_receipts TO telemetry_collector;
GRANT UPDATE (confirmation_nonce) ON telemetry.ingest_receipts TO telemetry_collector;
GRANT SELECT,INSERT ON telemetry.telemetry_events TO telemetry_collector;
GRANT SELECT ON telemetry.ingest_receipts, telemetry.telemetry_events TO telemetry_query;
GRANT INSERT ON telemetry.query_audit TO telemetry_query;
${traceSchema}
RESET ROLE;
GRANT telemetry_owner TO telemetry_maintainer;
GRANT pg_read_all_stats TO telemetry_owner;
GRANT pg_read_all_stats, pg_signal_backend TO telemetry_cleanup;
`;

export async function migrate(
  connectionString: string,
  options: { finalize?: boolean; rollbackEvents?: boolean } = { finalize: true },
): Promise<void> {
  const client = new Client({
    connectionString,
    application_name: 'telemetry:migrate',
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='30s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('telemetry:migrate:v1',0))");
    for (const role of roles) {
      const found = await client.query('SELECT 1 FROM pg_roles WHERE rolname=$1', [role]);
      if (!found.rowCount)
        await client.query(
          `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
        );
      const actual = await client.query(
        'SELECT rolsuper,rolbypassrls,rolcanlogin,rolcreatedb,rolcreaterole,rolreplication FROM pg_roles WHERE rolname=$1',
        [role],
      );
      if (
        actual.rows[0].rolsuper ||
        actual.rows[0].rolbypassrls ||
        actual.rows[0].rolcanlogin ||
        actual.rows[0].rolcreatedb ||
        actual.rows[0].rolcreaterole ||
        actual.rows[0].rolreplication
      )
        throw new Error(`Unsafe role ${role}`);
    }
    await client.query(schema);
    if (options.rollbackEvents)
      await client.query('INSERT INTO telemetry.schema_version VALUES (1) ON CONFLICT DO NOTHING');
    if (options.finalize !== false && !options.rollbackEvents)
      await client.query(
        'DELETE FROM telemetry.schema_version WHERE version=1; ALTER TABLE telemetry.schema_version DROP CONSTRAINT schema_version_version_check; ALTER TABLE telemetry.schema_version ADD CONSTRAINT schema_version_version_check CHECK(version=2)',
      );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  await maintain(connectionString, { prebuildDays: 7 });
}

export async function maintain(
  connectionString: string,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> {
  const prebuildDays = positiveInteger(options.prebuildDays ?? 7, 'prebuildDays', 366);
  if (prebuildDays < 7) throw new Error('At least seven future partitions required');
  const batchSize = positiveInteger(options.batchSize ?? 1000, 'batchSize', 10000);
  const lockTimeout = positiveInteger(options.lockTimeoutMs ?? 200, 'lockTimeoutMs', 10000);
  const deadline = options.deadlineAtMs ?? Date.now() + 30000;
  if (!Number.isFinite(deadline) || deadline <= Date.now())
    throw new Error('Maintenance deadline exceeded');
  const operation = { signal: new AbortController().signal, deadlineAtMs: deadline };
  const value = budget(operation);
  const connections = createConnections(
    {
      connectionString,
      profile: 'development',
      role: 'collector',
      instanceId: 'maintain',
      nodeId: 'maintenance',
      lockTimeoutMs: lockTimeout,
    },
    'maintenance',
  );
  const result: MaintenanceResult = {
    acquired: false,
    partitionsCreated: 0,
    partitionsDropped: 0,
    eventsDeleted: 0,
    spansDeleted: 0,
    spanReceiptsDeleted: 0,
    receiptsDeleted: 0,
    auditsDeleted: 0,
    traceAuditsDeleted: 0,
  };
  let connection: Connection | undefined;
  let begun = false;
  let commitStarted = false;
  let ended = false;
  try {
    connection = await connections.acquire(value);
    const client = {
      query: (text: string, values?: unknown[]) =>
        connections.query(connection!, text, values, value),
    };
    await client.query('BEGIN');
    begun = true;
    await client.query('SET LOCAL synchronous_commit=on; SET LOCAL client_min_messages=warning');
    await client.query(
      "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$2,true)",
      [String(lockTimeout), String(remaining(value))],
    );
    const lock = await client.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended('telemetry:maintain:v1',0)) AS acquired",
    );
    if (!lock.rows[0].acquired) {
      await client.query('ROLLBACK');
      ended = true;
      return result;
    }
    result.acquired = true;
    const now = await client.query('SELECT clock_timestamp() AS now');
    const day = new Date(now.rows[0].now);
    day.setUTCHours(0, 0, 0, 0);
    for (const [prefix, parent] of [
      ['events', 'telemetry_events'],
      ['spans', 'trace_spans'],
    ]) {
      for (let offset = -1; offset <= prebuildDays; offset++) {
        if (Date.now() >= deadline) throw new Error('Maintenance deadline exceeded');
        const start = new Date(day.getTime() + offset * 86400000);
        const end = new Date(start.getTime() + 86400000);
        const name = `${prefix}_${start.toISOString().slice(0, 10).replaceAll('-', '')}`;
        const exists = await client.query(
          "SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='telemetry' AND c.relname=$1",
          [name],
        );
        if (!exists.rowCount) {
          await client.query(
            `CREATE TABLE telemetry.${name} PARTITION OF telemetry.${parent} FOR VALUES FROM ('${start.toISOString()}') TO ('${end.toISOString()}')`,
          );
          await client.query(
            `ALTER TABLE telemetry.${name} ENABLE ROW LEVEL SECURITY; ALTER TABLE telemetry.${name} FORCE ROW LEVEL SECURITY; CREATE POLICY maintenance ON telemetry.${name} TO telemetry_owner USING (true) WITH CHECK (true); REVOKE ALL ON telemetry.${name} FROM PUBLIC`,
          );
          result.partitionsCreated++;
        }
      }
      const parts = await client.query(
        'SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid WHERE i.inhparent=$1::regclass',
        [`telemetry.${parent}`],
      );
      for (const part of parts.rows) {
        if (!/^(?:events|spans)_[0-9]{8}$/.test(part.relname))
          throw new Error('Unexpected partition name');
        if (Date.now() >= deadline) throw new Error('Maintenance deadline exceeded');
        const empty = await client.query(
          `SELECT NOT EXISTS (SELECT 1 FROM telemetry.${part.relname} WHERE retain_until>$1 LIMIT 1) AS expired`,
          [now.rows[0].now],
        );
        const stamp = String(part.relname).split('_')[1];
        const partitionDate = `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`;
        if (
          empty.rows[0].expired &&
          new Date(`${partitionDate}T00:00:00Z`).getTime() < day.getTime() - 86400000
        ) {
          await client.query(`DROP TABLE telemetry.${part.relname}`);
          result.partitionsDropped++;
        }
      }
    }
    const removedSpans = await client.query(
      'WITH doomed AS (SELECT tableoid,ctid FROM telemetry.trace_spans WHERE retain_until<=$1 LIMIT $2) DELETE FROM telemetry.trace_spans s USING doomed d WHERE s.tableoid=d.tableoid AND s.ctid=d.ctid',
      [now.rows[0].now, batchSize],
    );
    result.spansDeleted = removedSpans.rowCount ?? 0;
    const removedReceipts = await client.query(
      'WITH doomed AS (SELECT r.ctid FROM telemetry.span_receipts r WHERE tombstone_until<=$1 AND NOT EXISTS (SELECT 1 FROM telemetry.trace_spans s WHERE s.project_id=r.project_id AND s.environment=r.environment AND s.trace_id=r.trace_id AND s.span_id=r.span_id) LIMIT $2) DELETE FROM telemetry.span_receipts r USING doomed d WHERE r.ctid=d.ctid',
      [now.rows[0].now, batchSize],
    );
    result.spanReceiptsDeleted = removedReceipts.rowCount ?? 0;
    const events = await client.query(
      'WITH doomed AS (SELECT tableoid,ctid FROM telemetry.telemetry_events WHERE retain_until<=$1 LIMIT $2) DELETE FROM telemetry.telemetry_events e USING doomed d WHERE e.tableoid=d.tableoid AND e.ctid=d.ctid',
      [now.rows[0].now, batchSize],
    );
    result.eventsDeleted = events.rowCount ?? 0;
    const receipts = await client.query(
      'WITH doomed AS (SELECT r.ctid FROM telemetry.ingest_receipts r WHERE tombstone_until<=$1 AND NOT EXISTS (SELECT 1 FROM telemetry.telemetry_events e WHERE e.project_id=r.project_id AND e.environment=r.environment AND e.service=r.service AND e.source=r.source AND e.event_id=r.event_id) LIMIT $2) DELETE FROM telemetry.ingest_receipts r USING doomed d WHERE r.ctid=d.ctid',
      [now.rows[0].now, batchSize],
    );
    result.receiptsDeleted = receipts.rowCount ?? 0;
    const traceAudits = await client.query(
      'WITH doomed AS (SELECT ctid FROM telemetry.trace_query_audit WHERE retain_until<=$1 LIMIT $2) DELETE FROM telemetry.trace_query_audit a USING doomed d WHERE a.ctid=d.ctid',
      [now.rows[0].now, batchSize],
    );
    result.traceAuditsDeleted = traceAudits.rowCount ?? 0;
    const audits = await client.query(
      'WITH doomed AS (SELECT ctid FROM telemetry.query_audit WHERE retain_until<=$1 LIMIT $2) DELETE FROM telemetry.query_audit a USING doomed d WHERE a.ctid=d.ctid',
      [now.rows[0].now, batchSize],
    );
    result.auditsDeleted = audits.rowCount ?? 0;
    const safe = await client.query(
      "SELECT current_setting('synchronous_commit') AS sync,current_setting('client_min_messages') AS messages",
    );
    if (safe.rows[0].sync !== 'on' || safe.rows[0].messages !== 'warning')
      throw new StoreError('storage_unavailable');
    commitStarted = true;
    await connections.commit(connection, value);
    ended = true;
    return result;
  } catch (error) {
    if (!connection && error instanceof StoreError && error.code === 'overloaded') return result;
    if (connection && begun && !commitStarted && !connection.broken) {
      try {
        await connections.query(connection, 'ROLLBACK', undefined, value);
        ended = true;
      } catch {
        connections.discard(connection);
      }
    }
    throw error;
  } finally {
    if (connection) {
      if (begun && !ended) connections.discard(connection);
      connections.release(connection);
    }
    await connections.close(operation);
  }
}
