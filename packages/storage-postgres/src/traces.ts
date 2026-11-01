import { safeSpanBytes } from '../../protocol/src/traces/policy.js';
import { randomUUID } from 'node:crypto';
import type { Budget, Connection } from './connections.js';
import {
  StoreError,
  type CanonicalSpans,
  type OperationOptions,
  type SpanQuery,
  type TraceQueryAccess,
  type TraceStore,
} from '../../storage-contract/src/index.js';
import { traceBounds, type SpanPage, type StoredSpan } from '../../protocol/src/traces/types.js';
interface TraceRuntime {
  role: string;
  transaction<T>(
    this: void,
    operation: OperationOptions,
    reading: boolean,
    work: (connection: Connection, value: Budget) => Promise<T>,
  ): Promise<T>;
  scope(
    this: void,
    connection: Connection,
    value: Budget,
    project: string,
    environment: string,
    services: string[],
    kinds: string[],
  ): Promise<void>;
  query(
    this: void,
    connection: Connection,
    text: string,
    values: unknown[] | undefined,
    value: Budget,
  ): Promise<{ rows: Record<string, any>[]; rowCount: number | null }>;
  audited<T>(
    this: void,
    access: TraceQueryAccess,
    operation: OperationOptions,
    work: (
      connection: Connection,
      value: Budget,
      asOf: string,
    ) => Promise<{ result: T; count: number }>,
  ): Promise<T>;
}
export function createTraceStore(runtime: TraceRuntime): TraceStore {
  const { query, scope, transaction, audited } = runtime;
  return {
    async appendSpans(batch: CanonicalSpans, operation: OperationOptions) {
      if (runtime.role !== 'collector') throw new StoreError('forbidden');
      if (
        !batch.projectId ||
        !batch.environment ||
        !batch.policyVersion ||
        Buffer.byteLength(batch.projectId) > 128 ||
        Buffer.byteLength(batch.environment) > 32 ||
        Buffer.byteLength(batch.policyVersion) > 128 ||
        !batch.allowedServices.length ||
        batch.spans.length > traceBounds.maxSpans ||
        !Number.isInteger(batch.retentionDays) ||
        batch.retentionDays < 1 ||
        batch.retentionDays > 3660 ||
        !Number.isInteger(batch.receiptDays) ||
        batch.receiptDays < 1 ||
        batch.receiptDays > 3660
      )
        throw new StoreError('invalid_request');
      for (const item of batch.spans)
        if (
          !batch.allowedServices.includes(item.service) ||
          Buffer.byteLength(item.service) > 64 ||
          !/^[a-f0-9]{64}$/.test(item.digest)
        )
          throw new StoreError('forbidden');
      for (const item of batch.spans)
        if (safeSpanBytes(item.payload) > traceBounds.maxSafeSpanBytes)
          throw new StoreError('invalid_request');
      if (!batch.spans.length) return { rejectedSpans: 0 };
      return transaction(operation, false, async (connection, value) => {
        await scope(connection, value, batch.projectId, batch.environment, batch.allowedServices, [
          'span',
        ]);
        const operationId = randomUUID();
        const nonce = randomUUID();
        const groups = new Map<string, typeof batch.spans>();
        for (const span of batch.spans) {
          const key = `${span.payload.trace_id}:${span.payload.span_id}`;
          const items = groups.get(key) ?? [];
          items.push(span);
          groups.set(key, items);
        }
        const ordered = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
        let rejected = 0,
          duplicates = 0,
          conflicts = 0;
        const candidates = ordered.flatMap(([, items]) => {
          if (new Set(items.map((item) => item.digest)).size > 1) {
            rejected += items.length;
            conflicts += items.length;
            return [];
          }
          const item = items[0];
          return [
            {
              trace_id: item.payload.trace_id,
              span_id: item.payload.span_id,
              service: item.service,
              digest: item.digest,
            },
          ];
        });
        const input = JSON.stringify(candidates);
        await query(
          connection,
          `WITH t AS (SELECT date_trunc('milliseconds',clock_timestamp()) AS now)
 INSERT INTO telemetry.span_receipts(project_id,environment,trace_id,span_id,service,payload_digest,first_received_at,retain_until,tombstone_until,first_operation_id,confirmation_nonce,policy_version)
 SELECT $2,$3,x.trace_id,x.span_id,x.service,x.digest,t.now,t.now+($4::int*interval '1 day'),t.now+(($4::int+$5::int)*interval '1 day'),$6,$7,$8
 FROM jsonb_to_recordset($1::jsonb) AS x(trace_id text,span_id text,service text,digest text) CROSS JOIN t ORDER BY x.trace_id,x.span_id ON CONFLICT DO NOTHING`,
          [
            input,
            batch.projectId,
            batch.environment,
            batch.retentionDays,
            batch.receiptDays,
            operationId,
            nonce,
            batch.policyVersion,
          ],
          value,
        );
        const confirmation = await query(
          connection,
          'SELECT telemetry.confirm_span_receipts($1::jsonb,$2::uuid) AS touched_count',
          [input, nonce],
          value,
        );
        if (confirmation.rows[0].touched_count !== candidates.length)
          throw new StoreError('storage_integrity_error');
        const rows = await query(
          connection,
          `SELECT r.*,r.retain_until>clock_timestamp() AS alive FROM telemetry.span_receipts r JOIN jsonb_to_recordset($1::jsonb) AS x(trace_id text,span_id text) ON r.trace_id=x.trace_id AND r.span_id=x.span_id WHERE r.project_id=$2 AND r.environment=$3`,
          [input, batch.projectId, batch.environment],
          value,
        );
        const receipts = new Map(rows.rows.map((row) => [`${row.trace_id}:${row.span_id}`, row]));
        const accepted: typeof batch.spans = [];
        const fresh: typeof batch.spans = [];
        for (const candidate of candidates) {
          const key = `${candidate.trace_id}:${candidate.span_id}`,
            items = groups.get(key)!;
          const receipt = receipts.get(key);
          if (
            !receipt ||
            receipt.payload_digest !== candidate.digest ||
            receipt.service !== candidate.service ||
            !receipt.alive
          ) {
            rejected += items.length;
            if (
              !receipt ||
              receipt.payload_digest !== candidate.digest ||
              receipt.service !== candidate.service
            )
              conflicts += items.length;
            continue;
          }
          accepted.push(items[0]);
          if (receipt.first_operation_id === operationId) {
            fresh.push(items[0]);
            duplicates += items.length - 1;
          } else duplicates += items.length;
        }
        if (fresh.length)
          await query(
            connection,
            `INSERT INTO telemetry.trace_spans(project_id,environment,trace_id,span_id,service,received_at,retain_until,policy_version,name,parent_span_id,kind,flags,status_message,start_ns,end_ns,status_code,duration_ns,safe_payload,safe_payload_bytes)
 SELECT r.project_id,r.environment,r.trace_id,r.span_id,r.service,r.first_received_at,r.retain_until,r.policy_version,x.payload->>'name',x.payload->>'parent_span_id',(x.payload->>'kind')::int,(x.payload->>'flags')::bigint,x.payload->'status'->>'message',(x.payload->>'start_time_unix_nano')::numeric,(x.payload->>'end_time_unix_nano')::numeric,(x.payload->'status'->>'code')::int,(x.payload->>'duration_ns')::numeric,x.payload,x.bytes
 FROM jsonb_to_recordset($1::jsonb) AS x(trace_id text,span_id text,payload jsonb,bytes int) JOIN telemetry.span_receipts r ON r.trace_id=x.trace_id AND r.span_id=x.span_id WHERE r.project_id=$2 AND r.environment=$3 AND r.first_operation_id=$4 ORDER BY r.trace_id,r.span_id`,
            [
              JSON.stringify(
                fresh.map((item) => ({
                  trace_id: item.payload.trace_id,
                  span_id: item.payload.span_id,
                  payload: item.payload,
                  bytes: Buffer.byteLength(JSON.stringify(item.payload)),
                })),
              ),
              batch.projectId,
              batch.environment,
              operationId,
            ],
            value,
          );
        const missing = await query(
          connection,
          `SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS x(trace_id text,span_id text) JOIN telemetry.span_receipts r ON r.trace_id=x.trace_id AND r.span_id=x.span_id WHERE r.project_id=$2 AND r.environment=$3 AND NOT EXISTS(SELECT 1 FROM telemetry.trace_spans s WHERE s.project_id=r.project_id AND s.environment=r.environment AND s.trace_id=r.trace_id AND s.span_id=r.span_id AND s.service=r.service AND s.received_at=r.first_received_at)`,
          [
            JSON.stringify(
              accepted.map((item) => ({
                trace_id: item.payload.trace_id,
                span_id: item.payload.span_id,
              })),
            ),
            batch.projectId,
            batch.environment,
          ],
          value,
        );
        if (missing.rowCount) throw new StoreError('storage_integrity_error');
        return { rejectedSpans: rejected, duplicateSpans: duplicates, conflictSpans: conflicts };
      });
    },
    async findSpans(
      input: SpanQuery,
      access: TraceQueryAccess,
      operation: OperationOptions,
    ): Promise<SpanPage> {
      if (runtime.role !== 'query' || !['spans', 'trace'].includes(access.queryKind))
        throw new StoreError('forbidden');
      if (
        !Number.isFinite(Date.parse(input.from)) ||
        !Number.isFinite(Date.parse(input.to)) ||
        Date.parse(input.to) <= Date.parse(input.from) ||
        Date.parse(input.to) - Date.parse(input.from) > 7 * 86400000 ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 500 ||
        input.pageBytes < traceBounds.minPageBytes ||
        input.pageBytes > traceBounds.maxPageBytes
      )
        throw new StoreError('invalid_request');
      return audited(access, operation, async (connection, value, asOf) => {
        const values: unknown[] = [
          access.projectId,
          access.environment,
          access.allowedServices,
          input.from,
          input.to,
          asOf,
        ];
        const conditions = [
          'project_id=$1',
          'environment=$2',
          'service=ANY($3::text[])',
          'received_at>=$4::timestamptz',
          'received_at<$5::timestamptz',
          'retain_until>$6::timestamptz',
        ];
        for (const [key, column] of Object.entries({
          service: 'service',
          trace_id: 'trace_id',
          span_id: 'span_id',
          name: 'name',
          status_code: 'status_code',
          min_duration_ns: 'duration_ns >=',
          max_duration_ns: 'duration_ns <=',
        })) {
          const item = input[key as keyof SpanQuery];
          if (item === undefined) continue;
          values.push(item);
          conditions.push(`${column}${column.includes(' ') ? '' : '='}$${values.length}`);
        }
        if (input.after) {
          values.push(input.after.received_at, input.after.trace_id, input.after.span_id);
          const n = values.length;
          conditions.push(
            `(received_at,trace_id,span_id)<($${n - 2}::timestamptz,$${n - 1},$${n})`,
          );
        }
        values.push(input.limit + 1);
        const rows = await query(
          connection,
          `SELECT trace_id,span_id,received_at,safe_payload_bytes FROM telemetry.trace_spans WHERE ${conditions.join(' AND ')} ORDER BY received_at DESC,trace_id DESC,span_id DESC LIMIT $${values.length}`,
          values,
          value,
        );
        let used = traceBounds.metadataBytes;
        const items: StoredSpan[] = [];
        const selected = [];
        for (const row of rows.rows.slice(0, input.limit)) {
          if (row.safe_payload_bytes > traceBounds.maxSafeSpanBytes)
            throw new StoreError('storage_unavailable');
          const cost = Number(row.safe_payload_bytes) + traceBounds.metadataBytes;
          if (used + cost > input.pageBytes) break;
          selected.push(row);
          used += cost;
        }
        const bodies = selected.length
          ? await query(
              connection,
              `SELECT s.trace_id,s.span_id,s.safe_payload,s.project_id,s.environment,s.service,s.received_at,s.retain_until,s.policy_version FROM telemetry.trace_spans s JOIN jsonb_to_recordset($1::jsonb) AS x(trace_id text,span_id text,received_at timestamptz) ON s.trace_id=x.trace_id AND s.span_id=x.span_id AND s.received_at=x.received_at WHERE s.project_id=$2 AND s.environment=$3 ORDER BY s.received_at DESC,s.trace_id DESC,s.span_id DESC`,
              [JSON.stringify(selected), access.projectId, access.environment],
              value,
            )
          : { rows: [] };
        if (bodies.rows.length !== selected.length) throw new StoreError('storage_integrity_error');
        for (let index = 0; index < bodies.rows.length; index++) {
          const data = bodies.rows[index],
            row = selected[index];
          const actual = safeSpanBytes(data.safe_payload);
          const metadata = {
            project_id: data.project_id,
            environment: data.environment,
            service: data.service,
            received_at: new Date(data.received_at).toISOString(),
            retain_until: new Date(data.retain_until).toISOString(),
            policy_version: data.policy_version,
          };
          if (
            actual !== Number(row.safe_payload_bytes) ||
            actual > traceBounds.maxSafeSpanBytes ||
            Buffer.byteLength(JSON.stringify(metadata)) > traceBounds.metadataBytes ||
            data.safe_payload.trace_id !== row.trace_id ||
            data.safe_payload.span_id !== row.span_id
          )
            throw new StoreError('storage_integrity_error');
          items.push({
            ...data.safe_payload,
            project_id: data.project_id,
            environment: data.environment,
            service: data.service,
            received_at: new Date(data.received_at).toISOString(),
            retain_until: new Date(data.retain_until).toISOString(),
            policy_version: data.policy_version,
          } as StoredSpan);
        }
        if (rows.rows.length && !items.length) throw new StoreError('storage_unavailable');
        const last = items.at(-1);
        const more = rows.rows.length > items.length;
        const result: SpanPage = {
          items,
          next_cursor:
            more && last
              ? JSON.stringify({
                  received_at: last.received_at,
                  trace_id: last.trace_id,
                  span_id: last.span_id,
                })
              : null,
          query_id: randomUUID(),
          consistency: 'primary_committed',
          range: { from: input.from, to: input.to },
          pagination: 'live-pagination',
          scope: 'authorized_services',
        };
        return { result, count: items.length };
      });
    },
  };
}
