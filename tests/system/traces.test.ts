import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Client } from 'pg';
import {
  createCollector,
  createQueryApi,
  createConfigManager,
} from '../../packages/application/src/index.js';
import {
  createPostgresStore,
  migrate,
  maintain,
} from '../../packages/storage-postgres/src/index.js';
import {
  createTracer,
  extractTraceContext,
  injectTraceContext,
} from '../../packages/sdk/src/tracing/server.js';
import { createServerClient } from '../../packages/sdk/src/server.js';
import { runCli } from '../../packages/cli/src/index.js';
import { createTestConfiguration } from '../support/config.js';
import type { SpanPage, StoredSpan } from '../../packages/protocol/src/traces/types.js';
const database = process.env.TELEMETRY_TEST_DATABASE_URL;
if (!database) throw new Error('Use bun run test:integration');
const operation = () => ({ signal: new AbortController().signal, deadlineAtMs: Date.now() + 5000 });
const golden = readFileSync('tests/support/trace/golden.json');
const binary = readFileSync('tests/support/trace/golden.bin');
function requestBody(traceId = randomUUID().replaceAll('-', '')) {
  const body = JSON.parse(golden.toString());
  body.resourceSpans[0].scopeSpans[0].spans[0].traceId = traceId;
  return body;
}
describe('trace HTTP SDK PostgreSQL API CLI closed loop', () => {
  const fixture = createTestConfiguration();
  const config = fixture.configuration;
  const project = config.projects[0];
  project.service_accounts[0].permissions.push('write:traces');
  project.service_accounts[1].permissions.push('read:traces');
  project.trace_policy.span_names = ['checkout', 'parent', 'child'];
  project.trace_policy.scope_names = ['manual', 'oneaster.manual'];
  project.trace_policy.scope_versions = ['1'];
  project.trace_policy.span = {
    count: { type: 'int', min: '-9223372036854775808', max: '9223372036854775807' },
    safe: { type: 'string', max_bytes: 4096 },
    large_double: { type: 'double', finite: true },
  };
  config.limits.traces.max_concurrent = 4;
  const manager = createConfigManager(config);
  const writer = createPostgresStore({
    connectionString: database!,
    profile: 'development',
    role: 'collector',
    instanceId: 'trace-write',
    nodeId: 'local',
  });
  const reader = createPostgresStore({
    connectionString: database!,
    profile: 'development',
    role: 'query',
    instanceId: 'trace-read',
    nodeId: 'local',
  });
  const collector = createCollector({ store: writer, config: manager }),
    query = createQueryApi({
      store: reader,
      config: manager,
      cursorKeys: [{ id: 'key', secret: fixture.cursorSecret }],
    });
  const admin = new Client({ connectionString: database });
  let ingest: string, api: string;
  beforeAll(async () => {
    await admin.connect();
    await migrate(database!);
    ingest = await collector.listen({ host: '127.0.0.1', port: 0 });
    api = await query.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await Promise.all([collector.close(), query.close()]);
    await Promise.all([writer.close(operation()), reader.close(operation()), admin.end()]);
  });
  const headers = {
    authorization: `Bearer ${fixture.writeToken}`,
    'X-OneAster-Environment': 'test',
    'content-type': 'application/json',
  };
  const send = (body: object) =>
    fetch(`${ingest}/v1/traces`, { method: 'POST', headers, body: JSON.stringify(body) });
  async function page(path = '/v1/spans?environment=test') {
    const response = await fetch(`${api}${path}`, {
      headers: { authorization: `Bearer ${fixture.readToken}` },
    });
    return { status: response.status, body: (await response.json()) as SpanPage };
  }
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'accepts official binary=%s gzip=%s and preserves independent precision expectations',
    async (isBinary, gzip) => {
      const payload = isBinary ? binary : golden;
      const response = await fetch(`${ingest}/v1/traces`, {
        method: 'POST',
        headers: {
          ...headers,
          'content-type': isBinary ? 'application/x-protobuf' : 'application/json',
          ...(gzip ? { 'content-encoding': 'gzip' } : {}),
        },
        body: gzip ? gzipSync(payload) : payload,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const raw = await response.arrayBuffer();
      expect(isBinary ? [...new Uint8Array(raw)] : JSON.parse(Buffer.from(raw).toString())).toEqual(
        isBinary ? [] : {},
      );
      const result = await page('/v1/traces/4bf92f3577b34da6a3ce929d0e0e4736?environment=test');
      expect(result.status).toBe(200);
      expect(result.body.items).toHaveLength(1);
      expect(result.body.items[0]).toMatchObject({
        duration_ns: '123456789',
        flags: 257,
        end_time_unix_nano: '1793491200123456789',
        attributes: [{ key: 'count', value: { type: 'int', value: '-9223372036854775808' } }],
      });
    },
  );
  it('regression: finite double values outside the safe integer range survive projection and digest', async () => {
    const body = requestBody();
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    span.attributes = [{ key: 'large_double', value: { doubleValue: 1e20 } }];
    const response = await send(body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    const result = await page(`/v1/traces/${span.traceId}?environment=test`);
    expect(result.body.items[0].attributes).toEqual([
      { key: 'large_double', value: { type: 'double', value: 1e20 } },
    ]);
  });
  it('round-trips uint64 nanosecond and uint32 flag extremes through PostgreSQL numeric columns', async () => {
    const body = JSON.parse(readFileSync('tests/support/trace/values.json', 'utf8'));
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    span.traceId = randomUUID().replaceAll('-', '');
    span.flags = 4294967295;
    span.kind = -2147483648;
    const response = await send(body);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    const row = (
      await admin.query(
        'SELECT start_ns,end_ns,duration_ns,flags,kind FROM telemetry.trace_spans WHERE project_id=$1 AND trace_id=$2',
        [fixture.projectId, span.traceId],
      )
    ).rows[0];
    expect(row).toEqual({
      start_ns: '1',
      end_ns: '18446744073709551615',
      duration_ns: '18446744073709551614',
      flags: '4294967295',
      kind: -2147483648,
    });
    const result = await page(
      `/v1/traces/${span.traceId}?environment=test&to=${new Date(Date.now() + 1000).toISOString()}`,
    );
    expect(result.body.items[0]).toMatchObject({
      start_time_unix_nano: '1',
      end_time_unix_nano: '18446744073709551615',
      duration_ns: '18446744073709551614',
      flags: 4294967295,
      kind: -2147483648,
    });
  });
  it('authenticates legal empty exports and encodes early errors as OTLP Status', async () => {
    for (const [type, body] of [
      ['application/json', '{}'],
      ['application/x-protobuf', new Uint8Array()],
    ] as const) {
      const response = await fetch(`${ingest}/v1/traces`, {
        method: 'POST',
        headers: { ...headers, 'content-type': type },
        body,
      });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const denied = await fetch(`${ingest}/v1/traces`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body: binary,
    });
    expect(denied.status).toBe(401);
    expect([...new Uint8Array(await denied.arrayBuffer())].slice(0, 2)).toEqual([8, 16]);
    for (const extra of [
      { Origin: 'https://bad.example' },
      { Cookie: 'session=secret' },
      { 'X-OneAster-Environment': 'other' },
    ] as Record<string, string>[]) {
      const response = await fetch(`${ingest}/v1/traces`, {
        method: 'POST',
        headers: { ...headers, ...extra },
        body: '{}',
      });
      expect(response.status).toBe(403);
      await response.arrayBuffer();
    }
    const unsupported = await fetch(`${ingest}/v1/traces`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(unsupported.status).toBe(415);
    expect((await unsupported.json()).code).toBe(12);
  });
  it('enforces all-resource authorization before any write and keeps missing service errors per-span', async () => {
    const body = requestBody();
    const bad = structuredClone(body.resourceSpans[0]);
    bad.resource.attributes[0].value.stringValue = 'unauthorized';
    body.resourceSpans.push(bad);
    const response = await send(body);
    expect(response.status).toBe(403);
    await response.arrayBuffer();
    expect(
      (
        await page(
          `/v1/traces/${body.resourceSpans[0].scopeSpans[0].spans[0].traceId}?environment=test`,
        )
      ).status,
    ).toBe(404);
    const missing = requestBody();
    missing.resourceSpans[0].resource.attributes = [];
    const result = await send(missing);
    expect(result.status).toBe(200);
    expect((await result.json()).partialSuccess.rejectedSpans).toBe('1');
  });
  it('deduplicates concurrent retries, rejects every conflicting occurrence and preserves first retention', async () => {
    const body = requestBody(),
      span = body.resourceSpans[0].scopeSpans[0].spans[0];
    const responses = await Promise.all([send(body), send(body)]);
    for (const response of responses) {
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    const before = (await page(`/v1/traces/${span.traceId}?environment=test`)).body.items[0];
    const replay = await send(body);
    expect(replay.status).toBe(200);
    await replay.arrayBuffer();
    const after = (await page(`/v1/traces/${span.traceId}?environment=test`)).body.items[0];
    expect(after).toEqual(before);
    const conflict = requestBody();
    const spans = conflict.resourceSpans[0].scopeSpans[0].spans;
    spans.push({ ...spans[0], name: 'different' });
    const response = await send(conflict);
    expect(response.status).toBe(200);
    expect((await response.json()).partialSuccess.rejectedSpans).toBe('2');
    expect((await page(`/v1/traces/${spans[0].traceId}?environment=test`)).status).toBe(404);
  });
  it('keeps raw payload identity conflicts even when privacy projection removes both sensitive values', async () => {
    const body = requestBody();
    const span = body.resourceSpans[0].scopeSpans[0].spans[0];
    span.attributes = [{ key: 'private', value: { stringValue: 'private-first-marker' } }];
    const first = await send(body);
    expect(first.status).toBe(200);
    expect((await first.json()).partialSuccess.rejectedSpans).toBe('0');
    span.attributes[0].value.stringValue = 'private-second-marker';
    const second = await send(body);
    expect(second.status).toBe(200);
    const response = await second.json();
    expect(response.partialSuccess.rejectedSpans).toBe('1');
    expect(JSON.stringify(response)).not.toContain('private-');
    const result = await page(
      `/v1/traces/${span.traceId}?environment=test&to=${new Date(Date.now() + 1000).toISOString()}`,
    );
    expect(result.body.items[0].attributes).toEqual([]);
    expect(JSON.stringify(result.body)).not.toContain('private-');
    const metrics = await fetch(`${ingest}/metrics`);
    const text = await metrics.text();
    expect(text).toContain('telemetry_traces_rejected_total');
    expect(text).not.toContain(span.traceId);
    expect(text).not.toContain('private-');
  });
  it('stores good spans in a partial batch without treating invalid or expired spans as temporary failures', async () => {
    const body = requestBody(),
      spans = body.resourceSpans[0].scopeSpans[0].spans;
    spans.push({ ...spans[0], spanId: '1111111111111111', name: '' });
    const response = await send(body);
    expect(response.status).toBe(200);
    expect((await response.json()).partialSuccess.rejectedSpans).toBe('1');
    expect((await page(`/v1/traces/${spans[0].traceId}?environment=test`)).body.items).toHaveLength(
      1,
    );
    await admin.query(
      "UPDATE telemetry.span_receipts SET retain_until=clock_timestamp()-interval '1 second',first_received_at=clock_timestamp()-interval '2 day' WHERE project_id=$1 AND trace_id=$2",
      [fixture.projectId, spans[0].traceId],
    );
    const expired = await send({
      ...body,
      resourceSpans: [
        {
          ...body.resourceSpans[0],
          scopeSpans: [{ ...body.resourceSpans[0].scopeSpans[0], spans: [spans[0]] }],
        },
      ],
    });
    expect((await expired.json()).partialSuccess.rejectedSpans).toBe('1');
  });
  it('closes the SDK propagation and explicit event association path through audited API and CLI', async () => {
    const common = {
      endpoints: [ingest],
      environment: 'test',
      service: 'web',
      writeToken: fixture.writeToken,
      sampleRate: 1,
    };
    const artifact = (await import(
      pathToFileURL(resolve('dist/telemetry-sdk/tracing/server.js')).href
    )) as { createTracer: typeof createTracer };
    const first = artifact.createTracer(common),
      second = createTracer({ ...common, service: 'api' });
    let trace = '',
      parentId = '',
      childId = '';
    try {
      await first.withSpan({ name: 'parent' }, async (parent) => {
        trace = parent.context.traceId;
        parentId = parent.context.spanId;
        const remote = extractTraceContext(injectTraceContext(parent.context));
        await second.withSpan({ name: 'child', parent: remote }, async (child) => {
          expect(child.context.traceId).toBe(parent.context.traceId);
          childId = child.context.spanId;
          const events = createServerClient({
            endpoints: [`${ingest}/v1/ingest/server`],
            environment: 'test',
            service: 'api',
            release: '1',
            buildId: '1',
            writeToken: fixture.writeToken,
            events: { smoke_event: { action: { type: 'string' } } },
          });
          try {
            events.track(
              'smoke_event',
              { action: 'linked' },
              { traceId: child.context.traceId, spanId: child.context.spanId },
            );
            expect((await events.flush({ timeoutMs: 3000 })).acknowledgedIds).toHaveLength(1);
          } finally {
            await events.close({ timeoutMs: 10 });
          }
        });
      });
      expect((await first.flush()).confirmedSpans).toBe(1);
      expect((await second.flush()).confirmedSpans).toBe(1);
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
    expect(
      (
        await admin.query(
          'SELECT span_id FROM telemetry.trace_spans WHERE project_id=$1 AND trace_id=$2',
          [fixture.projectId, trace],
        )
      ).rowCount,
    ).toBe(2);
    const result = await page(
      `/v1/traces/${trace}?environment=test&to=${new Date(Date.now() + 1000).toISOString()}`,
    );
    expect(result.status).toBe(200);
    expect(result.body.items).toHaveLength(2);
    expect(result.body.items.find((s) => s.service === 'api')?.parent_span_id).toBe(parentId);
    const events = await fetch(
      `${api}/v1/events?environment=test&trace_id=${trace}&span_id=${childId}&to=${new Date(Date.now() + 1000).toISOString()}`,
      { headers: { authorization: `Bearer ${fixture.readToken}` } },
    );
    expect(events.status).toBe(200);
    expect((await events.json()).items).toHaveLength(1);
    expect((result.body as unknown as { completeness: string }).completeness).toBe('unknown');
    let output = '',
      errors = '';
    const status = await runCli(
      [
        'traces',
        'get',
        '--id',
        trace,
        '--environment',
        'test',
        '--to',
        new Date(Date.now() + 1000).toISOString(),
        '--format',
        'ndjson',
        '--limit',
        '1',
      ],
      {
        env: { TELEMETRY_TOKEN: fixture.readToken, TELEMETRY_ENDPOINTS: api },
        stdout: (s) => {
          output += s;
        },
        stderr: (s) => {
          errors += s;
        },
      },
    );
    expect(status).toBe(0);
    expect(
      output
        .trim()
        .split('\n')
        .map((s) => (JSON.parse(s) as StoredSpan).span_id)
        .sort(),
    ).toEqual(result.body.items.map((s) => s.span_id).sort());
    expect(errors).toContain('"complete":true');
  });
  it('binds cursor to filters and authorization and commits audit even for empty trace conclusions', async () => {
    const first = await page('/v1/spans?environment=test&limit=1');
    expect(first.body.next_cursor).toBeTypeOf('string');
    const cursor = encodeURIComponent(first.body.next_cursor!);
    expect((await page(`/v1/spans?environment=test&limit=2&cursor=${cursor}`)).status).toBe(400);
    const id = 'f'.repeat(32);
    expect((await page(`/v1/traces/${id}?environment=test`)).status).toBe(404);
    const audited = await admin.query(
      "SELECT row_count FROM telemetry.trace_query_audit WHERE project_id=$1 AND query_kind='trace' ORDER BY created_at DESC LIMIT 1",
      [fixture.projectId],
    );
    expect(audited.rows[0].row_count).toBe(0);
  });
  it('regression: corrupt derived payload lengths fail in the driver before an audit commits', async () => {
    const body = requestBody();
    const trace = body.resourceSpans[0].scopeSpans[0].spans[0].traceId;
    const response = await send(body);
    await response.arrayBuffer();
    expect(response.status).toBe(200);
    await admin.query(
      'UPDATE telemetry.trace_spans SET safe_payload_bytes=safe_payload_bytes-1 WHERE project_id=$1 AND trace_id=$2',
      [fixture.projectId, trace],
    );
    const access = {
      projectId: fixture.projectId,
      environment: 'test',
      allowedServices: ['web'],

      actorKeyId: 'reader',
      requestId: randomUUID(),
      queryKind: 'trace' as const,
      queryDigest: 'corrupt-size',
      auditRetentionDays: 90,
    };
    try {
      await expect(
        reader.traces.findSpans(
          {
            trace_id: trace,
            from: new Date(Date.now() - 86400000).toISOString(),
            to: new Date(Date.now() + 1000).toISOString(),
            limit: 10,
            pageBytes: 4194304,
          },
          access,
          operation(),
        ),
      ).rejects.toMatchObject({ code: 'storage_integrity_error' });
      expect(
        (
          await admin.query('SELECT 1 FROM telemetry.trace_query_audit WHERE request_id=$1', [
            access.requestId,
          ])
        ).rowCount,
      ).toBe(0);
    } finally {
      await admin.query(
        'UPDATE telemetry.trace_spans SET safe_payload_bytes=safe_payload_bytes+1 WHERE project_id=$1 AND trace_id=$2',
        [fixture.projectId, trace],
      );
    }
  });
  it('retries a lost durable trace response without duplicating spans or rerunning privacy projection', async () => {
    let calls = 0;
    const sdk = createTracer({
      endpoints: [ingest],
      environment: 'test',
      service: 'web',
      writeToken: fixture.writeToken,
      sampleRate: 1,
      limits: { retryBaseMs: 1 },
      transport: async (input, init) => {
        const response = await fetch(input, init);
        if (++calls === 1) {
          await response.arrayBuffer();
          throw new Error('Lost durable response');
        }
        return response;
      },
    });
    const span = sdk.startSpan({ name: 'checkout' });
    span.end();
    try {
      expect((await sdk.flush()).confirmedSpans).toBe(1);
      expect(calls).toBe(2);
      expect(
        (await page(`/v1/traces/${span.context.traceId}?environment=test`)).body.items,
      ).toHaveLength(1);
    } finally {
      await sdk.close();
    }
  });
  it('keeps event-only accounts out of trace routes and invalidates cursors after permission changes', async () => {
    const current = structuredClone(manager.current().value);
    const updated = structuredClone(current);
    updated.revision++;
    updated.projects[0].service_accounts[1].permissions = ['read:events'];
    manager.update(updated);
    expect((await page('/v1/spans?environment=test')).status).toBe(403);
    const restored = structuredClone(current);
    restored.revision = updated.revision + 1;
    manager.update(restored);
    const first = await page('/v1/spans?environment=test&limit=1');
    const next = structuredClone(manager.current().value);
    next.revision++;
    next.projects[0].service_accounts[1].services = ['api'];
    manager.update(next);
    try {
      expect(
        (
          await page(
            `/v1/spans?environment=test&limit=1&cursor=${encodeURIComponent(first.body.next_cursor!)}`,
          )
        ).status,
      ).toBe(400);
    } finally {
      const restore = structuredClone(current);
      restore.revision = next.revision + 1;
      manager.update(restore);
    }
  });
  it('runs an explicit schema version compatibility window without deleting confirmed data', async () => {
    const before = await admin.query(
      'SELECT count(*) AS count FROM telemetry.trace_spans WHERE project_id=$1',
      [fixture.projectId],
    );
    await admin.query(
      'ALTER TABLE telemetry.schema_version DROP CONSTRAINT schema_version_version_check; ALTER TABLE telemetry.schema_version ADD CONSTRAINT schema_version_version_check CHECK(version IN (1,2)); INSERT INTO telemetry.schema_version VALUES (1)',
    );
    await migrate(database!, { finalize: false });
    expect(
      (await admin.query('SELECT version FROM telemetry.schema_version ORDER BY version')).rows,
    ).toEqual([{ version: 1 }, { version: 2 }]);
    await migrate(database!, { rollbackEvents: true });
    expect(
      (await admin.query('SELECT version FROM telemetry.schema_version ORDER BY version')).rows,
    ).toEqual([{ version: 1 }, { version: 2 }]);
    await migrate(database!);
    expect((await admin.query('SELECT version FROM telemetry.schema_version')).rows).toEqual([
      { version: 2 },
    ]);
    expect(
      (
        await admin.query(
          'SELECT count(*) AS count FROM telemetry.trace_spans WHERE project_id=$1',
          [fixture.projectId],
        )
      ).rows,
    ).toEqual(before.rows);
  });
  it('returns no trace payload when the synchronous query audit cannot be committed', async () => {
    await admin.query(
      "CREATE FUNCTION telemetry.trace_test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit unavailable'; END $$",
    );
    await admin.query(
      'CREATE TRIGGER trace_test_audit_failure BEFORE INSERT ON telemetry.trace_query_audit FOR EACH ROW EXECUTE FUNCTION telemetry.trace_test_audit_failure()',
    );
    try {
      const response = await fetch(
        `${api}/v1/traces/4bf92f3577b34da6a3ce929d0e0e4736?environment=test`,
        { headers: { authorization: `Bearer ${fixture.readToken}` } },
      );
      expect(response.status).toBe(503);
      const text = await response.text();
      expect(text).not.toContain('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(JSON.parse(text).error.code).toBe('audit_unavailable');
    } finally {
      await admin.query('DROP TRIGGER trace_test_audit_failure ON telemetry.trace_query_audit');
      await admin.query('DROP FUNCTION telemetry.trace_test_audit_failure()');
    }
  });
  it('fails readiness when trace RLS is disabled and recovers after restoration', async () => {
    await admin.query('ALTER TABLE telemetry.span_receipts DISABLE ROW LEVEL SECURITY');
    try {
      expect((await writer.readiness(operation())).ready).toBe(false);
    } finally {
      await admin.query('ALTER TABLE telemetry.span_receipts ENABLE ROW LEVEL SECURITY');
    }
    expect((await writer.readiness(operation())).ready).toBe(true);
  });
  it('rejects malformed JSON, compressed output bombs, and batches above the span budget before writing', async () => {
    const bad = await fetch(`${ingest}/v1/traces`, {
      method: 'POST',
      headers,
      body: '{"resourceSpans":[],"resourceSpans":[]}',
    });
    expect(bad.status).toBe(400);
    await bad.arrayBuffer();
    const bomb = await fetch(`${ingest}/v1/traces`, {
      method: 'POST',
      headers: { ...headers, 'content-encoding': 'gzip' },
      body: gzipSync(Buffer.alloc(config.limits.traces.body_bytes + 1, 32)),
    });
    expect(bomb.status).toBe(413);
    await bomb.arrayBuffer();
    const body = requestBody(),
      base = body.resourceSpans[0].scopeSpans[0].spans[0];
    body.resourceSpans[0].scopeSpans[0].spans = Array.from({ length: 513 }, (_, i) => ({
      ...base,
      spanId: (i + 1).toString(16).padStart(16, '0'),
    }));
    const over = await send(body);
    expect(over.status).toBe(413);
    await over.arrayBuffer();
    expect((await page(`/v1/traces/${base.traceId}?environment=test`)).status).toBe(404);
  });
  it('continues across byte-limited short pages without skipping a large span', async () => {
    const updated = structuredClone(manager.current().value);
    updated.revision++;
    updated.projects[0].trace_policy.span = {};
    for (let n = 0; n < 32; n++)
      updated.projects[0].trace_policy.span[`large${n}`] = { type: 'string', max_bytes: 4096 };
    manager.update(updated);
    const body = requestBody();
    const trace = body.resourceSpans[0].scopeSpans[0].spans[0].traceId;
    const base = body.resourceSpans[0].scopeSpans[0].spans[0];
    base.attributes = Array.from({ length: 32 }, (_, n) => ({
      key: `large${n}`,
      value: { stringValue: 'x'.repeat(4096) },
    }));
    for (let start = 0; start < 64; start += 8) {
      body.resourceSpans[0].scopeSpans[0].spans = Array.from({ length: 8 }, (_, n) => ({
        ...base,
        spanId: (start + n + 1).toString(16).padStart(16, '0'),
      }));
      const response = await send(body);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
    }
    let output = '';
    const status = await runCli(
      ['traces', 'get', '--id', trace, '--environment', 'test', '--format', 'ndjson'],
      {
        env: { TELEMETRY_TOKEN: fixture.readToken, TELEMETRY_ENDPOINTS: api },
        stdout: (s) => {
          output += s;
        },
        stderr: () => undefined,
      },
    );
    expect(status).toBe(0);
    const rows = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as StoredSpan);
    expect(rows).toHaveLength(64);
    expect(new Set(rows.map((r) => r.span_id)).size).toBe(64);
    expect(rows.every((r) => r.attributes.length === 32)).toBe(true);
  });
  it('maintains trace partitions and hides expired payloads before physical cleanup', async () => {
    const body = requestBody();
    const trace = body.resourceSpans[0].scopeSpans[0].spans[0].traceId;
    const response = await send(body);
    expect(response.status).toBe(200);
    await response.arrayBuffer();
    await admin.query(
      "UPDATE telemetry.trace_spans SET received_at=received_at,retain_until=received_at+interval '1 millisecond' WHERE project_id=$1 AND trace_id=$2",
      [fixture.projectId, trace],
    );
    expect(
      (
        await page(
          `/v1/traces/${trace}?environment=test&to=${new Date(Date.now() + 1000).toISOString()}`,
        )
      ).status,
    ).toBe(404);
    await maintain(database!);
    expect(
      (
        await page(
          `/v1/traces/${trace}?environment=test&to=${new Date(Date.now() + 1000).toISOString()}`,
        )
      ).status,
    ).toBe(404);
    expect((await writer.readiness(operation())).ready).toBe(true);
  });
});
