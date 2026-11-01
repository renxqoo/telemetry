import { readFileSync } from 'node:fs';
import { decodeTraces } from '../../protocol/src/traces/codec.js';
import { projectSpan } from '../../protocol/src/traces/policy.js';
import { emptyTracePolicy } from '../../protocol/src/traces/types.js';
import type { CanonicalSpans } from '../../storage-contract/src/index.js';
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, appendFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, createConnection, type Socket } from 'node:net';
import { Client } from 'pg';
import { createPostgresStore, migrate } from '../src/index.js';
import type { CanonicalBatch, TelemetryStore } from '../../storage-contract/src/index.js';
import { freePort, postgresBinaries } from '../../../tests/support/postgres.js';

const run = promisify(execFile);
const pgBin = await postgresBinaries();
const fixture = await mkdtemp(join(tmpdir(), 'telemetry-tls-pg18-'));
const ports: number[] = [];
if (process.env.TELEMETRY_PG_BASE_PORT) {
  const basePort = Number(process.env.TELEMETRY_PG_BASE_PORT);
  assert.ok(Number.isInteger(basePort) && basePort > 0 && basePort <= 65533);
  ports.push(basePort, basePort + 1, basePort + 2);
} else {
  while (ports.length < 3) {
    const port = await freePort();
    if (!ports.includes(port)) ports.push(port);
  }
}
const directories = ports.map((_, index) => join(fixture, `node${index}`));
const certificate = join(fixture, 'server.crt');
const privateKey = join(fixture, 'server.key');
const stopped = new Set<number>();
const clients = new Set<Client>();
const stores = new Set<TelemetryStore>();
const paused = new Set<number>();
const results: string[] = [];
const gates: { close(): Promise<void> }[] = [];
const operation = (ms = 5000) => ({
  signal: new AbortController().signal,
  deadlineAtMs: Date.now() + ms,
});
const url = (port: number, user = 'postgres', tls = true) =>
  `postgresql://${user}@localhost:${port}/postgres${tls ? `?sslmode=verify-full&sslrootcert=${encodeURIComponent(certificate)}` : ''}`;
