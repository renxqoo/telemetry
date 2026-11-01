import { createTraceStore } from './traces.js';
import type { TraceQueryAccess } from '../../storage-contract/src/index.js';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  StoreError,
  type CanonicalBatch,
  type EventKey,
  type EventLookup,
  type EventQuery,
  type OperationOptions,
  type QueryAccess,
  type TelemetryStore,
  type WriteReceipt,
} from '../../storage-contract/src/index.js';
import type { EventPage, StoredEvent, Acknowledgement } from '../../protocol/src/types.js';
import {
  budget,
  createConnections,
  remaining,
  type Budget,
  type Connection,
} from './connections.js';
import { positiveInteger, type PostgresStoreOptions } from './options.js';

export { migrate, maintain } from './schema.js';
export type { PostgresStoreOptions, MaintenanceOptions, MaintenanceResult } from './options.js';

const projection = `project_id,environment,service,source,event_id AS id,occurred_at,kind,name,properties,
 context,error,fingerprint,truncated,sample_rate,release,build_id,received_at,retain_until,policy_version`;

function eventFromRow(row: Record<string, unknown>): StoredEvent {
  const event = {
    ...row,
    clock_skew_ms:
      new Date(row.received_at as string).getTime() - new Date(row.occurred_at as string).getTime(),
  } as Record<string, unknown>;
  for (const name of ['occurred_at', 'received_at', 'retain_until'])
    event[name] = new Date(row[name] as string).toISOString();
  for (const name of ['context', 'error', 'fingerprint', 'truncated', 'sample_rate'])
    if (event[name] === null) delete event[name];
  return event as unknown as StoredEvent;
}

function strings(values: string[]): string {
  return `{${values.map((value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join(',')}}`;
}

function validateAccess(access: QueryAccess | TraceQueryAccess) {
  const allowedKinds = 'allowedKinds' in access ? access.allowedKinds : ['span'];
  if (
    !access.projectId ||
    !access.environment ||
    !access.actorKeyId ||
    !access.requestId ||
    !access.queryDigest ||
    !access.allowedServices.length ||
    !allowedKinds.length ||
    allowedKinds.some(
      (kind) =>
        kind !== 'event' &&
        kind !== 'error' &&
        !(kind === 'span' && ['spans', 'trace'].includes(access.queryKind)),
    )
  )
    throw new StoreError('forbidden');
  if (
    (access.queryKind === 'errors' || access.queryKind === 'error') &&
    (allowedKinds.length !== 1 || allowedKinds[0] !== 'error')
  )
    throw new StoreError('forbidden');
  positiveInteger(access.auditRetentionDays, 'auditRetentionDays', 3660);
}

