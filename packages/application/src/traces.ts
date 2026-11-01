import { Transform } from 'node:stream';
import { createHash } from 'node:crypto';
import { canonicalTrace } from '../../protocol/src/traces/canonical.js';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import {
  decodeTraces,
  TraceDecodeError,
  encodeTraceResponse,
  encodeTraceStatus,
} from '../../protocol/src/traces/codec.js';
import { projectSpan, safeSpanBytes } from '../../protocol/src/traces/policy.js';
import { traceId } from '../../protocol/src/traces/context.js';
import type {
  OperationOptions,
  TelemetryStore,
  SpanQuery,
  SpanPageKey,
  TraceQueryAccess,
} from '../../storage-contract/src/index.js';
import type { Configuration } from './config.js';
import { authenticate, hash } from './security.js';
import { HttpError } from './errors.js';
import { cursorCodec, type CursorKey } from './cursor.js';
const unzip = promisify(gunzip);
export type TraceMetric =
  | 'received'
  | 'accepted'
  | 'rejected'
  | 'duplicate'
  | 'conflict'
  | 'projected'
  | 'unsupported'
  | 'compressed_bytes'
  | 'decoded_bytes'
  | 'decode_seconds'
  | 'decode_operations'
  | 'write_seconds';
interface TraceRuntime {
  app: FastifyInstance;
  now(): number;
  traceMetric(name: TraceMetric, amount: number): void;
  context(request: FastifyRequest): { configuration: Configuration };
  operation<T>(
    request: FastifyRequest,
    work: (options: OperationOptions) => Promise<T>,
    write?: boolean,
  ): Promise<T>;
}
function binaryRequest(request: FastifyRequest) {
  return /^application\/x-protobuf(?:\s*;\s*charset=utf-8)?$/i.test(
    request.headers['content-type'] ?? '',
  );
}
export function sendTraceFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  message: string,
  retryMs = 0,
) {
  const binary = binaryRequest(request);
  const code =
    status === 400
      ? 3
      : status === 401
        ? 16
        : status === 403
          ? 7
          : status === 413
            ? 8
            : status === 415
              ? 12
              : 14;
  reply
    .header('X-Request-Id', request.id)
    .header('Cache-Control', 'no-store')
    .header('Connection', 'close');
  if (status === 429 || status === 503)
    reply.header('Retry-After', String(Math.max(1, Math.ceil(retryMs / 1000))));
  const payload = encodeTraceStatus(binary, code, message);
  return reply
    .code(status)
    .type(binary ? 'application/x-protobuf' : 'application/json')
    .send(binary ? Buffer.from(payload as Uint8Array) : payload);
}
function traceAuthorization(runtime: TraceRuntime, request: FastifyRequest) {
  const configuration = runtime.context(request).configuration;
  const { project, account } = authenticate(configuration, request.headers.authorization);
  if (
    request.headers.cookie ||
    request.headers.origin ||
    !account.permissions.includes('write:traces')
  )
    throw new HttpError('forbidden');
  const environment = request.headers['x-oneaster-environment'];
  if (typeof environment !== 'string' || !environment) throw new HttpError('invalid_request');
  if (!project.environments.includes(environment) || !account.environments.includes(environment))
    throw new HttpError('forbidden');
  if (
    !/^application\/(?:json|x-protobuf)(?:\s*;\s*charset=utf-8)?$/i.test(
      request.headers['content-type'] ?? '',
    )
  )
    throw new HttpError('unsupported_media');
  const encoding = request.headers['content-encoding'];
  if (encoding !== undefined && !['identity', 'gzip'].includes(String(encoding)))
    throw new HttpError('unsupported_media');
  return { configuration, project, account, environment, encoding };
}
export function registerTraceCollector(runtime: TraceRuntime, store: TelemetryStore) {
  const buckets = new Map<string, { tokens: number; at: number; revision: number }>();
  void runtime.app.register(async (app) => {
    const identities = new WeakMap<FastifyRequest, ReturnType<typeof traceAuthorization>>();
    app.addHook('onRequest', async (request) => {
      identities.set(request, traceAuthorization(runtime, request));
    });
    app.addHook('preParsing', async (request, reply, payload) => {
      const limit = identities.get(request)!.configuration.limits.traces.body_bytes;
      if (Number(request.headers['content-length']) > limit)
        throw new HttpError('payload_too_large');
      let bytes = 0;
      const bounded = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          bytes += chunk.length;
          if (bytes > limit) callback(new HttpError('payload_too_large'));
          else callback(null, chunk);
        },
      });
      Object.defineProperty(bounded, 'receivedEncodedLength', { get: () => bytes });
      const failed = (error: Error) => bounded.destroy(error);
      const aborted = () => bounded.destroy(new HttpError('storage_unavailable'));
      const responseClosed = () => {
        if (!bounded.destroyed) bounded.destroy();
      };
      payload.once('error', failed);
      request.raw.once('aborted', aborted);
      reply.raw.once('close', responseClosed);
      bounded.once('close', () => {
        payload.unpipe(bounded);
        payload.removeListener('error', failed);
        request.raw.removeListener('aborted', aborted);
        reply.raw.removeListener('close', responseClosed);
      });
      payload.pipe(bounded);
      return bounded;
    });
    app.removeAllContentTypeParsers();
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) =>
      done(null, body),
    );
    app.post('/v1/traces', { bodyLimit: 16777216 }, async (request, reply) => {
      const { configuration, project, account, environment, encoding } = identities.get(request)!;
      const limits = configuration.limits.traces;
      const body = request.body as Buffer;
      runtime.traceMetric('compressed_bytes', body.length);
      const decodingStarted = performance.now();
      if (body.length > limits.body_bytes) throw new HttpError('payload_too_large');
      let decoded;
      try {
        decoded = await runtime.operation(request, async (operation) => {
          const uncompressed =
            encoding === 'gzip' ? await unzip(body, { maxOutputLength: limits.body_bytes }) : body;
          if (operation.signal.aborted) throw new HttpError('storage_unavailable');
          runtime.traceMetric('decoded_bytes', uncompressed.length);
          return decodeTraces(uncompressed, binaryRequest(request), limits);
        });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        if (error instanceof TraceDecodeError)
          throw new HttpError(error.status === 413 ? 'payload_too_large' : 'invalid_request');
        if ((error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE')
          throw new HttpError('payload_too_large');
        throw new HttpError('invalid_request');
      }
      runtime.traceMetric('decode_seconds', (performance.now() - decodingStarted) / 1000);
      runtime.traceMetric('decode_operations', 1);
      runtime.traceMetric('received', decoded.total);
      runtime.traceMetric('unsupported', decoded.ignoredExtensions);
      if (
        decoded.services.some(
          (service) => !project.services.includes(service) || !account.services.includes(service),
        )
      )
        throw new HttpError('forbidden');
      if (decoded.environments.some((value) => value !== environment))
        throw new HttpError('invalid_request');
      for (const key of buckets.keys())
        if (!configuration.projects.some((p) => p.id === key)) buckets.delete(key);
      const prior = buckets.get(project.id);
      const quota = project.trace_quota;
      const now = runtime.now();
      const bucket =
        prior?.revision === configuration.revision
          ? prior
          : { tokens: quota.burst, at: now, revision: configuration.revision };
      bucket.tokens = Math.min(
        quota.burst,
        bucket.tokens + (Math.max(0, now - bucket.at) * quota.spans_per_second) / 1000,
      );
      bucket.at = now;
      buckets.set(project.id, bucket);
      if (bucket.tokens < decoded.total)
        throw new HttpError(
          'quota_exceeded',
          'not_committed',
          undefined,
          Math.ceil(((decoded.total - bucket.tokens) * 1000) / quota.spans_per_second),
        );
      bucket.tokens -= decoded.total;
      let rejected = decoded.rejected,
        warning = false;
      const spans = decoded.candidates.flatMap(({ service, span }) => {
        const payload = projectSpan(span, project.trace_policy);
        if (safeSpanBytes(payload) > limits.max_safe_span_bytes) {
          rejected++;
          return [];
        }
        warning ||= Object.keys(payload.collector_dropped).length > 0;
        return [
          {
            service,
            payload,
            digest: createHash('sha256')
              .update(canonicalTrace({ canonicalization_version: 1, service, environment, span }))
              .digest('hex'),
          },
        ];
      });
      if (spans.length) {
        const writeStarted = performance.now();
        const result = await runtime.operation(
          request,
          (options) =>
            store.traces.appendSpans(
              {
                projectId: project.id,
                environment,
                allowedServices: account.services,
                policyVersion: String(configuration.revision),
                retentionDays: configuration.retention.trace_days,
                receiptDays: configuration.retention.receipt_days,
                spans,
              },
              options,
            ),
          true,
        );
        rejected += result.rejectedSpans;
        runtime.traceMetric('duplicate', result.duplicateSpans ?? 0);
        runtime.traceMetric('conflict', result.conflictSpans ?? 0);
        runtime.traceMetric('write_seconds', (performance.now() - writeStarted) / 1000);
      }
      runtime.traceMetric('accepted', decoded.total - rejected);
      runtime.traceMetric('rejected', rejected);
      runtime.traceMetric(
        'projected',
        spans.reduce(
          (sum, item) =>
            sum + Object.values(item.payload.collector_dropped).reduce((n, value) => n + value, 0),
          0,
        ),
      );
      const binary = binaryRequest(request);
      const payload = encodeTraceResponse(binary, rejected, warning);
      return reply
        .header('X-Request-Id', request.id)
        .type(binary ? 'application/x-protobuf' : 'application/json')
        .send(binary ? Buffer.from(payload as Uint8Array) : payload);
    });
  });
}
export function registerTraceQueries(
  runtime: TraceRuntime,
  store: TelemetryStore,
  keys: CursorKey[],
) {
  const codec = cursorCodec<SpanPageKey>(keys, () => runtime.now());
  for (const detail of [false, true])
    runtime.app.get(detail ? '/v1/traces/:trace_id' : '/v1/spans', async (request) => {
      const configuration = runtime.context(request).configuration;
      const { project, account } = authenticate(configuration, request.headers.authorization);
      if (!account.permissions.includes('read:traces')) throw new HttpError('forbidden');
      const params = request.query as Record<string, unknown>;
      const allowed = [
        'environment',
        'from',
        'to',
        'service',
        'limit',
        'cursor',
        ...(detail
          ? []
          : ['trace_id', 'span_id', 'name', 'status_code', 'min_duration_ns', 'max_duration_ns']),
      ];
      if (
        !params ||
        Object.entries(params).some(
          ([key, value]) =>
            !allowed.includes(key) ||
            typeof value !== 'string' ||
            !value ||
            Buffer.byteLength(value) > 8192,
        )
      )
        throw new HttpError('invalid_request');
      const p = params as Record<string, string>;
      if (!p.environment || !account.environments.includes(p.environment))
        throw new HttpError('forbidden');
      if (p.service && !account.services.includes(p.service)) {
        if (!detail) throw new HttpError('forbidden');
      }
      const cursor = p.cursor ? codec.decode(p.cursor) : undefined;
      const from = p.from ?? cursor?.from ?? new Date(runtime.now() - 86400000).toISOString(),
        to = p.to ?? cursor?.to ?? new Date(runtime.now()).toISOString();
      const limit = p.limit === undefined ? 100 : Number(p.limit);
      const instant = (value: string) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value;
      if (
        !instant(from) ||
        !instant(to) ||
        Date.parse(to) <= Date.parse(from) ||
        Date.parse(to) - Date.parse(from) > 7 * 86400000 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 500
      )
        throw new HttpError('invalid_request');
      const query: SpanQuery = {
        from,
        to,
        limit,
        pageBytes: configuration.limits.trace_queries.page_bytes,
      };
      try {
        if (detail) query.trace_id = traceId((request.params as { trace_id: string }).trace_id);
        else {
          if (p.trace_id) query.trace_id = traceId(p.trace_id);
          if (p.span_id) query.span_id = traceId(p.span_id, 16);
        }
      } catch {
        throw new HttpError('invalid_request');
      }
      if (p.service) query.service = p.service;
      if (p.name) query.name = p.name;
      if (p.status_code !== undefined) {
        if (
          !/^-?\d+$/.test(p.status_code) ||
          Number(p.status_code) < -2147483648 ||
          Number(p.status_code) > 2147483647
        )
          throw new HttpError('invalid_request');
        query.status_code = Number(p.status_code);
      }
      for (const key of ['min_duration_ns', 'max_duration_ns'] as const)
        if (p[key]) {
          if (!/^\d{1,20}$/.test(p[key]) || BigInt(p[key]) > 18446744073709551615n)
            throw new HttpError('invalid_request');
          query[key] = BigInt(p[key]).toString();
        }
      if (
        query.min_duration_ns &&
        query.max_duration_ns &&
        BigInt(query.min_duration_ns) > BigInt(query.max_duration_ns)
      )
        throw new HttpError('invalid_request');
      const access: TraceQueryAccess = {
        projectId: project.id,
        environment: p.environment,
        allowedServices: [...account.services].sort(),
        actorKeyId: account.key_id,
        requestId: request.id,
        queryKind: detail ? 'trace' : 'spans',
        queryDigest: '',
        auditRetentionDays: configuration.retention.audit_days,
      };
      const binding = hash({
        project: project.id,
        environment: p.environment,
        services: access.allowedServices,
        query,
        kind: access.queryKind,
        order: 'received_at,trace_id,span_id:desc',
        contract: store.capabilities.contractVersion,
        driver: store.capabilities.driver,
      });
      if (cursor) {
        if (cursor.binding !== binding) throw new HttpError('invalid_cursor');
        query.after = cursor.after;
      }
      access.queryDigest = binding;
      const page = await runtime.operation(request, (options) =>
        store.traces.findSpans(query, access, options),
      );
      if (detail && !page.items.length) throw new HttpError('not_found');
      const result = {
        ...page,
        next_cursor: page.next_cursor
          ? codec.encode({ binding, from, to, after: JSON.parse(page.next_cursor) as SpanPageKey })
          : null,
        ...(detail ? { trace_id: query.trace_id, completeness: 'unknown' } : {}),
      };
      if (Buffer.byteLength(JSON.stringify(result)) > query.pageBytes)
        throw new HttpError('storage_unavailable');
      return result;
    });
}
