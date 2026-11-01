import type { TraceMetric } from './traces.js';
import { traceId } from '../../protocol/src/traces/context.js';
import { registerTraceCollector, registerTraceQueries, sendTraceFailure } from './traces.js';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { parseEnvelope, ProtocolError } from '../../protocol/src/index.js';
import type { Source, TelemetryEvent } from '../../protocol/src/types.js';
import {
  requireCapabilities,
  StoreError,
  type EventQuery,
  type OperationOptions,
  type PageKey,
  type QueryAccess,
  type TelemetryStore,
} from '../../storage-contract/src/index.js';
import { type ConfigManager, type Configuration } from './config.js';
import { cursorCodec, type CursorKey } from './cursor.js';
import { errorDefinition, HttpError } from './errors.js';
import { authenticate, fingerprint, hash, projectEvents } from './security.js';
export { createConfigManager } from './config.js';
export type {
  ConfigManager,
  Configuration,
  ProjectConfiguration,
  PropertyRule,
  ActiveConfig,
} from './config.js';
export type { CursorKey } from './cursor.js';
export interface ApplicationOptions {
  store: TelemetryStore;
  config: ConfigManager;
  now?: () => number;
}
export interface QueryApiOptions extends ApplicationOptions {
  cursorKeys: CursorKey[];
}
interface Context {
  configuration: Configuration;
  operation: OperationOptions;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  pending: number;
  responded: boolean;
  released: boolean;
  committing: boolean;
  trace: boolean;
}
interface Runtime {
  traceMetric(name: TraceMetric, amount: number): void;
  app: FastifyInstance;
  context(request: FastifyRequest): Context;
  operation<T>(
    request: FastifyRequest,
    work: (options: OperationOptions) => Promise<T>,
    write?: boolean,
  ): Promise<T>;
  now(): number;
}
function runtime(options: ApplicationOptions): Runtime {
  const now = options.now ?? Date.now;
  const initial = options.config.current().value;
  requireCapabilities(options.store.capabilities, initial.profile);
  const app = Fastify({
    logger: false,
    genReqId: () => randomUUID(),
    bodyLimit: 32 * 1024,
    requestTimeout: initial.limits.body_timeout_ms,
    connectionTimeout: initial.limits.body_timeout_ms,
    routerOptions: { maxParamLength: 8192 },
    trustProxy: initial.trusted_proxies,
  });
  const starts = new WeakMap<FastifyRequest, number>();
  let metricBuckets = initial.limits.latency_buckets_ms;
  const requests = new Map<string, number>();
  const durations = new Map<string, { count: number; sum: number; buckets: number[] }>();
  const contexts = new WeakMap<FastifyRequest, Context>();
  const active = new Set<Context>();
  const counts = new Map<string, number>();
  const traceMetrics = new Map<TraceMetric, number>();
  function release(context: Context) {
    if (context.responded && context.pending === 0 && !context.released) {
      context.released = true;
      clearTimeout(context.timer);
      active.delete(context);
    }
  }
  function sendError(request: FastifyRequest, reply: FastifyReply, error: HttpError) {
    const definition = errorDefinition(error.code);
    if (request.method === 'POST' && request.url.split('?')[0] === '/v1/traces')
      return sendTraceFailure(
        request,
        reply,
        definition.status,
        definition.message,
        error.retryAfterMs,
      );
    const code =
      definition === errorDefinition('storage_unavailable') ? 'storage_unavailable' : error.code;
    counts.set(code, (counts.get(code) ?? 0) + 1);
    if (error.retryAfterMs)
      reply.header('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
    return reply.code(definition.status).send({
      request_id: request.id,
      error: {
        code,
        message: definition.message,
        retryable: definition.retryable,
        outcome: error.outcome,
        ...(error.items ? { items: error.items } : {}),
        ...(error.retryAfterMs ? { retry_after_ms: error.retryAfterMs } : {}),
      },
    });
  }
  app.setErrorHandler((error, request, reply) => {
    if (reply.sent) return;
    const failure =
      error instanceof HttpError || error instanceof StoreError || error instanceof ProtocolError
        ? new HttpError(
            error.code,
            error instanceof StoreError || error instanceof HttpError
              ? error.outcome
              : 'not_committed',
            error.items,
            error instanceof HttpError ? error.retryAfterMs : undefined,
          )
        : new HttpError(
            (error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE'
              ? 'payload_too_large'
              : (error as { statusCode?: number }).statusCode === 400 ||
                  (error as { statusCode?: number }).statusCode === 415
                ? 'invalid_request'
                : 'storage_unavailable',
          );
    sendError(request, reply, failure);
  });
  app.setNotFoundHandler((request, reply) => sendError(request, reply, new HttpError('not_found')));
  app.addHook('onRequest', async (request, reply) => {
    starts.set(request, performance.now());
    reply.header('Cache-Control', 'no-store');
    if (request.url === '/live' || request.url === '/metrics') return;
    let configuration: Configuration;
    try {
      configuration = options.config.current().value;
      requireCapabilities(options.store.capabilities, configuration.profile);
    } catch {
      throw new HttpError('storage_unavailable');
    }
    request.raw.socket?.setTimeout?.(configuration.limits.body_timeout_ms);
    if (active.size >= configuration.limits.max_concurrent) throw new HttpError('overloaded');
    const trace = request.method === 'POST' && request.url.split('?')[0] === '/v1/traces';
    if (
      trace &&
      [...active].filter((item) => item.trace).length >= configuration.limits.traces.max_concurrent
    )
      throw new HttpError('overloaded');
    const controller = new AbortController();
    const context: Context = {
      configuration,
      operation: {
        signal: controller.signal,
        deadlineAtMs: now() + configuration.limits.request_timeout_ms,
      },
      controller,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      pending: 0,
      responded: false,
      released: false,
      committing: false,
      trace,
    };
    context.timer = setTimeout(() => {
      controller.abort();
      if (!context.responded && !reply.sent)
        sendError(
          request,
          reply,
          new HttpError(
            context.committing ? 'confirmation_unknown' : 'storage_unavailable',
            context.committing ? 'unknown' : 'not_committed',
          ),
        );
    }, configuration.limits.request_timeout_ms);
    contexts.set(request, context);
    active.add(context);
    const disconnected = () => {
      controller.abort();
      context.responded = true;
      release(context);
    };
    request.raw.once('aborted', disconnected);
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) disconnected();
    });
  });
  app.addHook('preValidation', async (request) => {
    request.raw.socket?.setTimeout?.(0);
  });
  app.addHook('onResponse', async (request, reply) => {
    const context = contexts.get(request);
    if (context) {
      context.responded = true;
      release(context);
    }
    if (request.routeOptions.url === '/metrics') return;
    const route = request.routeOptions.url ?? '/unmatched';
    const method = ['GET', 'POST', 'OPTIONS', 'HEAD'].includes(request.method)
      ? request.method
      : 'OTHER';
    const labels = `route=${JSON.stringify(route)},method=${JSON.stringify(method)}`;
    const requestLabels = `${labels},status="${reply.statusCode}"`;
    requests.set(requestLabels, (requests.get(requestLabels) ?? 0) + 1);
    const desiredBuckets = context?.configuration.limits.latency_buckets_ms ?? metricBuckets;
    if (JSON.stringify(desiredBuckets) !== JSON.stringify(metricBuckets)) {
      durations.clear();
      metricBuckets = desiredBuckets;
    }
    const duration =
      Math.max(0, performance.now() - (starts.get(request) ?? performance.now())) / 1000;
    const histogram = durations.get(labels) ?? {
      count: 0,
      sum: 0,
      buckets: metricBuckets.map(() => 0),
    };
    histogram.count += 1;
    histogram.sum += duration;
    for (let index = 0; index < metricBuckets.length; index += 1)
      if (duration <= metricBuckets[index]! / 1000) histogram.buckets[index]! += 1;
    durations.set(labels, histogram);
  });
  app.addHook('onClose', async () => {
    for (const context of active) {
      clearTimeout(context.timer);
      context.controller.abort();
    }
  });
  app.get('/live', async () => ({ live: true }));
  app.get('/ready', async (request, reply) => {
    const context = contexts.get(request)!;
    const readiness = await operation(request, (operationOptions) =>
      options.store.readiness(operationOptions),
    );
    if (!readiness.ready)
      return reply
        .code(503)
        .send({ ready: false, profile: context.configuration.profile, ...options.config.status() });
    return { ready: true, profile: context.configuration.profile, ...options.config.status() };
  });
  app.get('/metrics', async (_request, reply) => {
    const status = options.config.status();
    const lines = [
      `telemetry_active_requests ${active.size}`,
      `telemetry_config_revision ${status.active_revision}`,
      `telemetry_config_valid ${Number(status.valid)}`,
      `telemetry_config_expires_at_seconds ${Date.parse(status.expires_at) / 1000}`,
      `telemetry_config_info{digest="${status.digest}"} 1`,
    ];
    for (const [labels, count] of requests)
      lines.push(`telemetry_requests_total{${labels}} ${count}`);
    for (const [labels, histogram] of durations) {
      for (let index = 0; index < metricBuckets.length; index += 1)
        lines.push(
          `telemetry_request_duration_seconds_bucket{${labels},le="${metricBuckets[index]! / 1000}"} ${histogram.buckets[index]}`,
        );
      lines.push(
        `telemetry_request_duration_seconds_bucket{${labels},le="+Inf"} ${histogram.count}`,
        `telemetry_request_duration_seconds_count{${labels}} ${histogram.count}`,
        `telemetry_request_duration_seconds_sum{${labels}} ${histogram.sum}`,
      );
    }
    for (const [code, count] of counts)
      lines.push(`telemetry_rejections_total{code="${code}"} ${count}`);
    for (const [key, value] of traceMetrics) lines.push(`telemetry_traces_${key}_total ${value}`);
    lines.push(
      `telemetry_active_trace_requests ${[...active].filter((item) => item.trace).length}`,
    );
    return reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`);
  });
  async function operation<T>(
    request: FastifyRequest,
    work: (operationOptions: OperationOptions) => Promise<T>,
    write = false,
  ): Promise<T> {
    const context = contexts.get(request)!;
    if (context.operation.signal.aborted) throw new HttpError('storage_unavailable');
    context.pending += 1;
    context.committing = write;
    try {
      return await work(context.operation);
    } finally {
      context.pending -= 1;
      release(context);
    }
  }
  return {
    app,
    context(request) {
      return contexts.get(request)!;
    },
    operation,
    traceMetric(name, amount) {
      if (Number.isFinite(amount) && amount > 0)
        traceMetrics.set(name, (traceMetrics.get(name) ?? 0) + amount);
    },
    now,
  };
}
export function createCollector(options: ApplicationOptions): FastifyInstance {
  const instance = runtime(options);
  const { app } = instance;
  registerTraceCollector(instance, options.store);
  const buckets = new Map<string, { tokens: number; updated: number; revision: number }>();
  app.addHook('onRequest', async (request) => {
    const context = instance.context(request);
    if (context)
      for (const key of buckets.keys())
        if (!context.configuration.projects.some((project) => project.id === key))
          buckets.delete(key);
  });
  app.options('/v1/ingest/browser', async (request, reply) => {
    const origin = request.headers.origin;
    if (
      !origin ||
      !instance
        .context(request)
        .configuration.projects.some((project) =>
          project.browser_keys.some((key) => key.origins.includes(origin)),
        )
    )
      throw new HttpError('forbidden');
    return reply
      .header('Access-Control-Allow-Origin', origin)
      .header('Vary', 'Origin')
      .header('Access-Control-Allow-Methods', 'POST')
      .header('Access-Control-Allow-Headers', 'Content-Type')
      .code(204)
      .send();
  });
  for (const source of ['browser', 'server'] as const)
    app.post(`/v1/ingest/${source}`, async (request, reply) => {
      const context = instance.context(request);
      const configuration = context.configuration;
      if (
        request.headers['content-encoding'] !== undefined ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers['content-type'] ?? '')
      )
        throw new HttpError('invalid_request');
      const identity =
        source === 'server'
          ? authenticate(configuration, request.headers.authorization)
          : undefined;
      if (identity && !identity.account.permissions.includes('write:server'))
        throw new HttpError('forbidden');
      const envelope = parseEnvelope(request.body, source);
      let project = identity?.project;
      if (source === 'browser') {
        if (request.headers.authorization || request.headers.cookie)
          throw new HttpError('forbidden');
        project = configuration.projects.find((item) =>
          item.browser_keys.some((key) => key.key === envelope.project_key),
        );
        if (!project) throw new HttpError('unauthenticated');
        const key = project.browser_keys.find((item) => item.key === envelope.project_key)!;
        if (
          !request.headers.origin ||
          !key.origins.includes(request.headers.origin) ||
          key.environment !== envelope.environment ||
          key.service !== envelope.service
        )
          throw new HttpError('forbidden');
        reply
          .header('Access-Control-Allow-Origin', request.headers.origin)
          .header('Vary', 'Origin');
      }
      if (
        !project ||
        !project.environments.includes(envelope.environment) ||
        !project.services.includes(envelope.service) ||
        (identity &&
          (!identity.account.environments.includes(envelope.environment) ||
            !identity.account.services.includes(envelope.service)))
      )
        throw new HttpError('forbidden');
      const projected = projectEvents(envelope, project);
      const now = instance.now();
      const prior = buckets.get(project.id);
      const quota = project.quota;
      const bucket =
        prior?.revision === configuration.revision
          ? prior
          : { tokens: quota.burst, updated: now, revision: configuration.revision };
      bucket.tokens = Math.min(
        quota.burst,
        bucket.tokens + (Math.max(0, now - bucket.updated) / 1000) * quota.events_per_second,
      );
      bucket.updated = now;
      buckets.set(project.id, bucket);
      if (bucket.tokens < envelope.events.length)
        throw new HttpError(
          'quota_exceeded',
          'not_committed',
          undefined,
          Math.ceil(((envelope.events.length - bucket.tokens) / quota.events_per_second) * 1000),
        );
      bucket.tokens -= envelope.events.length;
      const events = envelope.events.map((event, index) => ({
        payload: projected[index]!,
        digest: hash({
          event,
          environment: envelope.environment,
          service: envelope.service,
          release: envelope.release,
          build_id: envelope.build_id,
        }),
        fingerprint: fingerprint(project.id, envelope, source, projected[index]!),
      }));
      const receipt = await instance.operation(
        request,
        (operationOptions) =>
          options.store.writer.appendBatch(
            {
              scope: {
                projectId: project.id,
                environment: envelope.environment,
                service: envelope.service,
                source,
                release: envelope.release,
                buildId: envelope.build_id,
                policyVersion: String(configuration.revision),
                retentionDays: configuration.retention.event_days,
                receiptDays: configuration.retention.receipt_days,
              },
              events,
            },
            operationOptions,
          ),
        true,
      );
      return {
        request_id: request.id,
        project_id: project.id,
        environment: envelope.environment,
        source,
        service: envelope.service,
        acknowledged: receipt.acknowledged,
      };
    });
  return app;
}
const sharedFilters = [
  'environment',
  'from',
  'to',
  'limit',
  'cursor',
  'source',
  'service',
  'release',
  'request_id',
];
function queryStrings(value: unknown, allowed: string[]): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError('invalid_request');
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      !allowed.includes(key) ||
      typeof item !== 'string' ||
      !item ||
      Buffer.byteLength(item) > (key === 'cursor' ? 8192 : 256)
    )
      throw new HttpError('invalid_request');
    result[key] = item;
  }
  return result;
}
function instant(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
export function createQueryApi(options: QueryApiOptions): FastifyInstance {
  const instance = runtime(options);
  const { app } = instance;
  registerTraceQueries(instance, options.store, options.cursorKeys);
  const codec = cursorCodec(options.cursorKeys, () => instance.now());
  app.get('/v1/doctor', async (request) => {
    const { configuration } = instance.context(request);
    const { project, account } = authenticate(configuration, request.headers.authorization);
    return {
      api_version: '1',
      project_id: project.id,
      environments: account.environments,
      services: account.services,
      permissions: account.permissions,
      profile: configuration.profile,
    };
  });
  function authorization(
    request: FastifyRequest,
    parameters: Record<string, string>,
    kind: 'events' | 'errors' | 'event' | 'error',
  ): QueryAccess {
    const { configuration } = instance.context(request);
    const { project, account } = authenticate(configuration, request.headers.authorization);
    if (!account.permissions.includes(kind.startsWith('error') ? 'read:errors' : 'read:events'))
      throw new HttpError('forbidden');
    if (!parameters.environment || !account.environments.includes(parameters.environment))
      throw new HttpError('forbidden');
    if (parameters.service && !account.services.includes(parameters.service))
      throw new HttpError(kind === 'event' || kind === 'error' ? 'not_found' : 'forbidden');
    return {
      projectId: project.id,
      environment: parameters.environment,
      allowedServices: [...account.services].sort(),
      allowedKinds: kind.startsWith('error') ? ['error'] : ['error', 'event'],
      actorKeyId: account.key_id,
      requestId: request.id,
      queryKind: kind,
      queryDigest: '',
      auditRetentionDays: configuration.retention.audit_days,
    };
  }
  for (const kind of ['events', 'errors'] as const) {
    app.get(`/v1/${kind}`, async (request) => {
      const parameters = queryStrings(request.query, [
        ...sharedFilters,
        ...(kind === 'events'
          ? ['name', 'trace_id', 'span_id', 'user_id']
          : ['code', 'fingerprint']),
      ]);
      if (parameters.span_id) {
        try {
          parameters.span_id = traceId(parameters.span_id, 16);
          parameters.trace_id = traceId(parameters.trace_id);
        } catch {
          throw new HttpError('invalid_request');
        }
      }
      const access = authorization(request, parameters, kind);
      const cursor = parameters.cursor ? codec.decode(parameters.cursor) : undefined;
      const from =
        parameters.from ??
        cursor?.from ??
        new Date(instance.now() - 24 * 60 * 60 * 1000).toISOString();
      const to = parameters.to ?? cursor?.to ?? new Date(instance.now()).toISOString();
      const limit = parameters.limit === undefined ? 100 : Number(parameters.limit);
      if (
        !instant(from) ||
        !instant(to) ||
        Date.parse(from) >= Date.parse(to) ||
        Date.parse(to) - Date.parse(from) > 7 * 24 * 60 * 60 * 1000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 500 ||
        (parameters.source !== undefined && !['browser', 'server'].includes(parameters.source))
      )
        throw new HttpError('invalid_request');
      const query: EventQuery = { from, to, limit };
      for (const [key, value] of Object.entries(parameters))
        if (!['environment', 'cursor', 'from', 'to', 'limit'].includes(key))
          Object.assign(query, { [key]: value });
      const binding = hash({
        project: access.projectId,
        environment: access.environment,
        services: access.allowedServices,
        kinds: access.allowedKinds,
        required: kind,
        query,
        order: 'received_at,service,source,id:desc',
        driver: options.store.capabilities.driver,
        contract: options.store.capabilities.contractVersion,
      });
      if (cursor) {
        if (cursor.binding !== binding) throw new HttpError('invalid_cursor');
        query.after = cursor.after;
      }
      access.queryDigest = binding;
      const page = await instance.operation(request, (operationOptions) =>
        kind === 'events'
          ? options.store.reader.findEvents(query, access, operationOptions)
          : options.store.reader.findErrors(query, access, operationOptions),
      );
      const after = page.next_cursor ? (JSON.parse(page.next_cursor) as PageKey) : undefined;
      return {
        ...page,
        next_cursor: after ? codec.encode({ binding, after, from, to }) : null,
        pagination: 'live-pagination',
      };
    });
    app.get(`/v1/${kind}/:source/:id`, async (request) => {
      const parameters = queryStrings(request.query, ['environment', 'service']);
      const route = request.params as { source: string; id: string };
      if (
        !parameters.environment ||
        !parameters.service ||
        !['browser', 'server'].includes(route.source) ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(route.id)
      )
        throw new HttpError('invalid_request');
      const access = authorization(request, parameters, kind === 'events' ? 'event' : 'error');
      access.queryDigest = hash({
        ...route,
        environment: access.environment,
        service: parameters.service,
      });
      const result = await instance.operation(request, (operationOptions) =>
        options.store.reader.getEvent(
          {
            environment: access.environment,
            service: parameters.service!,
            source: route.source as Source,
            id: route.id,
          },
          access,
          operationOptions,
        ),
      );
      if (result.status === 'absent') throw new HttpError('not_found');
      if (result.status === 'expired') throw new HttpError('event_expired');
      return result.event satisfies TelemetryEvent;
    });
  }
  return app;
}