export function createPostgresStore(options: PostgresStoreOptions): TelemetryStore {
  const connections = createConnections(options);
  const { settings } = connections;

  async function scope(
    connection: Connection,
    value: Budget,
    projectId: string,
    environment: string,
    services: string[],
    kinds: string[],
  ) {
    await connections.query(
      connection,
      `SELECT set_config('telemetry.project_id',$1,true),set_config('telemetry.environment',$2,true),
 set_config('telemetry.services',$3,true),set_config('telemetry.kinds',$4,true)`,
      [projectId, environment, strings(services), strings(kinds)],
      value,
    );
  }

  async function verify(connection: Connection, value: Budget) {
    const result = await connections.query(
      connection,
      `SELECT current_setting('synchronous_commit') AS sync,
 current_setting('client_min_messages') AS messages,current_setting('fsync') AS fsync,
 current_setting('full_page_writes') AS full_page_writes,current_setting('synchronous_standby_names') AS standbys,
 pg_is_in_recovery() AS recovery,
 telemetry.sync_replica_available() AS sync_available`,
      undefined,
      value,
    );
    const row = result.rows[0];
    if (row.recovery || row.messages !== 'warning' || row.sync !== 'on')
      throw new StoreError('storage_unavailable');
    if (
      options.profile === 'ha' &&
      (row.fsync !== 'on' || row.full_page_writes !== 'on' || !row.standbys || !row.sync_available)
    )
      throw new StoreError('storage_unavailable');
  }

  async function transaction<T>(
    operation: OperationOptions,
    reading: boolean,
    work: (connection: Connection, value: Budget) => Promise<T>,
  ): Promise<T> {
    const value = budget(operation);
    let dataBudget: Budget | undefined;
    for (let attempt = 0; ; attempt++) {
      const connection = await connections.acquire(dataBudget ?? value);
      dataBudget ??= {
        ...value,
        expires: Math.min(value.expires, performance.now() + settings.statementTimeoutMs),
      };
      let begun = false;
      let commitStarted = false;
      let ended = false;
      try {
        await connections.query(
          connection,
          reading ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE' : 'BEGIN',
          undefined,
          dataBudget,
        );
        begun = true;
        const sqlBudget = Math.min(settings.statementTimeoutMs, remaining(dataBudget));
        await connections.query(
          connection,
          `SET LOCAL statement_timeout=${sqlBudget}; SET LOCAL lock_timeout=${Math.min(settings.lockTimeoutMs, sqlBudget)}; SET LOCAL synchronous_commit=on; SET LOCAL client_min_messages=warning`,
          undefined,
          dataBudget,
        );
        if (reading)
          await connections.query(
            connection,
            'LOCK TABLE ONLY telemetry.telemetry_events, ONLY telemetry.trace_spans IN ACCESS SHARE MODE',
            undefined,
            dataBudget,
          );
        const result = await work(connection, dataBudget);
        await verify(connection, dataBudget);
        if (remaining(value) <= settings.responseReserveMs)
          throw new StoreError('storage_unavailable');
        commitStarted = true;
        await connections.commit(connection, value);
        ended = true;
        return result;
      } catch (error) {
        if (begun && !commitStarted && !connection.broken) {
          try {
            await connections.query(connection, 'ROLLBACK', undefined, value);
            ended = true;
          } catch {
            connections.discard(connection);
          }
        }
        const code = error instanceof Error && 'code' in error ? String(error.code) : '';
        if (attempt === 0 && ended && (code === '40P01' || code === '40001')) {
          remaining(dataBudget);
          continue;
        }
        if (error instanceof StoreError) throw error;
        throw new StoreError('storage_unavailable', commitStarted ? 'unknown' : 'not_committed');
      } finally {
        if (begun && !ended) connections.discard(connection);
        connections.release(connection);
      }
    }
  }

  async function appendBatch(
    batch: CanonicalBatch,
    operation: OperationOptions,
  ): Promise<WriteReceipt> {
    if (options.role !== 'collector') throw new StoreError('forbidden');
    const { scope: current, events } = batch;
    if (
      !current.projectId ||
      !current.environment ||
      !current.service ||
      !current.policyVersion ||
      !events.length ||
      events.length > 20
    )
      throw new StoreError('invalid_request');
    positiveInteger(current.retentionDays, 'retentionDays', 3660);
    positiveInteger(current.receiptDays, 'receiptDays', 3660);
    const ids = new Set<string>();
    for (let index = 0; index < events.length; index++) {
      const event = events[index];
      if (ids.has(event.payload.id) || !/^[a-f0-9]{64}$/.test(event.digest))
        throw new StoreError('invalid_request', 'not_committed', [
          { index, id: event.payload.id, reason: 'invalid_identity' },
        ]);
      ids.add(event.payload.id);
    }
    return transaction(operation, false, async (connection, value) => {
      await scope(
        connection,
        value,
        current.projectId,
        current.environment,
        [current.service],
        ['event', 'error'],
      );
      const operationId = randomUUID();
      const nonce = randomUUID();
      await connections.query(
        connection,
        `WITH t AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS now), incoming AS (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text,kind text,digest text))
 INSERT INTO telemetry.ingest_receipts AS r
 (project_id,environment,service,source,event_id,kind,payload_digest,first_received_at,retain_until,tombstone_until,first_operation_id,confirmation_nonce,policy_version)
 SELECT $2,$3,$4,$5,x.id,x.kind,x.digest,t.now,t.now+($6::integer*interval '1 day'),t.now+(($6::integer+$7::integer)*interval '1 day'),$8::uuid,$9::uuid,$10
 FROM incoming x CROSS JOIN t ORDER BY x.id
 ON CONFLICT DO NOTHING`,
        [
          JSON.stringify(
            events.map((event) => ({
              id: event.payload.id,
              kind: event.payload.kind,
              digest: event.digest,
            })),
          ),
          current.projectId,
          current.environment,
          current.service,
          current.source,
          current.retentionDays,
          current.receiptDays,
          operationId,
          nonce,
          current.policyVersion,
        ],
        value,
      );
      const inserted = await connections.query(
        connection,
        `WITH locked AS (
 SELECT project_id,environment,service,source,event_id FROM telemetry.ingest_receipts
 WHERE project_id=$1 AND environment=$2 AND service=$3 AND source=$4 AND event_id=ANY($5::text[]) ORDER BY event_id FOR UPDATE)
 UPDATE telemetry.ingest_receipts r SET confirmation_nonce=$6::uuid FROM locked l
 WHERE r.project_id=$1 AND r.environment=$2 AND r.service=$3 AND r.source=$4 AND r.event_id=ANY($5::text[])
 AND r.project_id=l.project_id AND r.environment=l.environment AND r.service=l.service AND r.source=l.source AND r.event_id=l.event_id
 RETURNING r.event_id,r.kind,r.payload_digest,r.first_received_at,r.retain_until,r.first_operation_id`,
        [current.projectId, current.environment, current.service, current.source, [...ids], nonce],
        value,
      );
      const receiptById = new Map(inserted.rows.map((row) => [row.event_id as string, row]));
      const now = await connections.query(
        connection,
        'SELECT clock_timestamp() AS now',
        undefined,
        value,
      );
      const asOf = new Date(now.rows[0].now).getTime();
      const conflicts = events.flatMap((event, index) => {
        const row = receiptById.get(event.payload.id);
        if (!row) throw new StoreError('storage_unavailable');
        return row.payload_digest !== event.digest || row.kind !== event.payload.kind
          ? [{ index, id: event.payload.id, reason: 'payload_mismatch' }]
          : [];
      });
      if (conflicts.length) throw new StoreError('event_conflict', 'not_committed', conflicts);
      const expired = events.flatMap((event, index) =>
        new Date(receiptById.get(event.payload.id)!.retain_until).getTime() <= asOf
          ? [{ index, id: event.payload.id, reason: 'retention_expired' }]
          : [],
      );
      if (expired.length) throw new StoreError('event_expired', 'not_committed', expired);
      const fresh = events.filter(
        (event) => receiptById.get(event.payload.id)!.first_operation_id === operationId,
      );
      if (fresh.length) {
        await connections.query(
          connection,
          `INSERT INTO telemetry.telemetry_events
 (project_id,environment,service,source,received_at,event_id,kind,occurred_at,release,build_id,name,properties,context,error,fingerprint,truncated,sample_rate,policy_version,retain_until)
 SELECT r.project_id,r.environment,r.service,r.source,r.first_received_at,r.event_id,r.kind,x.occurred_at,$6,$7,x.name,x.properties,x.context,x.error,x.fingerprint,x.truncated,x.sample_rate,r.policy_version,r.retain_until
 FROM jsonb_to_recordset($1::jsonb) AS x(id text,occurred_at timestamptz,name text,properties jsonb,context jsonb,error jsonb,fingerprint text,truncated boolean,sample_rate double precision)
 JOIN telemetry.ingest_receipts r ON r.project_id=$2 AND r.environment=$3 AND r.service=$4 AND r.source=$5 AND r.event_id=x.id
 WHERE r.first_operation_id=$8::uuid AND r.event_id=ANY($9::text[]) ORDER BY x.id`,
          [
            JSON.stringify(
              fresh.map((event) => ({
                ...event.payload,
                ...(event.fingerprint ? { fingerprint: event.fingerprint } : {}),
              })),
            ),
            current.projectId,
            current.environment,
            current.service,
            current.source,
            current.release,
            current.buildId,
            operationId,
            fresh.map((event) => event.payload.id),
          ],
          value,
        );
      }
      const existing = await connections.query(
        connection,
        `SELECT r.event_id FROM telemetry.ingest_receipts r
 WHERE r.project_id=$1 AND r.environment=$2 AND r.service=$3 AND r.source=$4 AND r.event_id=ANY($5::text[])
 AND NOT EXISTS (SELECT 1 FROM telemetry.telemetry_events e WHERE e.event_id=ANY($5::text[]) AND e.project_id=r.project_id AND e.environment=r.environment AND e.service=r.service AND e.source=r.source AND e.event_id=r.event_id AND e.received_at=r.first_received_at AND e.kind=r.kind)`,
        [current.projectId, current.environment, current.service, current.source, [...ids]],
        value,
      );
      if (existing.rowCount) throw new StoreError('storage_integrity_error');
      const acknowledged: Acknowledgement[] = events.map((event) => {
        const row = receiptById.get(event.payload.id)!;
        return {
          id: event.payload.id,
          status: row.first_operation_id === operationId ? 'stored' : 'already_present',
          received_at: new Date(row.first_received_at).toISOString(),
          retain_until: new Date(row.retain_until).toISOString(),
        };
      });
      return { acknowledged };
    });
  }

  async function audited<T>(
    access: QueryAccess | TraceQueryAccess,
    operation: OperationOptions,
    work: (
      connection: Connection,
      value: Budget,
      asOf: string,
    ) => Promise<{ result: T; count: number }>,
  ): Promise<T> {
    if (options.role !== 'query') throw new StoreError('forbidden');
    validateAccess(access);
    return transaction(operation, true, async (connection, value) => {
      await scope(
        connection,
        value,
        access.projectId,
        access.environment,
        access.allowedServices,
        'allowedKinds' in access ? access.allowedKinds : ['span'],
      );
      const clock = await connections.query(
        connection,
        'SELECT clock_timestamp() AS now',
        undefined,
        value,
      );
      const asOf = new Date(clock.rows[0].now).toISOString();
      const { result, count } = await work(connection, value, asOf);
      try {
        if (!('allowedKinds' in access)) {
          await connections.query(
            connection,
            `INSERT INTO telemetry.trace_query_audit(audit_id,project_id,environment,actor_key_id,request_id,query_kind,query_digest,services_digest,as_of,row_count,created_at,retain_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,clock_timestamp(),clock_timestamp()+($11::integer*interval '1 day'))`,
            [
              randomUUID(),
              access.projectId,
              access.environment,
              access.actorKeyId,
              access.requestId,
              access.queryKind,
              access.queryDigest,
              createHash('sha256')
                .update(JSON.stringify([...new Set(access.allowedServices)].sort()))
                .digest('hex'),
              asOf,
              count,
              access.auditRetentionDays,
            ],
            value,
          );
        } else {
          await connections.query(
            connection,
            `INSERT INTO telemetry.query_audit
 (audit_id,project_id,environment,actor_key_id,request_id,query_kind,query_digest,services_digest,allowed_kinds,as_of,row_count,created_at,retain_until)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::text[],$10,$11,clock_timestamp(),clock_timestamp()+($12::integer*interval '1 day'))`,
            [
              randomUUID(),
              access.projectId,
              access.environment,
              access.actorKeyId,
              access.requestId,
              access.queryKind,
              access.queryDigest,
              createHash('sha256')
                .update(JSON.stringify([...new Set(access.allowedServices)].sort()))
                .digest('hex'),
              access.allowedKinds,
              asOf,
              count,
              access.auditRetentionDays,
            ],
            value,
          );
        }
      } catch (error) {
        if (error instanceof StoreError && error.outcome === 'unknown') throw error;
        throw new StoreError('audit_unavailable');
      }
      return result;
    });
  }

  async function find(
    query: EventQuery,
    access: QueryAccess,
    operation: OperationOptions,
    errors: boolean,
  ): Promise<EventPage> {
    if (
      errors &&
      (access.queryKind !== 'errors' ||
        access.allowedKinds.length !== 1 ||
        access.allowedKinds[0] !== 'error')
    )
      throw new StoreError('forbidden');
    if (!errors && access.queryKind !== 'events') throw new StoreError('forbidden');
    if (
      !Number.isInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > 500 ||
      !Number.isFinite(Date.parse(query.from)) ||
      !Number.isFinite(Date.parse(query.to)) ||
      Date.parse(query.to) <= Date.parse(query.from) ||
      Date.parse(query.to) - Date.parse(query.from) > 7 * 86400000
    )
      throw new StoreError('invalid_request');
    return audited(access, operation, async (connection, value, asOf) => {
      const values: unknown[] = [
        access.projectId,
        access.environment,
        access.allowedServices,
        access.allowedKinds,
        query.from,
        query.to,
        asOf,
      ];
      const conditions = [
        'project_id=$1',
        'environment=$2',
        'service=ANY($3::text[])',
        'kind=ANY($4::text[])',
        'received_at>=$5::timestamptz',
        'received_at<$6::timestamptz',
        'retain_until>$7::timestamptz',
      ];
      const filters = {
        service: 'service',
        source: 'source',
        name: 'name',
        release: 'release',
        request_id: "context->>'request_id'",
        trace_id: "context->>'trace_id'",
        span_id: "context->>'span_id'",
        user_id: "context->>'user_id'",
        code: "error->>'code'",
        fingerprint: 'fingerprint',
      };
      for (const key of Object.keys(filters) as (keyof typeof filters)[]) {
        if (query[key] !== undefined) {
          values.push(query[key]);
          conditions.push(`${filters[key]}=$${values.length}`);
        }
      }
      if (query.after) {
        values.push(
          query.after.received_at,
          query.after.service,
          query.after.source,
          query.after.id,
        );
        const n = values.length;
        conditions.push(
          `(received_at,service,source,event_id)<($${n - 3}::timestamptz,$${n - 2}::text,$${n - 1}::text,$${n}::text)`,
        );
      }
      values.push(query.limit + 1);
      const rows = await connections.query(
        connection,
        `SELECT ${projection} FROM telemetry.telemetry_events WHERE ${conditions.join(' AND ')} ORDER BY received_at DESC,service DESC,source DESC,event_id DESC LIMIT $${values.length}`,
        values,
        value,
      );
      const more = rows.rows.length > query.limit;
      const items = rows.rows.slice(0, query.limit).map(eventFromRow);
      const last = items.at(-1);
      return {
        result: {
          items,
          next_cursor:
            more && last
              ? JSON.stringify({
                  received_at: last.received_at,
                  service: last.service,
                  source: last.source,
                  id: last.id,
                })
              : null,
          query_id: randomUUID(),
          consistency: 'primary_committed',
          range: { from: query.from, to: query.to },
          pagination: 'live-pagination',
        } as EventPage,
        count: items.length,
      };
    });
  }

  async function getEvent(
    key: EventKey,
    access: QueryAccess,
    operation: OperationOptions,
  ): Promise<EventLookup> {
    if (access.queryKind !== 'event' && access.queryKind !== 'error')
      throw new StoreError('forbidden');
    return audited<EventLookup>(access, operation, async (connection, value, asOf) => {
      if (key.environment !== access.environment || !access.allowedServices.includes(key.service))
        return { result: { status: 'absent' }, count: 0 };
      const identity = [
        access.projectId,
        access.environment,
        key.service,
        key.source,
        key.id,
        access.allowedKinds,
      ];
      const receipt = await connections.query(
        connection,
        `SELECT first_received_at,retain_until,kind FROM telemetry.ingest_receipts
 WHERE project_id=$1 AND environment=$2 AND service=$3 AND source=$4 AND event_id=$5 AND kind=ANY($6::text[])`,
        identity,
        value,
      );
      if (!receipt.rows[0]) return { result: { status: 'absent' }, count: 0 };
      if (new Date(receipt.rows[0].retain_until).getTime() <= Date.parse(asOf))
        return { result: { status: 'expired' }, count: 0 };
      const event = await connections.query(
        connection,
        `SELECT ${projection} FROM telemetry.telemetry_events
 WHERE project_id=$1 AND environment=$2 AND service=$3 AND source=$4 AND event_id=$5 AND kind=ANY($6::text[])
 AND received_at=$7::timestamptz AND retain_until>$8::timestamptz`,
        [...identity, receipt.rows[0].first_received_at, asOf],
        value,
      );
      if (event.rowCount !== 1 || event.rows[0].kind !== receipt.rows[0].kind)
        throw new StoreError('storage_integrity_error');
      return { result: { status: 'found', event: eventFromRow(event.rows[0]) }, count: 1 };
    });
  }

  return {
    capabilities: {
      driver: 'postgresql',
      contractVersion: 2,
      durability: options.profile === 'ha' ? 'fault_domain_sync' : 'single_node',
      idempotency: 'strict_receipt',
      readConsistency: 'primary_committed',
      auditedReadBarrier: true,
    },
    traces: createTraceStore({
      role: options.role,
      transaction,
      scope,
      query: connections.query,
      audited,
    }),
    writer: { appendBatch },
    reader: {
      findEvents: (query, access, operation) => find(query, access, operation, false),
      findErrors: (query, access, operation) => find(query, access, operation, true),
      getEvent,
    },
    readiness: async (operation) => {
      try {
        const value = budget(operation);
        await connections.prepare(value);
        const connection = await connections.acquire(value);
        try {
          await connections.query(connection, 'BEGIN', undefined, value);
          await connections.query(
            connection,
            'SET LOCAL synchronous_commit=on; SET LOCAL client_min_messages=warning',
            undefined,
            value,
          );
          const schema = await connections.query(
            connection,
            `SELECT version,
 (SELECT count(*)=3 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid=ANY(ARRAY['telemetry.span_receipts'::regclass,'telemetry.trace_spans'::regclass,'telemetry.trace_query_audit'::regclass]))
 AND (SELECT p.prosecdef AND p.proowner='telemetry_owner'::regrole AND p.proconfig @> ARRAY['search_path=pg_catalog']::text[] AND NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') FROM pg_proc p WHERE p.oid='telemetry.confirm_span_receipts(jsonb,uuid)'::regprocedure)
 AND CASE WHEN $1='collector' THEN has_table_privilege(current_user,'telemetry.trace_spans','SELECT,INSERT') AND has_table_privilege(current_user,'telemetry.span_receipts','SELECT,INSERT') AND has_function_privilege(current_user,'telemetry.confirm_span_receipts(jsonb,uuid)','EXECUTE') AND NOT has_column_privilege(current_user,'telemetry.span_receipts','payload_digest','UPDATE')
 ELSE has_table_privilege(current_user,'telemetry.trace_spans','SELECT') AND has_table_privilege(current_user,'telemetry.span_receipts','SELECT') AND has_table_privilege(current_user,'telemetry.trace_query_audit','INSERT') END AS trace_ready,
 to_regclass('telemetry.events_'||to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYYMMDD')) IS NOT NULL AND to_regclass('telemetry.spans_'||to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYYMMDD')) IS NOT NULL AS partition_ready,
 (SELECT count(*)=3 AND bool_and(relrowsecurity AND relforcerowsecurity) FROM pg_class WHERE oid=ANY(ARRAY['telemetry.ingest_receipts'::regclass,'telemetry.telemetry_events'::regclass,'telemetry.query_audit'::regclass])) AS policies_ready,
 CASE WHEN $1='collector' THEN has_table_privilege(current_user,'telemetry.telemetry_events','SELECT,INSERT') AND has_table_privilege(current_user,'telemetry.ingest_receipts','SELECT,INSERT') AND has_column_privilege(current_user,'telemetry.ingest_receipts','confirmation_nonce','UPDATE')
 ELSE has_table_privilege(current_user,'telemetry.telemetry_events','SELECT') AND has_table_privilege(current_user,'telemetry.ingest_receipts','SELECT') AND has_table_privilege(current_user,'telemetry.query_audit','INSERT') END AS privileges_ready
 FROM telemetry.schema_version WHERE version=2`,
            [options.role],
            value,
          );
          if (
            schema.rowCount !== 1 ||
            !schema.rows[0].partition_ready ||
            !schema.rows[0].policies_ready ||
            !schema.rows[0].privileges_ready ||
            !schema.rows[0].trace_ready
          )
            throw new StoreError('storage_unavailable');
          await verify(connection, value);
          await connections.query(connection, 'ROLLBACK', undefined, value);
        } catch (error) {
          connections.discard(connection);
          throw error;
        } finally {
          connections.release(connection);
        }
        return { ready: true };
      } catch (error) {
        return {
          ready: false,
          reason: error instanceof StoreError ? error.code : 'storage_unavailable',
        };
      }
    },
    close: (operation) => connections.close(operation),
  };
}
