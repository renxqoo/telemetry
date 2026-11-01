import { runProbe } from '../../ops/probe.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCollector,
  createConfigManager,
  createQueryApi,
} from '../../packages/application/src/index.js';
import { createPostgresStore, migrate } from '../../packages/storage-postgres/src/index.js';
import { createServerClient } from '../../packages/sdk/src/server.js';
import { runCli } from '../../packages/cli/src/index.js';
import { createTestConfiguration } from '../support/config.js';
import type { Envelope, EventPage, IngestResponse } from '../../packages/protocol/src/types.js';
const database = process.env.TELEMETRY_TEST_DATABASE_URL;
if (!database) throw new Error('Run this test using bun run test:integration');
describe('SDK HTTP PostgreSQL query CLI pipeline', () => {
  const fixture = createTestConfiguration();
  const config = createConfigManager(fixture.configuration);
  const collectorStore = createPostgresStore({
    connectionString: database,
    profile: 'development',
    role: 'collector',
    instanceId: 'pipeline-write',
    nodeId: 'local',
  });
  const queryStore = createPostgresStore({
    connectionString: database,
    profile: 'development',
    role: 'query',
    instanceId: 'pipeline-read',
    nodeId: 'local',
  });
  const collector = createCollector({ store: collectorStore, config });
  const query = createQueryApi({
    store: queryStore,
    config,
    cursorKeys: [{ id: 'test', secret: fixture.cursorSecret }],
  });
  let collectorUrl: string, queryUrl: string;
  beforeAll(async () => {
    await migrate(database);
    collectorUrl = await collector.listen({ host: '127.0.0.1', port: 0 });
    queryUrl = await query.listen({ host: '127.0.0.1', port: 0 });
  });
  afterAll(async () => {
    await Promise.all([collector.close(), query.close()]);
    const options = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 3000 };
    await Promise.all([collectorStore.close(options), queryStore.close(options)]);
  });
  const requestId = `pipeline-${randomUUID()}`;
  it('persists only filter-approved and sampled-in SDK events through the real HTTP and PostgreSQL pipeline', async () => {
    const correlation = `filter-${randomUUID()}`;
    const common = {
      endpoints: [`${collectorUrl}/v1/ingest/server`],
      writeToken: fixture.writeToken,
      projectId: fixture.projectId,
      environment: 'test',
      service: 'api',
      release: 'pipeline-v1',
      buildId: 'pipeline-build',
      events: { smoke_event: { action: { type: 'string' as const } } },
    };
    const filtered = createServerClient({
      ...common,
      eventFilter: (event) =>
        event.properties.action !== 'noise' && event.error?.type !== 'TypeError',
    });
    const sampled = createServerClient({ ...common, sampleRate: { event: 0, error: 1 } });
    const accepted: string[] = [];
    try {
      expect(
        filtered.track('smoke_event', { action: 'noise' }, { requestId: correlation }),
      ).toBeNull();
      expect(
        filtered.captureError(new TypeError('private-noise'), { requestId: correlation }),
      ).toBeNull();
      expect(
        sampled.track('smoke_event', { action: 'disabled' }, { requestId: correlation }),
      ).toBeNull();
      const eventId = filtered.track(
        'smoke_event',
        { action: 'accepted' },
        { requestId: correlation },
      );
      const errorId = filtered.captureError(new Error('private-accepted'), {
        requestId: correlation,
      });
      const sampledErrorId = sampled.captureError(new Error('private-sampled'), {
        requestId: correlation,
      });
      expect([eventId, errorId, sampledErrorId].every((id) => typeof id === 'string')).toBe(true);
      accepted.push(eventId!, errorId!, sampledErrorId!);
      const results = await Promise.all([
        filtered.flush({ timeoutMs: 3000 }),
        sampled.flush({ timeoutMs: 3000 }),
      ]);
      expect(results.flatMap((result) => result.acknowledgedIds).sort()).toEqual(
        [...accepted].sort(),
      );
      expect(results.every((result) => result.pendingIds.length === 0 && !result.timedOut)).toBe(
        true,
      );
      expect(filtered.getDiagnostics().dropped).toEqual({ filtered: 2 });
      expect(sampled.getDiagnostics().dropped).toEqual({ sampled: 1 });
    } finally {
      await Promise.all([filtered.close({ timeoutMs: 0 }), sampled.close({ timeoutMs: 0 })]);
    }
    const response = await fetch(
      `${queryUrl}/v1/events?environment=test&request_id=${correlation}`,
      {
        headers: { authorization: `Bearer ${fixture.readToken}` },
      },
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as EventPage;
    expect(result.items.map((item) => item.id).sort()).toEqual([...accepted].sort());
    expect(
      result.items.filter((item) => item.kind === 'event').map((item) => item.properties.action),
    ).toEqual(['accepted']);
    expect(
      result.items.filter((item) => item.kind === 'error').map((item) => item.error?.type),
    ).toEqual(['Error', 'Error']);
    expect(JSON.stringify(result)).not.toContain('private-');
  });
  it('regression: a modified Error must not persist its original private message as frames', async () => {
    const sdk = createServerClient({
      endpoints: [`${collectorUrl}/v1/ingest/server`],
      writeToken: fixture.writeToken,
      projectId: fixture.projectId,
      environment: 'test',
      service: 'api',
      release: 'pipeline-v1',
      buildId: 'pipeline-build',
    });
    try {
      const error = new Error(
        'private\n    at PRIVATE_MESSAGE (/customer/PRIVATE_ACCOUNT.txt:123:4)',
      );
      void error.stack;
      error.message = 'Changed message';
      const id = sdk.captureError(error);
      expect((await sdk.flush({ timeoutMs: 3000 })).acknowledgedIds).toEqual([id]);
      const response = await fetch(
        `${queryUrl}/v1/errors/server/${id}?environment=test&service=api`,
        { headers: { authorization: `Bearer ${fixture.readToken}` } },
      );
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain('PRIVATE_MESSAGE');
      expect(body).not.toContain('PRIVATE_ACCOUNT');
      expect(JSON.parse(body)).toMatchObject({ id, error: { frames: [] } });
    } finally {
      await sdk.close({ timeoutMs: 0 });
    }
  });
  it('persists the original sanitized server error and CLI retrieves it by request ID', async () => {
    const sdk = createServerClient({
      endpoints: [`${collectorUrl}/v1/ingest/server`],
      writeToken: fixture.writeToken,
      projectId: fixture.projectId,
      environment: 'test',
      service: 'api',
      release: 'pipeline-v1',
      buildId: 'pipeline-build',
      errorProperties: { operation: { type: 'string', enum: ['smoke'] } },
    });
    const id = sdk.captureError(new Error('secret-token-must-never-leave'), {
      requestId,
      operation: 'smoke',
      userId: 'opaque-user',
    });
    expect(id).toBeTypeOf('string');
    const flushed = await sdk.flush({ timeoutMs: 3000 });
    expect(flushed.acknowledgedIds).toContain(id);
    expect(flushed.pendingIds).toEqual([]);
    await sdk.close({ timeoutMs: 500 });
    let output = '';
    let errors = '';
    const status = await runCli(
      ['errors', 'list', '--environment', 'test', '--request_id', requestId],
      {
        env: { TELEMETRY_TOKEN: fixture.readToken, TELEMETRY_ENDPOINTS: queryUrl },
        stdout: (text) => {
          output += text;
        },
        stderr: (text) => {
          errors += text;
        },
      },
    );
    expect({ status, errors }).toEqual({ status: 0, errors: '' });
    const result = JSON.parse(output) as EventPage;
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      id,
      project_id: fixture.projectId,
      service: 'api',
      source: 'server',
      context: { request_id: requestId, user_id: 'opaque-user' },
    });
    expect(output).not.toContain('secret-token');
  });
  it('concurrent HTTP replays retain one immutable event and conflicting batches roll back', async () => {
    const id = randomUUID();
    const envelope: Envelope = {
      schema_version: '1',
      environment: 'test',
      service: 'api',
      release: 'pipeline-v1',
      build_id: 'pipeline-build',
      events: [
        {
          id,
          occurred_at: new Date().toISOString(),
          kind: 'event',
          name: 'smoke_event',
          properties: { action: 'concurrent' },
          context: { request_id: requestId },
        },
      ],
    };
    const send = (payload: Envelope) =>
      fetch(`${collectorUrl}/v1/ingest/server`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${fixture.writeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    const responses = await Promise.all([send(envelope), send(envelope)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const acknowledgements = await Promise.all(
      responses.map(
        async (response) => ((await response.json()) as IngestResponse).acknowledged[0],
      ),
    );
    expect(acknowledgements.map((item) => item.status).sort()).toEqual([
      'already_present',
      'stored',
    ]);
    expect(acknowledgements[0].received_at).toBe(acknowledgements[1].received_at);
    expect(acknowledgements[0].retain_until).toBe(acknowledgements[1].retain_until);
    const rejectedId = randomUUID();
    const conflict = structuredClone(envelope);
    conflict.events[0].properties.action = 'different';
    conflict.events.push({ ...envelope.events[0], id: rejectedId });
    expect((await send(conflict)).status).toBe(409);
    const response = await fetch(
      `${queryUrl}/v1/events?environment=test&name=smoke_event&request_id=${requestId}`,
      { headers: { authorization: `Bearer ${fixture.readToken}` } },
    );
    const result = (await response.json()) as EventPage;
    expect(response.status).toBe(200);
    expect(result.items.map((item) => item.id)).toEqual([id]);
    expect(result.items[0].properties.action).toBe('concurrent');
  });
  it('a lost durable response retries the original identity without extending retention', async () => {
    const receipts: IngestResponse[] = [];
    const sdk = createServerClient({
      endpoints: [`${collectorUrl}/v1/ingest/server`],
      writeToken: fixture.writeToken,
      projectId: fixture.projectId,
      environment: 'test',
      service: 'api',
      release: 'pipeline-v1',
      buildId: 'pipeline-build',
      events: { smoke_event: { action: { type: 'string' } } },
      limits: { retryBaseMs: 1, retryMaxMs: 10 },
      transport: async (input, init) => {
        const response = await fetch(input, init);
        receipts.push((await response.clone().json()) as IngestResponse);
        if (receipts.length === 1) {
          await response.body?.cancel();
          throw new TypeError('Simulated lost response after durable commit');
        }
        return response;
      },
    });
    try {
      const id = sdk.track('smoke_event', { action: 'lost-response' });
      const result = await sdk.flush({ timeoutMs: 3000 });
      expect(result.acknowledgedIds).toEqual([id]);
      expect(receipts).toHaveLength(2);
      expect(receipts[0].acknowledged[0].status).toBe('stored');
      expect(receipts[1].acknowledged[0]).toEqual({
        ...receipts[0].acknowledged[0],
        status: 'already_present',
      });
      const response = await fetch(
        `${queryUrl}/v1/events/server/${id}?environment=test&service=api`,
        { headers: { authorization: `Bearer ${fixture.readToken}` } },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id, properties: { action: 'lost-response' } });
    } finally {
      await sdk.close({ timeoutMs: 500 });
    }
  });
  it('an external probe confirms a real write and audited detail without depending on collector diagnostics', async () => {
    const result = await runProbe(
      {
        collector_endpoints: [collectorUrl],
        query_endpoints: [queryUrl],
        project_id: fixture.projectId,
        environment: 'test',
        service: 'api',
        release: 'probe-v1',
        build_id: 'probe-build',
        event_name: 'smoke_event',
      },
      { writeToken: fixture.writeToken, readToken: fixture.readToken },
    );
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeLessThan(5000);
  });
  it('exports real query pages to NDJSON with a durable completeness manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'telemetry-export-'));
    try {
      const path = join(directory, 'events.ndjson');
      let errors = '';
      const status = await runCli(
        [
          'export',
          '--environment',
          'test',
          '--request_id',
          requestId,
          '--from',
          new Date(Date.now() - 60000).toISOString(),
          '--to',
          new Date(Date.now() + 1000).toISOString(),
          '--limit',
          '1',
          '--out',
          path,
        ],
        {
          env: { TELEMETRY_TOKEN: fixture.readToken, TELEMETRY_ENDPOINTS: queryUrl },
          stdout: () => undefined,
          stderr: (text) => {
            errors += text;
          },
        },
      );
      expect({ status, errors }).toEqual({ status: 0, errors: '' });
      const records = (await readFile(path, 'utf8'))
        .trim()
        .split('\n')
        .map((text) => JSON.parse(text) as { id: string });
      const manifest = JSON.parse(await readFile(`${path}.manifest.json`, 'utf8'));
      expect(records).toHaveLength(2);
      expect(new Set(records.map((record) => record.id)).size).toBe(2);
      expect(manifest).toMatchObject({ count: 2, complete: true, pagination: 'live-pagination' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
