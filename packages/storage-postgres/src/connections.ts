import { Client, type QueryResult, type QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { StoreError, type OperationOptions } from '../../storage-contract/src/index.js';
import { positiveInteger, type PostgresStoreOptions } from './options.js';

interface Backend {
  nodeId: string;
  pid: number;
  started: string;
  database: string;
  username: string;
  application: string;
  address: string;
  port: number;
  serverStarted: string;
}

export interface Connection {
  client: Client;
  backend: Backend;
  broken: boolean;
  busy: boolean;
}

export interface Budget {
  options: OperationOptions;
  expires: number;
}

export function budget(options: OperationOptions): Budget {
  if (!Number.isFinite(options.deadlineAtMs)) throw new StoreError('storage_unavailable');
  return { options, expires: performance.now() + Math.max(0, options.deadlineAtMs - Date.now()) };
}

export function remaining(value: Budget): number {
  if (value.options.signal.aborted) throw new StoreError('storage_unavailable');
  const left = Math.floor(value.expires - performance.now());
  if (left <= 0) throw new StoreError('storage_unavailable');
  return left;
}

async function identity(client: Client, nodeId: string): Promise<Backend> {
  const result =
    await client.query(`SELECT pg_backend_pid() AS pid, a.backend_start::text AS started,
 current_database() AS database, session_user AS username, current_setting('application_name') AS application,
 COALESCE(inet_server_addr()::text,'local') AS address, COALESCE(inet_server_port(),0) AS port,
 pg_postmaster_start_time()::text AS "serverStarted"
 FROM pg_stat_activity a WHERE a.pid=pg_backend_pid()`);
  if (!result.rows[0]?.started) throw new StoreError('storage_unavailable');
  return { ...result.rows[0], nodeId } as Backend;
}

export function createConnections(
  input: PostgresStoreOptions,
  purpose: 'data' | 'maintenance' = 'data',
) {
  const settings = {
    maxConnections: positiveInteger(
      input.maxConnections ?? (input.role === 'collector' ? 10 : 5),
      'maxConnections',
      100,
    ),
    maxCleanupConnections: positiveInteger(
      input.maxCleanupConnections ?? 2,
      'maxCleanupConnections',
      2,
    ),
    poolWaitMs: positiveInteger(input.poolWaitMs ?? 250, 'poolWaitMs', 10000),
    statementTimeoutMs: positiveInteger(
      input.statementTimeoutMs ?? (input.role === 'collector' ? 500 : 1500),
      'statementTimeoutMs',
      30000,
    ),
    lockTimeoutMs: positiveInteger(input.lockTimeoutMs ?? 200, 'lockTimeoutMs', 10000),
    commitTimeoutMs: positiveInteger(input.commitTimeoutMs ?? 1000, 'commitTimeoutMs', 10000),
    responseReserveMs: positiveInteger(input.responseReserveMs ?? 25, 'responseReserveMs', 1000),
    cleanupTimeoutMs: positiveInteger(input.cleanupTimeoutMs ?? 1000, 'cleanupTimeoutMs', 10000),
    maxPendingCleanup: positiveInteger(input.maxPendingCleanup ?? 2, 'maxPendingCleanup', 100),
  };
  if (!/^[a-zA-Z0-9_-]{1,16}$/.test(input.instanceId) || !input.nodeId)
    throw new Error('Invalid instanceId or nodeId');
  if (
    !['development', 'ha'].includes(input.profile) ||
    !['collector', 'query'].includes(input.role)
  )
    throw new Error('Invalid profile or role');
  if (
    input.profile === 'ha' &&
    (!input.physicalNodes || input.physicalNodes.length < 3 || input.requireTls !== true)
  )
    throw new Error('HA requires at least three physicalNodes and requireTls');
  const nodes =
    input.profile === 'ha'
      ? input.physicalNodes!
      : [
          {
            id: input.nodeId,
            connectionString: input.connectionString,
            cleanupConnectionString: input.cleanupConnectionString ?? input.connectionString,
          },
        ];
  if (
    new Set(nodes.map((node) => node.id)).size !== nodes.length ||
    nodes.some((node) => !node.id || !node.connectionString || !node.cleanupConnectionString)
  )
    throw new Error('Invalid physicalNodes');
  if (input.requireTls) {
    for (const connectionString of nodes.flatMap((node) => [
      node.connectionString,
      node.cleanupConnectionString,
    ])) {
      if (new URL(connectionString).searchParams.get('sslmode') !== 'verify-full')
        throw new Error('Verified TLS requires sslmode=verify-full');
    }
  }
  type PhysicalNode = (typeof nodes)[number];
  const applicationPrefix =
    purpose === 'maintenance' ? 'telemetry:maintenance-admin:' : `telemetry:${input.instanceId}:`;
  const generation = randomUUID().slice(0, 8);
  const all = new Set<Connection>();
  const connecting = new Set<Client>();
  const discovered = new Map<string, Backend>();
  const unresolved = new Map<string, string>();
  const cleaning = new Set<string>();
  const pending = new Map<string, Backend>();
  const waiting = new Set<() => void>();
  let opening = 0;
  const cleanupActive = new Map<string, number>();
  const cleanupOwners = new WeakMap<Client, string>();
  let closing = false;
  let reconciled = false;
  let initialization: Promise<void> | undefined;
  let discovery: Promise<PhysicalNode> | undefined;
  let discoveryController: AbortController | undefined;
  const cleanupTasks = new Set<Promise<void>>();

  function incident(code: string, nodeId = input.nodeId) {
    try {
      input.onIncident?.({ code, nodeId, pending: pending.size + unresolved.size });
    } catch {
      return;
    }
  }

  function wake() {
    for (const fn of waiting) fn();
    waiting.clear();
  }

  function key(backend: Backend) {
    return `${backend.nodeId}:${backend.address}:${backend.port}:${backend.serverStarted}:${backend.pid}:${backend.started}:${backend.application}`;
  }

  function newClient(
    connectionString: string,
    application: string,
    timeout: number,
    cleanup = false,
  ): Client {
    const sqlTimeout = cleanup ? timeout : settings.statementTimeoutMs;
    const client = new Client({
      connectionString,
      application_name: application,
      connectionTimeoutMillis: timeout,
      ...(cleanup ? { options: `-c idle_session_timeout=${settings.cleanupTimeoutMs}` } : {}),
      query_timeout: sqlTimeout,
      statement_timeout: sqlTimeout,
      idle_in_transaction_session_timeout:
        settings.statementTimeoutMs + settings.commitTimeoutMs + settings.cleanupTimeoutMs,
      keepAlive: true,
    });
    client.on('error', () => undefined);
    return client;
  }

  async function cleanupClient(
    node: PhysicalNode,
    timeout = settings.cleanupTimeoutMs,
  ): Promise<Client> {
    if ((cleanupActive.get(node.id) ?? 0) >= settings.maxCleanupConnections)
      throw new StoreError('overloaded');
    const client = newClient(
      node.cleanupConnectionString,
      purpose === 'maintenance'
        ? `telemetry:maintenance-cleanup:${generation}`
        : `${applicationPrefix}cleanup:${generation}`,
      timeout,
      true,
    );
    cleanupActive.set(node.id, (cleanupActive.get(node.id) ?? 0) + 1);
    cleanupOwners.set(client, node.id);
    try {
      await client.connect();
      if (input.requireTls) {
        const tls = await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()');
        if (!tls.rows[0]?.ssl) throw new StoreError('storage_unavailable');
      }
      if (input.profile === 'ha') {
        const safe = await client.query(`SELECT rolsuper,rolbypassrls,rolconnlimit,
 pg_has_role(session_user,'telemetry_owner','MEMBER') AS owner,
 pg_has_role(session_user,'telemetry_collector','MEMBER') AS collector,
 pg_has_role(session_user,'telemetry_query','MEMBER') AS query
 FROM pg_roles WHERE rolname=session_user`);
        const login = safe.rows[0];
        if (
          !login ||
          login.rolsuper ||
          login.rolbypassrls ||
          login.owner ||
          login.collector ||
          login.query ||
          login.rolconnlimit < 1 ||
          login.rolconnlimit > settings.maxCleanupConnections
        )
          throw new StoreError('storage_unavailable');
      }
      const loginRole = await client.query(
        'SELECT rolsuper FROM pg_roles WHERE rolname=session_user',
      );
      if (input.profile === 'ha' || !loginRole.rows[0]?.rolsuper)
        await client.query('SET ROLE telemetry_cleanup');
      await client.query(
        `SET statement_timeout=${settings.cleanupTimeoutMs}; SET lock_timeout=${settings.lockTimeoutMs}`,
      );
      return client;
    } catch (error) {
      cleanupActive.set(node.id, Math.max(0, (cleanupActive.get(node.id) ?? 1) - 1));
      void client.end().catch(() => undefined);
      throw error;
    }
  }

  async function finishCleanup(client: Client) {
    const nodeId = cleanupOwners.get(client);
    if (nodeId) cleanupActive.set(nodeId, Math.max(0, (cleanupActive.get(nodeId) ?? 1) - 1));
    await client.end().catch(() => undefined);
    wake();
  }

  async function cleanupBackend(backend: Backend): Promise<void> {
    const node = nodes.find((node) => node.id === backend.nodeId);
    if (!node) throw new StoreError('storage_unavailable');
    const client = await cleanupClient(node);
    const expires = performance.now() + settings.cleanupTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(() => {
        void client.end().catch(() => undefined);
      }, settings.cleanupTimeoutMs);
      const here = await identity(client, node.id);
      if (
        here.address !== backend.address ||
        here.port !== backend.port ||
        here.database !== backend.database
      )
        throw new Error('Cleanup physical target mismatch');
      if (here.serverStarted !== backend.serverStarted) {
        pending.delete(key(backend));
        return;
      }
      for (const terminate of [false, true]) {
        if (performance.now() >= expires) throw new Error('Cleanup deadline exceeded');
        const result = await client.query(
          `SELECT ${terminate ? 'pg_terminate_backend' : 'pg_cancel_backend'}(pid) AS signaled
 FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND datname=$3 AND usename=$4 AND application_name=$5`,
          [backend.pid, backend.started, backend.database, backend.username, backend.application],
        );
        if (!result.rowCount) {
          pending.delete(key(backend));
          return;
        }
      }
      while (performance.now() < expires) {
        const still = await client.query(
          'SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND backend_start=$2::timestamptz AND datname=$3 AND usename=$4 AND application_name=$5',
          [backend.pid, backend.started, backend.database, backend.username, backend.application],
        );
        if (!still.rowCount) {
          pending.delete(key(backend));
          return;
        }
        await new Promise<void>((resolve) =>
          setTimeout(resolve, Math.min(10, Math.max(1, expires - performance.now()))),
        );
      }
      incident('backend_cleanup_pending', backend.nodeId);
    } finally {
      if (timer) clearTimeout(timer);
      await finishCleanup(client);
    }
  }

  function scheduleCleanup(backend: Backend) {
    const backendKey = key(backend);
    if (
      cleaning.has(backendKey) ||
      (cleanupActive.get(backend.nodeId) ?? 0) >= settings.maxCleanupConnections
    )
      return;
    cleaning.add(backendKey);
    const task = cleanupBackend(backend)
      .catch(() => incident('backend_cleanup_failed', backend.nodeId))
      .finally(() => {
        cleanupTasks.delete(task);
        cleaning.delete(backendKey);
        wake();
      });
    cleanupTasks.add(task);
  }

  async function reconcile() {
    if (reconciled) return;
    if (!initialization)
      initialization = (async () => {
        for (const node of nodes) {
          if (closing) throw new StoreError('overloaded');
          const client = await cleanupClient(node);
          try {
            const here = await identity(client, node.id);
            for (const [id, other] of discovered) {
              if (id !== node.id && other.address === here.address && other.port === here.port)
                throw new StoreError('storage_unavailable');
            }
            discovered.set(node.id, here);
            const residues = await client.query(
              `SELECT pid,backend_start::text AS started,datname AS database,usename AS username,application_name AS application
 FROM pg_stat_activity WHERE starts_with(application_name,$1) AND datname=current_database() AND pid<>pg_backend_pid()`,
              [applicationPrefix],
            );
            if (
              purpose === 'maintenance' &&
              residues.rows.some(
                (residue) =>
                  Number(residue.application.slice(applicationPrefix.length).split(':')[0]) >
                  Date.now(),
              )
            )
              throw new StoreError('overloaded');
            if (residues.rows.length > settings.maxConnections)
              incident('startup_backend_budget_exceeded', node.id);
            for (const residue of residues.rows) {
              if (
                [...all].some(
                  (connection) => connection.backend.application === residue.application,
                )
              )
                continue;
              const backend = { ...here, ...residue } as Backend;
              pending.set(key(backend), backend);
            }
            for (const [application, id] of unresolved)
              if (id === node.id) unresolved.delete(application);
          } finally {
            await finishCleanup(client);
          }
        }
        for (const backend of pending.values()) {
          if (closing) throw new StoreError('overloaded');
          await cleanupBackend(backend);
        }
        if (pending.size) throw new StoreError('storage_unavailable');
        reconciled = true;
      })().catch((error: unknown) => {
        initialization = undefined;
        throw error;
      });
    await initialization;
  }

  async function reconcileUnresolved(node: PhysicalNode, value: Budget) {
    const applications = [...unresolved]
      .filter(([, nodeId]) => nodeId === node.id)
      .map(([application]) => application);
    if (!applications.length) return;
    const client = await cleanupClient(node, Math.min(settings.cleanupTimeoutMs, remaining(value)));
    try {
      const here = await guardedWait(identity(client, node.id), value, () => {
        void client.end().catch(() => undefined);
      });
      const target = discovered.get(node.id);
      if (
        !target ||
        target.address !== here.address ||
        target.port !== here.port ||
        target.database !== here.database
      )
        throw new StoreError('storage_unavailable');
      const residues = await guardedWait(
        client.query(
          `SELECT pid,backend_start::text AS started,datname AS database,usename AS username,application_name AS application
 FROM pg_stat_activity WHERE application_name=ANY($1::text[]) AND datname=current_database() AND pid<>pg_backend_pid()`,
          [applications],
        ),
        value,
        () => {
          void client.end().catch(() => undefined);
        },
      );
      for (const residue of residues.rows) {
        const backend = { ...here, ...residue } as Backend;
        pending.set(key(backend), backend);
      }
      for (const application of applications) unresolved.delete(application);
    } finally {
      await finishCleanup(client);
    }
    if (!closing)
      for (const backend of pending.values())
        if (backend.nodeId === node.id) scheduleCleanup(backend);
  }

  async function discoverPrimary(value: Budget): Promise<PhysicalNode> {
    if (input.profile !== 'ha') {
      await reconcileUnresolved(nodes[0], value);
      return nodes[0];
    }
    const primary: PhysicalNode[] = [];
    const timeout = Math.max(
      1,
      Math.min(settings.cleanupTimeoutMs, Math.floor(settings.poolWaitMs / 2), remaining(value)),
    );
    await Promise.allSettled(
      nodes.map(async (node) => {
        let client: Client | undefined;
        try {
          client = await cleanupClient(node, timeout);
          remaining(value);
          const here = await guardedWait(identity(client, node.id), value, () => {
            void client?.end().catch(() => undefined);
          });
          discovered.set(node.id, here);
          remaining(value);
          const result = await guardedWait(
            client.query('SELECT pg_is_in_recovery() AS recovery'),
            value,
            () => {
              void client?.end().catch(() => undefined);
            },
          );
          if (!result.rows[0].recovery) primary.push(node);
        } catch {
          incident('physical_node_unavailable', node.id);
        } finally {
          if (client) await finishCleanup(client);
        }
      }),
    );
    if (primary.length !== 1) throw new StoreError('storage_unavailable');
    await reconcileUnresolved(primary[0], value);
    return primary[0];
  }

  async function primaryNode(value: Budget): Promise<PhysicalNode> {
    remaining(value);
    if (input.profile !== 'ha' && !unresolved.size) return nodes[0];
    if (!discovery) {
      const controller = new AbortController();
      discoveryController = controller;
      const shared = budget({
        signal: controller.signal,
        deadlineAtMs: Date.now() + settings.poolWaitMs,
      });
      discovery = discoverPrimary(shared).finally(() => {
        discovery = undefined;
        discoveryController = undefined;
        wake();
      });
    }
    return guardedWait(discovery, value);
  }

  async function prepare(value: Budget) {
    remaining(value);
    if (closing) throw new StoreError('overloaded');
    await guardedWait(reconcile(), value);
    remaining(value);
  }

  async function acquire(value: Budget): Promise<Connection> {
    remaining(value);
    const expires = Math.min(value.expires, performance.now() + settings.poolWaitMs);
    const admission = { ...value, expires };
    await guardedWait(reconcile(), admission);
    while (true) {
      remaining(value);
      if (closing) throw new StoreError('overloaded');
      for (const backend of pending.values()) scheduleCleanup(backend);
      for (const connection of all) {
        if (!connection.busy && !connection.broken) {
          connection.busy = true;
          return connection;
        }
      }
      const node = await primaryNode(admission);
      if (closing) throw new StoreError('overloaded');
      remaining(admission);
      const nodePending =
        [...pending.values()].filter((backend) => backend.nodeId === node.id).length +
        [...unresolved.values()].filter((nodeId) => nodeId === node.id).length;
      const nodeConnections = [...all].filter(
        (connection) => connection.backend.nodeId === node.id,
      ).length;
      if (nodePending >= settings.maxPendingCleanup) throw new StoreError('overloaded');
      if (nodeConnections + opening + nodePending < settings.maxConnections) {
        const application = `${applicationPrefix}${purpose === 'maintenance' ? `${value.options.deadlineAtMs}:` : ''}${generation}:${randomUUID().slice(0, 16)}`;
        const client = newClient(
          node.connectionString,
          application,
          Math.max(1, remaining(admission)),
        );
        opening++;
        connecting.add(client);
        let backend: Backend | undefined;
        const establish = async () => {
          try {
            await client.connect();
            backend = await identity(client, node.id);
            const target = discovered.get(node.id);
            if (
              !target ||
              target.address !== backend.address ||
              target.port !== backend.port ||
              target.database !== backend.database ||
              target.serverStarted !== backend.serverStarted
            )
              throw new StoreError('storage_unavailable');
            if (input.requireTls) {
              const tls = await client.query(
                'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
              );
              if (!tls.rows[0]?.ssl) throw new StoreError('storage_unavailable');
            }
            if (input.profile === 'ha') {
              const safe = await client.query(
                `SELECT rolsuper,rolbypassrls,rolconnlimit,
 pg_has_role(session_user,'telemetry_owner','MEMBER') AS owner,
 pg_has_role(session_user,'telemetry_cleanup','MEMBER') AS cleanup,
 pg_has_role(session_user,$1,'MEMBER') AS other
 FROM pg_roles WHERE rolname=session_user`,
                [input.role === 'collector' ? 'telemetry_query' : 'telemetry_collector'],
              );
              const login = safe.rows[0];
              if (
                !login ||
                login.rolsuper ||
                login.rolbypassrls ||
                login.owner ||
                login.cleanup ||
                login.other ||
                login.rolconnlimit < 1 ||
                login.rolconnlimit > settings.maxConnections
              )
                throw new StoreError('storage_unavailable');
            }
            await client.query(
              `SET ROLE ${purpose === 'maintenance' ? 'telemetry_owner' : `telemetry_${input.role}`}; SET SESSION client_min_messages=warning`,
            );
            const messages = await client.query(
              "SELECT current_setting('client_min_messages') AS messages, r.rolsuper,r.rolbypassrls FROM pg_roles r WHERE rolname=current_user",
            );
            if (
              messages.rows[0]?.messages !== 'warning' ||
              messages.rows[0]?.rolsuper ||
              messages.rows[0]?.rolbypassrls
            )
              throw new StoreError('storage_unavailable');
            remaining(admission);
            if (closing) throw new StoreError('overloaded');
            const connection: Connection = { client, backend, broken: false, busy: true };
            client.on('error', () => discard(connection));
            client.on('end', () => discard(connection));
            all.add(connection);
            return connection;
          } catch (error) {
            void client.end().catch(() => undefined);
            if (backend) {
              pending.set(key(backend), backend);
              scheduleCleanup(backend);
            } else {
              unresolved.set(application, node.id);
            }
            throw error instanceof StoreError ? error : new StoreError('storage_unavailable');
          } finally {
            opening--;
            connecting.delete(client);
            wake();
          }
        };
        return guardedWait(establish(), admission, () => {
          void client.end().catch(() => undefined);
        });
      }
      if (performance.now() >= expires || waiting.size >= settings.maxConnections)
        throw new StoreError('overloaded');
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          done();
          reject(new StoreError('storage_unavailable'));
        };
        const timer = setTimeout(
          () => {
            done();
            reject(new StoreError('overloaded'));
          },
          Math.max(1, expires - performance.now()),
        );
        const finish = () => {
          done();
          resolve();
        };
        function done() {
          clearTimeout(timer);
          waiting.delete(finish);
          value.options.signal.removeEventListener('abort', abort);
        }
        waiting.add(finish);
        value.options.signal.addEventListener('abort', abort, { once: true });
        if (value.options.signal.aborted) abort();
      });
    }
  }

  function discard(connection: Connection) {
    if (connection.broken) return;
    connection.broken = true;
    all.delete(connection);
    pending.set(key(connection.backend), connection.backend);
    void connection.client.end().catch(() => undefined);
    scheduleCleanup(connection.backend);
    wake();
  }

  function release(connection: Connection) {
    if (!connection.broken) {
      connection.busy = false;
      wake();
    }
  }

  async function query<Row extends QueryResultRow = QueryResultRow>(
    connection: Connection,
    text: string,
    values: unknown[] | undefined,
    value: Budget,
  ): Promise<QueryResult<Row>> {
    remaining(value);
    return guardedWait(
      connection.client.query<Row>({ text, values, query_timeout: remaining(value) } as {
        text: string;
        values: unknown[] | undefined;
        query_timeout: number;
      }),
      value,
      () => discard(connection),
    );
  }

  async function commit(connection: Connection, value: Budget): Promise<void> {
    const allowed = Math.min(
      settings.commitTimeoutMs,
      remaining(value) - settings.responseReserveMs,
    );
    if (allowed <= 0) throw new StoreError('storage_unavailable');
    const expires = performance.now() + allowed;
    let unknown = false;
    let rejectUnknown: (error: StoreError) => void = () => undefined;
    const markUnknown = () => {
      if (unknown) return;
      unknown = true;
      rejectUnknown(new StoreError('confirmation_unknown', 'unknown'));
      discard(connection);
    };
    const unknownPromise = new Promise<never>((_, reject) => {
      rejectUnknown = reject;
    });
    connection.client.on('notice', markUnknown);
    connection.client.on('error', markUnknown);
    connection.client.on('end', markUnknown);
    value.options.signal.addEventListener('abort', markUnknown, { once: true });
    const timer = setTimeout(markUnknown, allowed);
    try {
      if (value.options.signal.aborted || performance.now() >= expires) markUnknown();
      if (unknown) throw new StoreError('confirmation_unknown', 'unknown');
      const result = await Promise.race([
        connection.client.query({ text: 'COMMIT', query_timeout: allowed } as {
          text: string;
          query_timeout: number;
        }),
        unknownPromise,
      ]);
      if (
        unknown ||
        value.options.signal.aborted ||
        performance.now() >= expires ||
        performance.now() >= value.expires ||
        result.command !== 'COMMIT'
      ) {
        markUnknown();
        throw new StoreError('confirmation_unknown', 'unknown');
      }
    } catch {
      markUnknown();
      throw new StoreError('confirmation_unknown', 'unknown');
    } finally {
      clearTimeout(timer);
      connection.client.off('notice', markUnknown);
      connection.client.off('error', markUnknown);
      connection.client.off('end', markUnknown);
      value.options.signal.removeEventListener('abort', markUnknown);
    }
  }

  async function close(options: OperationOptions) {
    closing = true;
    discoveryController?.abort();
    for (const client of connecting) void client.end().catch(() => undefined);
    wake();
    const value = budget(options);
    while ([...all].some((c) => c.busy) || opening) {
      if (performance.now() >= value.expires || options.signal.aborted) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(
          () => {
            waiting.delete(finish);
            resolve();
          },
          Math.min(20, Math.max(1, value.expires - performance.now())),
        );
        const finish = () => {
          clearTimeout(timer);
          resolve();
        };
        waiting.add(finish);
      });
    }
    for (const connection of all) discard(connection);
    await guardedWait(Promise.allSettled([initialization, discovery]), value).catch(
      () => undefined,
    );
    const attempted = new Set<string>();
    while (performance.now() < value.expires && !options.signal.aborted) {
      for (const backend of pending.values()) {
        const backendKey = key(backend);
        if (attempted.has(backendKey)) continue;
        scheduleCleanup(backend);
        if (cleaning.has(backendKey)) attempted.add(backendKey);
      }
      if (!cleanupTasks.size) break;
      try {
        await guardedWait(Promise.allSettled(cleanupTasks), value);
      } catch {
        break;
      }
    }
  }

  return {
    prepare,
    acquire,
    release,
    discard,
    query,
    commit,
    close,
    settings,
    pendingCount: () => pending.size,
  };
}

async function guardedWait<T>(promise: Promise<T>, value: Budget, cancel?: () => void): Promise<T> {
  let left: number;
  try {
    left = remaining(value);
  } catch (error) {
    void promise.catch(() => undefined);
    cancel?.();
    throw error;
  }
  return new Promise<T>((resolve, reject) => {
    const fail = () => {
      cleanup();
      cancel?.();
      reject(new StoreError('storage_unavailable'));
    };
    const timer = setTimeout(fail, left);
    function cleanup() {
      clearTimeout(timer);
      value.options.signal.removeEventListener('abort', fail);
    }
    value.options.signal.addEventListener('abort', fail, { once: true });
    promise.then(
      (result) => {
        cleanup();
        if (value.options.signal.aborted || performance.now() >= value.expires) {
          cancel?.();
          reject(new StoreError('storage_unavailable'));
          return;
        }
        resolve(result);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (value.options.signal.aborted) fail();
  });
}