async function database(port: number, user = 'postgres') {
  const client = new Client({ connectionString: url(port, user), connectionTimeoutMillis: 1000 });
  client.on('error', () => undefined);
  await client.connect();
  clients.add(client);
  return client;
}
async function closeClient(client: Client) {
  clients.delete(client);
  await client.end().catch(() => undefined);
}
async function dataGate(port: number) {
  const sockets = new Set<Socket>();
  const held = new Set<Socket>();
  const buffered = new Map<Socket, Buffer[]>();
  let holding = false;
  let blocked = false;
  function forward(client: Socket) {
    client.removeAllListeners('data');
    const upstream = createConnection({ host: 'localhost', port });
    sockets.add(upstream);
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.on('close', () => upstream.destroy());
    for (const chunk of buffered.get(client) ?? []) upstream.write(chunk);
    buffered.delete(client);
    client.pipe(upstream).pipe(client);
  }
  const server = createServer((client) => {
    sockets.add(client);
    client.on('error', () => undefined);
    client.on('close', () => {
      sockets.delete(client);
      held.delete(client);
      buffered.delete(client);
    });
    if (holding) {
      blocked = true;
      held.add(client);
      const chunks: Buffer[] = [];
      buffered.set(client, chunks);
      client.on('data', (chunk: Buffer) => chunks.push(chunk));
    } else forward(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let closing: Promise<void> | undefined;
  const gate = {
    port: address.port,
    hold() {
      holding = true;
    },
    blocked: () => blocked,
    active: () => sockets.size,
    release() {
      holding = false;
      for (const socket of held) if (!socket.destroyed) forward(socket);
      held.clear();
    },
    close() {
      closing ??= (async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      })();
      return closing;
    },
  };
  gates.push(gate);
  return gate;
}
async function sql(port: number, text: string, values?: unknown[]) {
  const client = await database(port);
  try {
    return await client.query(text, values);
  } finally {
    await closeClient(client);
  }
}
async function ctl(index: number, command: string, extra: string[] = []) {
  await run(join(pgBin!, 'pg_ctl'), ['-D', directories[index], command, ...extra], {
    timeout: 10000,
  });
}
async function waitFor(test: () => Promise<boolean>, label: string) {
  const until = Date.now() + 15000;
  while (Date.now() < until) {
    try {
      if (await test()) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timeout: ${label}`);
}
function config(role: 'collector' | 'query', instanceId: string) {
  return {
    connectionString: url(ports[0], `probe_${role}`),
    profile: 'ha' as const,
    role,
    instanceId,
    nodeId: 'fixture',
    requireTls: true,
    maxConnections: 4,
    maxCleanupConnections: 2,
    cleanupTimeoutMs: 300,
    poolWaitMs: 250,
    commitTimeoutMs: 200,
    physicalNodes: ports.map((port, index) => ({
      id: `node${index}`,
      connectionString: url(port, `probe_${role}`),
      cleanupConnectionString: url(port, 'probe_cleanup'),
    })),
  };
}
function driver(role: 'collector' | 'query', instanceId: string) {
  const value = createPostgresStore(config(role, instanceId));
  stores.add(value);
  return value;
}
function batch(): CanonicalBatch {
  return {
    scope: {
      projectId: 'tls-probe',
      environment: 'test',
      service: 'service',
      source: 'server',
      release: 'r1',
      buildId: 'b1',
      policyVersion: 'p1',
      retentionDays: 30,
      receiptDays: 7,
    },
    events: [
      {
        digest: 'a'.repeat(64),
        payload: {
          id: randomUUID(),
          occurred_at: '2026-01-01T00:00:00.000Z',
          kind: 'event',
          name: 'probe',
          properties: {},
        },
      },
    ],
  };
}
function spanBatch(): CanonicalSpans {
  const payload = projectSpan(
    decodeTraces(readFileSync('tests/support/trace/golden.json'), false).candidates[0].span,
    emptyTracePolicy,
  );
  payload.trace_id = randomUUID().replaceAll('-', '');
  payload.resource.attributes = [
    { key: 'service.name', value: { type: 'string', value: 'service' } },
  ];
  return {
    projectId: 'tls-probe',
    environment: 'test',
    allowedServices: ['service'],
    policyVersion: '1',
    retentionDays: 30,
    receiptDays: 7,
    spans: [{ service: 'service', payload, digest: 'a'.repeat(64) }],
  };
}
async function pass(name: string, work: () => Promise<void>) {
  await work();
  results.push(name);
  console.log(`PASS ${name}`);
}
try {
  await run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      privateKey,
      '-out',
      certificate,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ],
    { timeout: 10000 },
  );
  await chmod(privateKey, 0o600);
  await run(join(pgBin, 'initdb'), ['-D', directories[0], '-U', 'postgres', '-A', 'trust'], {
    timeout: 10000,
  });
  await appendFile(
    join(directories[0], 'postgresql.conf'),
    `\nlisten_addresses='127.0.0.1,::1'\nport=${ports[0]}\nunix_socket_directories='${fixture}'\nwal_level=replica\nmax_wal_senders=8\nmax_replication_slots=8\nhot_standby=on\nssl=on\nssl_cert_file='${certificate}'\nssl_key_file='${privateKey}'\n`,
  );
  await ctl(0, 'start', ['-l', join(fixture, 'node0.log')]);
  await migrate(url(ports[0]));
  await sql(
    ports[0],
    `CREATE ROLE probe_collector LOGIN CONNECTION LIMIT 4; GRANT telemetry_collector TO probe_collector;
 CREATE ROLE probe_query LOGIN CONNECTION LIMIT 4; GRANT telemetry_query TO probe_query;
 CREATE ROLE probe_cleanup LOGIN CONNECTION LIMIT 2; GRANT telemetry_cleanup TO probe_cleanup;`,
  );
  for (let index = 1; index < 3; index++) {
    await run(
      join(pgBin, 'pg_basebackup'),
      [
        '-h',
        '127.0.0.1',
        '-p',
        String(ports[0]),
        '-U',
        'postgres',
        '-D',
        directories[index],
        '-R',
        '-X',
        'stream',
        '--checkpoint=fast',
        '-C',
        '-S',
        `probe_slot_${index}`,
      ],
      { timeout: 15000 },
    );
    await appendFile(join(directories[index], 'postgresql.conf'), `\nport=${ports[index]}\n`);
    await appendFile(
      join(directories[index], 'postgresql.auto.conf'),
      `\nprimary_conninfo='host=127.0.0.1 port=${ports[0]} user=postgres application_name=node${index} sslmode=prefer'\n`,
    );
    await ctl(index, 'start', ['-l', join(fixture, `node${index}.log`)]);
  }
  await waitFor(
    async () =>
      Number(
        (await sql(ports[0], "SELECT count(*) FROM pg_stat_replication WHERE state='streaming'"))
          .rows[0].count,
      ) === 2,
    'two streaming standbys',
  );
  await sql(ports[0], "ALTER SYSTEM SET synchronous_standby_names='ANY 1 (node1,node2)'");
  await sql(ports[0], 'SELECT pg_reload_conf()');
  await waitFor(
    async () =>
      Number(
        (await sql(ports[0], "SELECT count(*) FROM pg_stat_replication WHERE sync_state='quorum'"))
          .rows[0].count,
      ) === 2,
    'synchronous replication',
  );
  const writer = driver('collector', 'tlswriter');
  const reader = driver('query', 'tlsreader');
  let original: CanonicalBatch;
  const originalSpan = spanBatch();
  await pass(
    'verified TLS and restricted roles safely write and audit against the discovered primary',
    async () => {
      assert.deepEqual(await writer.readiness(operation()), { ready: true });
      original = batch();
      assert.equal(
        (await writer.writer.appendBatch(original, operation())).acknowledged[0].status,
        'stored',
      );
      const key = {
        environment: 'test',
        service: 'service',
        source: 'server' as const,
        id: original.events[0].payload.id,
      };
      assert.equal(
        (
          await reader.reader.getEvent(
            key,
            {
              projectId: 'tls-probe',
              environment: 'test',
              allowedServices: ['service'],
              allowedKinds: ['event', 'error'],
              actorKeyId: 'probe',
              requestId: randomUUID(),
              queryKind: 'event',
              queryDigest: 'test',
              auditRetentionDays: 90,
            },
            operation(),
          )
        ).status,
        'found',
      );
    },
  );
  await pass(
    'startup reconciliation uses the readiness deadline without consuming the pool admission budget',
    async () => {
      const gate = await dataGate(ports[1]);
      gate.hold();
      const options = config('collector', 'startup-budget');
      options.poolWaitMs = 200;
      options.cleanupTimeoutMs = 1000;
      options.physicalNodes[1].cleanupConnectionString = url(gate.port, 'probe_cleanup').replace(
        'localhost',
        '127.0.0.1',
      );
      const starting = createPostgresStore(options);
      stores.add(starting);
      let release: ReturnType<typeof setTimeout> | undefined;
      try {
        const pending = starting.readiness(operation());
        await waitFor(() => Promise.resolve(gate.blocked()), 'held startup reconciliation');
        release = setTimeout(() => gate.release(), 350);
        assert.deepEqual(await pending, { ready: true });
      } finally {
        if (release) clearTimeout(release);
        await gate.close();
        await starting.close(operation(2000));
        stores.delete(starting);
      }
    },
  );
  await pass(
    'startup reconciles prior-generation sessions on every direct physical node',
    async () => {
      const residues: Client[] = [];
      for (let index = 0; index < 3; index++) {
        const client = new Client({
          connectionString: url(ports[index], 'probe_collector'),
          application_name: `telemetry:restart:previous:nonce${index}`,
        });
        client.on('error', () => undefined);
        await client.connect();
        clients.add(client);
        residues.push(client);
      }
      const restarted = driver('collector', 'restart');
      assert.equal((await restarted.readiness(operation())).ready, true);
      for (const port of ports)
        assert.equal(
          (
            await sql(
              port,
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name LIKE 'telemetry:restart:previous:%'",
            )
          ).rows[0].count,
          0,
        );
      for (const client of residues) await closeClient(client);
      await restarted.close(operation());
      stores.delete(restarted);
    },
  );
  await pass(
    'regression: concurrent HA writes do not fail while data connection capacity remains',
    async () => {
      await sql(
        ports[0],
        'CREATE ROLE probe_burst LOGIN CONNECTION LIMIT 4; GRANT telemetry_collector TO probe_burst',
      );
      const options = config('collector', 'burst');
      options.physicalNodes = options.physicalNodes.map((node, index) => ({
        ...node,
        connectionString: url(ports[index], 'probe_burst'),
      }));
      const burst = createPostgresStore({ ...options, poolWaitMs: 1000 });
      stores.add(burst);
      assert.equal((await burst.readiness(operation())).ready, true);
      const batches = Array.from({ length: 4 }, () => batch());
      const written = await Promise.allSettled(
        batches.map((value) => burst.writer.appendBatch(value, operation())),
      );
      assert.deepEqual(
        written.map((result) => result.status),
        ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
      );
      assert.equal(
        (
          await sql(
            ports[0],
            'SELECT count(*)::int AS count FROM telemetry.telemetry_events WHERE event_id=ANY($1::text[])',
            [batches.map((value) => value.events[0].payload.id)],
          )
        ).rows[0].count,
        4,
      );
      const counts = await sql(
        ports[0],
        "SELECT usename,count(*)::int AS count FROM pg_stat_activity WHERE usename IN ('probe_burst','probe_cleanup') GROUP BY usename",
      );
      for (const row of counts.rows)
        assert.ok(row.count <= (row.usename === 'probe_cleanup' ? 2 : 4));
      await burst.close(operation());
      stores.delete(burst);
    },
  );
  await pass(
    'regression: cancelling a primary-discovery waiter does not cancel another writer',
    async () => {
      await sql(
        ports[0],
        'CREATE ROLE probe_cancel LOGIN CONNECTION LIMIT 4; GRANT telemetry_collector TO probe_cancel',
      );
      const gate = await dataGate(ports[0]);
      const options = config('collector', 'cancel-probe');
      options.physicalNodes = options.physicalNodes.map((node, index) => ({
        ...node,
        connectionString: url(ports[index], 'probe_cancel'),
        cleanupConnectionString:
          index === 0
            ? url(gate.port, 'probe_cleanup').replace('localhost', '127.0.0.1')
            : node.cleanupConnectionString,
      }));
      const cancellable = createPostgresStore({
        ...options,
        poolWaitMs: 1000,
        lockTimeoutMs: 1000,
        statementTimeoutMs: 2000,
      });
      stores.add(cancellable);
      assert.equal((await cancellable.readiness(operation())).ready, true);
      const blocker = await database(ports[0]);
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE telemetry.ingest_receipts IN SHARE MODE');
      gate.hold();
      const controller = new AbortController();
      const batches = Array.from({ length: 3 }, () => batch());
      const pendingWrites = Promise.allSettled([
        cancellable.writer.appendBatch(batches[0], operation()),
        cancellable.writer.appendBatch(batches[1], { ...operation(), signal: controller.signal }),
        cancellable.writer.appendBatch(batches[2], operation()),
      ]);
      await waitFor(async () => gate.blocked(), 'shared discovery before waiter cancellation');
      controller.abort();
      gate.release();
      await blocker.query('ROLLBACK');
      const outcomes = await pendingWrites;
      assert.deepEqual(
        outcomes.map((value) => value.status),
        ['fulfilled', 'rejected', 'fulfilled'],
      );
      const persisted = await sql(
        ports[0],
        'SELECT event_id FROM telemetry.telemetry_events WHERE event_id=ANY($1::text[]) ORDER BY event_id',
        [batches.map((value) => value.events[0].payload.id)],
      );
      assert.deepEqual(
        persisted.rows.map((row) => row.event_id),
        [batches[0].events[0].payload.id, batches[2].events[0].payload.id].sort(),
      );
      await cancellable.close(operation());
      stores.delete(cancellable);
      await closeClient(blocker);
      await gate.close();
    },
  );
  await pass(
    'regression: closing during primary discovery rejects pending writers and releases every cleanup connection',
    async () => {
      await sql(
        ports[0],
        'CREATE ROLE probe_closing LOGIN CONNECTION LIMIT 4; GRANT telemetry_collector TO probe_closing',
      );
      const gate = await dataGate(ports[0]);
      const options = config('collector', 'closing-probe');
      options.physicalNodes = options.physicalNodes.map((node, index) => ({
        ...node,
        connectionString: url(ports[index], 'probe_closing'),
        cleanupConnectionString:
          index === 0
            ? url(gate.port, 'probe_cleanup').replace('localhost', '127.0.0.1')
            : node.cleanupConnectionString,
      }));
      const closing = createPostgresStore({
        ...options,
        poolWaitMs: 1000,
        lockTimeoutMs: 1000,
        statementTimeoutMs: 2000,
      });
      stores.add(closing);
      assert.equal((await closing.readiness(operation())).ready, true);
      const blocker = await database(ports[0]);
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE telemetry.ingest_receipts IN SHARE MODE');
      gate.hold();
      const writes = Promise.allSettled([
        closing.writer.appendBatch(batch(), operation()),
        closing.writer.appendBatch(batch(), operation()),
      ]);
      await waitFor(async () => gate.blocked(), 'discovery before store shutdown');
      await blocker.query('ROLLBACK');
      await closing.close(operation(3000));
      const results = await writes;
      assert.equal(results[1].status, 'rejected');
      assert.equal(
        (
          await sql(
            ports[0],
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE starts_with(application_name,'telemetry:closing-probe:')",
          )
        ).rows[0].count,
        0,
      );
      assert.equal(gate.active(), 0);
      await assert.rejects(closing.writer.appendBatch(batch(), operation()));
      stores.delete(closing);
      await closeClient(blocker);
      await gate.close();
    },
  );
  await pass(
    'regression: shutdown reclaims identified predecessor sessions even when startup reconciliation is interrupted',
    async () => {
      const orphan = new Client({
        connectionString: url(ports[0], 'probe_closing'),
        application_name: 'telemetry:startup-close:previous:nonce',
      });
      orphan.on('error', () => undefined);
      await orphan.connect();
      clients.add(orphan);
      const gate = await dataGate(ports[1]);
      const options = config('collector', 'startup-close');
      options.physicalNodes[1].cleanupConnectionString = url(gate.port, 'probe_cleanup').replace(
        'localhost',
        '127.0.0.1',
      );
      const interrupted = createPostgresStore({ ...options, poolWaitMs: 1000 });
      stores.add(interrupted);
      gate.hold();
      const ready = interrupted.readiness(operation());
      await waitFor(async () => gate.blocked(), 'startup after predecessor discovery');
      await interrupted.close(operation(3000));
      assert.equal((await ready).ready, false);
      assert.equal(
        (
          await sql(
            ports[0],
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE application_name='telemetry:startup-close:previous:nonce'",
          )
        ).rows[0].count,
        0,
      );
      assert.equal(gate.active(), 0);
      stores.delete(interrupted);
      await closeClient(orphan);
      await gate.close();
    },
  );
  await pass(
    'a mismatched cleanup node is rejected without signaling another physical node',
    async () => {
      const options = config('collector', 'badtarget');
      options.physicalNodes[0].cleanupConnectionString = url(ports[1], 'probe_cleanup');
      const invalid = createPostgresStore(options);
      stores.add(invalid);
      assert.equal((await invalid.readiness(operation())).ready, false);
      await invalid.close(operation());
      stores.delete(invalid);
    },
  );
  await pass('trace writes and audited queries use the protected synchronous barrier', async () => {
    assert.equal((await writer.traces.appendSpans(originalSpan, operation())).rejectedSpans, 0);
    assert.equal((await writer.traces.appendSpans(originalSpan, operation())).rejectedSpans, 0);
    const result = await reader.traces.findSpans(
      {
        from: new Date(Date.now() - 86400000).toISOString(),
        to: new Date(Date.now() + 1000).toISOString(),
        limit: 10,
        pageBytes: 4194304,
        trace_id: originalSpan.spans[0].payload.trace_id,
      },
      {
        projectId: 'tls-probe',
        environment: 'test',
        allowedServices: ['service'],

        actorKeyId: 'probe',
        requestId: randomUUID(),
        queryKind: 'trace',
        queryDigest: 'trace-probe',
        auditRetentionDays: 90,
      },
      operation(),
    );
    assert.equal(result.items.length, 1);
  });
  await pass(
    'synchronous COMMIT deadlines remain unknown and actual backend counts stay bounded',
    async () => {
      for (const port of ports.slice(1)) {
        const result = await sql(port, 'SELECT pid FROM pg_stat_wal_receiver');
        const pid = Number(result.rows[0].pid);
        process.kill(pid, 'SIGSTOP');
        paused.add(pid);
      }
      const started = Date.now();
      await assert.rejects(writer.writer.appendBatch(batch(), operation()), (error: unknown) =>
        Boolean(
          error && typeof error === 'object' && 'outcome' in error && error.outcome === 'unknown',
        ),
      );
      assert.ok(Date.now() - started < 1000);
      const hidden = structuredClone(originalSpan);
      hidden.allowedServices = ['hidden'];
      hidden.spans[0].service = 'hidden';
      hidden.spans[0].digest = 'b'.repeat(64);
      for (const candidate of [spanBatch(), originalSpan, hidden])
        await assert.rejects(writer.traces.appendSpans(candidate, operation()), (error: unknown) =>
          Boolean(
            error && typeof error === 'object' && 'outcome' in error && error.outcome === 'unknown',
          ),
        );
      await assert.rejects(
        reader.traces.findSpans(
          {
            from: new Date(Date.now() - 86400000).toISOString(),
            to: new Date(Date.now() + 1000).toISOString(),
            limit: 10,
            pageBytes: 4194304,
          },
          {
            projectId: 'tls-probe',
            environment: 'test',
            allowedServices: ['service'],

            actorKeyId: 'probe',
            requestId: randomUUID(),
            queryKind: 'spans',
            queryDigest: 'trace-unknown',
            auditRetentionDays: 90,
          },
          operation(),
        ),
        (error: unknown) =>
          Boolean(
            error && typeof error === 'object' && 'outcome' in error && error.outcome === 'unknown',
          ),
      );

      await waitFor(
        async () =>
          Number(
            (
              await sql(
                ports[0],
                "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'telemetry:tlswriter:%' AND application_name NOT LIKE '%:cleanup:%'",
              )
            ).rows[0].count,
          ) === 0,
        'expired data backend cleanup',
      );
      for (const port of ports) {
        const counts = await sql(
          port,
          "SELECT usename,count(*)::int AS count FROM pg_stat_activity WHERE usename IN ('probe_collector','probe_cleanup') GROUP BY usename",
        );
        for (const row of counts.rows)
          assert.ok(row.count <= (row.usename === 'probe_cleanup' ? 2 : 4));
      }
      for (const pid of paused) process.kill(pid, 'SIGCONT');
      paused.clear();
      await waitFor(
        async () =>
          Number(
            (
              await sql(
                ports[0],
                "SELECT count(*) FROM pg_stat_replication WHERE sync_state='quorum'",
              )
            ).rows[0].count,
          ) === 2,
        'resumed replication',
      );
      assert.equal(
        (await writer.writer.appendBatch(original!, operation())).acknowledged[0].status,
        'already_present',
      );
    },
  );
  await pass(
    'regression: an unidentified failed connection retains old-node debt without blocking the healthy promoted node',
    async () => {
      await sql(ports[0], 'CHECKPOINT');
      const lsn = (await sql(ports[0], 'SELECT pg_current_wal_flush_lsn() AS lsn')).rows[0].lsn;
      for (const port of ports.slice(1))
        await waitFor(
          async () =>
            (await sql(port, 'SELECT pg_last_wal_replay_lsn()>=$1::pg_lsn AS caught', [lsn]))
              .rows[0].caught,
          'standby caught up',
        );
      await sql(
        ports[0],
        'CREATE ROLE probe_fault LOGIN CONNECTION LIMIT 4; GRANT telemetry_collector TO probe_fault',
      );
      const roleLsn = (await sql(ports[0], 'SELECT pg_current_wal_flush_lsn() AS lsn')).rows[0].lsn;
      for (const port of ports.slice(1))
        await waitFor(
          async () =>
            (await sql(port, 'SELECT pg_last_wal_replay_lsn()>=$1::pg_lsn AS caught', [roleLsn]))
              .rows[0].caught,
          'fault role replicated',
        );
      const gate = await dataGate(ports[0]);
      const options = config('collector', 'node-fault');
      options.physicalNodes = options.physicalNodes.map((node, index) => ({
        ...node,
        connectionString:
          index === 0
            ? url(gate.port, 'probe_fault').replace('localhost', '127.0.0.1')
            : url(ports[index], 'probe_fault'),
      }));
      const incidents: { code: string; pending: number }[] = [];
      const recovering = createPostgresStore({
        ...options,
        poolWaitMs: 1000,
        onIncident: (value) => incidents.push(value),
      });
      stores.add(recovering);
      assert.equal((await recovering.readiness(operation())).ready, true);
      const blocker = await database(ports[0]);
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE telemetry.ingest_receipts IN SHARE MODE');
      gate.hold();
      const interrupted = Promise.allSettled([
        recovering.writer.appendBatch(batch(), operation()),
        recovering.writer.appendBatch(batch(), operation()),
      ]);
      await waitFor(async () => gate.blocked(), 'connection blocked before backend identity');
      await ctl(0, 'stop', ['-m', 'immediate']);
      stopped.add(0);
      await gate.close();
      const failures = await interrupted;
      assert.deepEqual(
        failures.map((result) => result.status),
        ['rejected', 'rejected'],
      );
      await ctl(1, 'promote');
      await waitFor(
        async () =>
          !(await sql(ports[1], 'SELECT pg_is_in_recovery() AS recovery')).rows[0].recovery,
        'promoted node',
      );
      await ctl(2, 'stop', ['-m', 'fast']);
      stopped.add(2);
      await appendFile(
        join(directories[2], 'postgresql.auto.conf'),
        `\nprimary_conninfo='host=127.0.0.1 port=${ports[1]} user=postgres application_name=node2 sslmode=prefer'\nprimary_slot_name=''\n`,
      );
      await ctl(2, 'start', ['-l', join(fixture, 'node2.log')]);
      stopped.delete(2);
      await sql(ports[1], "ALTER SYSTEM SET synchronous_standby_names='ANY 1 (node2)'");
      await sql(ports[1], 'SELECT pg_reload_conf()');
      await waitFor(
        async () =>
          Number(
            (
              await sql(
                ports[1],
                "SELECT count(*) FROM pg_stat_replication WHERE sync_state='quorum'",
              )
            ).rows[0].count,
          ) === 1,
        'new synchronous topology',
      );
      assert.equal(
        (await writer.writer.appendBatch(original!, operation(10000))).acknowledged[0].status,
        'already_present',
      );
      assert.equal(
        (await writer.writer.appendBatch(batch(), operation(10000))).acknowledged[0].status,
        'stored',
      );
      await assert.doesNotReject(async () => {
        assert.equal(
          (await recovering.writer.appendBatch(original!, operation(10000))).acknowledged[0].status,
          'already_present',
        );
      }, 'an unidentified old-node connection must not block the healthy promoted primary');
      assert.equal(
        (await recovering.writer.appendBatch(batch(), operation(10000))).acknowledged[0].status,
        'stored',
      );
      assert.ok(
        incidents.some((value) => value.code === 'physical_node_unavailable' && value.pending >= 2),
      );
    },
  );
  console.log(
    JSON.stringify({
      postgres: '18',
      fixture: 'three local TLS nodes; no cross-zone or Patroni claim',
      passed: results.length,
      checks: results,
    }),
  );
} finally {
  await Promise.all(gates.map((gate) => gate.close()));
  for (const pid of paused) {
    try {
      process.kill(pid, 'SIGCONT');
    } catch {}
  }
  await Promise.all([...stores].map((store) => store.close(operation(2000))));
  await Promise.all([...clients].map(closeClient));
  for (let index = 2; index >= 0; index--)
    if (!stopped.has(index)) await ctl(index, 'stop', ['-m', 'immediate']).catch(() => undefined);
  await rm(fixture, { recursive: true, force: true });
}
