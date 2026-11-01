import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { traceState } from '../../../protocol/src/traces/context.js';
import {
  traceDefaults,
  type Attributes,
  type AttributeValue,
  type SpanData,
} from '../../../protocol/src/traces/types.js';
import { validateContext, sampled } from './propagation.js';
import { createExporter } from './exporter.js';
import {
  tracerDefaults,
  type Tracer,
  type TracerOptions,
  type StartSpanOptions,
  type SpanHandle,
  type SpanContext,
} from './types.js';
export { extractTraceContext, injectTraceContext } from './propagation.js';
export type {
  Tracer,
  TracerOptions,
  StartSpanOptions,
  SpanHandle,
  SpanContext,
  AttributeValue,
  Attributes,
  TraceFlushResult,
  TracerLimits,
} from './types.js';
function randomId(bytes: number): string {
  let value: string;
  do {
    value = randomBytes(bytes).toString('hex');
  } while (/^0+$/.test(value));
  return value;
}
export function createTracer(input: TracerOptions): Tracer {
  if (
    !Array.isArray(input.endpoints) ||
    !input.endpoints.length ||
    input.endpoints.length > 8 ||
    typeof input.writeToken !== 'string' ||
    !input.writeToken ||
    /\s/.test(input.writeToken) ||
    !Number.isFinite(input.sampleRate) ||
    input.sampleRate < 0 ||
    input.sampleRate > 1
  )
    throw new Error('Invalid tracer configuration');
  for (const [value, maximum] of [
    [input.service, 64],
    [input.environment, 32],
  ] as const)
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximum)
      throw new Error('Invalid tracer scope');
  const endpoints = [...input.endpoints];
  for (const value of endpoints) {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
    )
      throw new Error('Invalid tracer endpoint');
  }
  const options: TracerOptions = {
    ...input,
    endpoints,
    traceStateRules: structuredClone(input.traceStateRules ?? {}),
  };
  for (const [key, rule] of Object.entries(options.traceStateRules!))
    for (const value of rule.safe_values) {
      traceState(`${key}=${value}`);
      if (
        !Number.isInteger(rule.max_value_bytes) ||
        rule.max_value_bytes < 1 ||
        rule.max_value_bytes > 256
      )
        throw new Error('Invalid tracestate rule');
    }
  const limits = { ...tracerDefaults, ...input.limits };
  for (const value of Object.values(limits))
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid tracer limits');
  if (
    limits.queueBytes < limits.batchBytes ||
    limits.batchSize > traceDefaults.max_spans ||
    limits.batchBytes > traceDefaults.body_bytes ||
    limits.maxAttempts > 5 ||
    limits.retryBudgetMs > 30000 ||
    limits.maxValueDepth > 8 ||
    limits.maxValueNodes > 4096 ||
    limits.maxAttributes > 128 ||
    limits.maxEvents > 128 ||
    limits.maxLinks > 128 ||
    limits.maxValueBytes > 4096 ||
    limits.maxKeyBytes > 128 ||
    limits.maxNameBytes > 256
  )
    throw new Error('Invalid tracer limits');
  const counts: Record<string, number> = {};
  function count(key: string, amount = 1) {
    if (amount) counts[key] = (counts[key] ?? 0) + amount;
  }
  const als = new AsyncLocalStorage<SpanContext>();
  let active = 0,
    recording = 0,
    contexts = 0,
    closed = false;
  function safeText(value: string, max: number) {
    if (typeof value !== 'string' || value.length > max || Buffer.byteLength(value) > max)
      throw new Error('Invalid text');
    return value;
  }
  function copyValue(
    value: AttributeValue,
    depth: number,
    counter: { nodes: number; bytes: number; maxBytes: number },
    seen: Set<object>,
  ): AttributeValue {
    if (
      !value ||
      typeof value !== 'object' ||
      depth > limits.maxValueDepth ||
      ++counter.nodes > limits.maxValueNodes ||
      seen.has(value)
    )
      throw new Error('Invalid attribute');
    counter.bytes += 32;
    if ('value' in value && typeof value.value === 'string') {
      safeText(
        value.value,
        value.type === 'bytes' ? Math.ceil(limits.maxValueBytes / 3) * 4 : limits.maxValueBytes,
      );
      counter.bytes += Buffer.byteLength(JSON.stringify(value.value));
    }
    if (counter.bytes > counter.maxBytes) throw new Error('Recording byte budget');
    seen.add(value);
    try {
      switch (value.type) {
        case 'empty':
          return { type: 'empty' };
        case 'string':
          return { type: 'string', value: safeText(value.value, limits.maxValueBytes) };
        case 'bytes': {
          const encoded = safeText(value.value, Math.ceil(limits.maxValueBytes / 3) * 4);
          if (
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded) ||
            Buffer.from(encoded, 'base64').length > limits.maxValueBytes
          )
            throw new Error('Invalid bytes');
          return { type: 'bytes', value: encoded };
        }
        case 'bool':
          if (typeof value.value !== 'boolean') throw new Error('Invalid boolean');
          return { type: 'bool', value: value.value };
        case 'int':
          if (
            typeof value.value !== 'string' ||
            !/^[-]?\d{1,19}$/.test(value.value) ||
            BigInt(value.value) < -(1n << 63n) ||
            BigInt(value.value) >= 1n << 63n
          )
            throw new Error('Invalid int');
          return { type: 'int', value: BigInt(value.value).toString() };
        case 'double': {
          if (typeof value.value === 'number' && Number.isFinite(value.value))
            return { type: 'double', value: value.value };
          const special = typeof value.value === 'number' ? String(value.value) : value.value;
          if (special !== 'NaN' && special !== 'Infinity' && special !== '-Infinity')
            throw new Error('Invalid double');
          return { type: 'double', value: special };
        }
        case 'array':
          if (!Array.isArray(value.value) || value.value.length > limits.maxValueNodes)
            throw new Error('Invalid array');
          return {
            type: 'array',
            value: value.value.map((v) => copyValue(v, depth + 1, counter, seen)),
          };
        case 'kvlist':
          return { type: 'kvlist', value: copyAttributes(value.value, depth + 1, counter, seen) };
        default:
          throw new Error('Invalid attribute');
      }
    } finally {
      seen.delete(value);
    }
  }
  function copyAttributes(
    attributes: Attributes,
    depth = 0,
    counter = { nodes: 0, bytes: 0, maxBytes: limits.maxSpanBytes },
    seen = new Set<object>(),
  ): Attributes {
    if (!Array.isArray(attributes) || attributes.length > limits.maxAttributes)
      throw new Error('Invalid attributes');
    const keys = new Set<string>();
    return attributes.map((item) => {
      const key = safeText(item.key, limits.maxKeyBytes);
      counter.bytes += Buffer.byteLength(JSON.stringify(key)) + 32;
      if (counter.bytes > counter.maxBytes) throw new Error('Recording byte budget');
      if (keys.has(key)) throw new Error('Duplicate attribute');
      keys.add(key);
      return { key, value: copyValue(item.value, depth, counter, seen) };
    });
  }
  function valueNodes(value: AttributeValue): number {
    return (
      1 +
      (value.type === 'array'
        ? value.value.reduce((sum, item) => sum + valueNodes(item), 0)
        : value.type === 'kvlist'
          ? attributeNodes(value.value)
          : 0)
    );
  }
  function attributeNodes(attributes: Attributes): number {
    return attributes.reduce((sum, item) => sum + valueNodes(item.value), 0);
  }
  function spanNodes(span: SpanData): number {
    return (
      attributeNodes(span.resource.attributes) +
      attributeNodes(span.scope.attributes) +
      attributeNodes(span.attributes) +
      span.events.reduce((sum, item) => sum + attributeNodes(item.attributes), 0) +
      span.links.reduce((sum, item) => sum + attributeNodes(item.attributes), 0)
    );
  }
  const resourceBudget = { nodes: 0, bytes: 0, maxBytes: limits.resourceBytes };
  const resourceAttributes = copyAttributes(options.resourceAttributes ?? [], 0, resourceBudget);
  if (
    resourceAttributes.some((a) => ['service.name', 'deployment.environment.name'].includes(a.key))
  )
    throw new Error('Reserved resource attribute');
  const requiredResourceAttributes = copyAttributes(
    [
      { key: 'service.name', value: { type: 'string', value: options.service } },
      { key: 'deployment.environment.name', value: { type: 'string', value: options.environment } },
    ],
    0,
    resourceBudget,
  );
  if (resourceAttributes.length + requiredResourceAttributes.length > limits.maxAttributes)
    throw new Error('Resource attribute count exceeded');
  resourceAttributes.push(...requiredResourceAttributes);
  const scope = {
    name: safeText(options.scope?.name ?? 'oneaster.manual', limits.maxNameBytes),
    version: safeText(options.scope?.version ?? '1', limits.maxNameBytes),
    attributes: copyAttributes(options.scope?.attributes ?? [], 0, resourceBudget),
    dropped_attributes_count: 0,
    schema_url: '',
  };
  if (Buffer.byteLength(JSON.stringify({ resourceAttributes, scope })) > limits.resourceBytes)
    throw new Error('Resource budget exceeded');
  const exporter = createExporter(options, limits, count);
  function startSpan(start: StartSpanOptions): SpanHandle {
    let parent: SpanContext | undefined;
    try {
      const candidate = start.parent === undefined ? als.getStore() : start.parent;
      if (candidate) parent = validateContext(candidate, options.traceStateRules);
    } catch {
      count('invalid_parent');
    }
    const trace = parent?.traceId ?? randomId(16),
      flags = parent ? parent.traceFlags : sampled(trace, options.sampleRate) ? 1 : 0;
    const context: SpanContext = Object.freeze({
      traceId: trace,
      spanId: randomId(8),
      traceFlags: flags,
      traceState: parent?.traceState ?? '',
      isRemote: false,
    });
    let span: SpanData | undefined,
      charged = 0,
      ended = false;
    const monotonic = process.hrtime.bigint(),
      anchor = BigInt(Date.now()) * 1000000n;
    function release() {
      if (charged) {
        recording -= charged;
        active--;
        charged = 0;
      }
      span = undefined;
    }
    function commit(next: SpanData): boolean {
      if (spanNodes(next) > limits.maxValueNodes) {
        count('recording_nodes');
        return false;
      }
      const size = Buffer.byteLength(JSON.stringify(next));
      if (size > limits.maxSpanBytes || recording - charged + size > limits.recordingBytes) {
        count('recording_bytes');
        return false;
      }
      recording += size - charged;
      charged = size;
      span = next;
      return true;
    }
    if (!closed && flags & 1 && active < limits.maxActiveSpans) {
      try {
        const name = safeText(start.name, limits.maxNameBytes);
        if (!name) throw new Error('Invalid name');
        const kind = start.kind ?? 1;
        if (!Number.isInteger(kind) || kind < -2147483648 || kind > 2147483647)
          throw new Error('Invalid kind');
        const next: SpanData = {
          trace_id: trace,
          span_id: context.spanId,
          parent_span_id: parent?.spanId ?? null,
          trace_state: context.traceState,
          name,
          kind,
          flags,
          status: { code: 0, message: '' },
          start_time_unix_nano: anchor.toString(),
          end_time_unix_nano: anchor.toString(),
          duration_ns: '0',
          attributes: [],
          events: [],
          links: [],
          dropped_attributes_count: 0,
          dropped_events_count: 0,
          dropped_links_count: 0,
          resource: { attributes: resourceAttributes, dropped_attributes_count: 0, schema_url: '' },
          scope,
        };
        const initialBudget = {
          nodes: resourceBudget.nodes,
          bytes: 0,
          maxBytes: Math.max(
            0,
            Math.min(limits.maxSpanBytes, limits.recordingBytes - recording) -
              Buffer.byteLength(JSON.stringify(next)),
          ),
        };
        try {
          next.attributes = copyAttributes(start.attributes ?? [], 0, initialBudget);
        } catch {
          next.dropped_attributes_count = start.attributes?.length ?? 1;
          count('invalid_attributes');
        }
        if ((start.links?.length ?? 0) > limits.maxLinks) {
          next.dropped_links_count = start.links!.length;
          count('invalid_links');
        } else
          for (const link of start.links ?? [])
            try {
              const linkContext = validateContext(
                {
                  traceId: link.trace_id,
                  spanId: link.span_id,
                  traceFlags: link.flags,
                  traceState: link.trace_state,
                  isRemote: true,
                },
                options.traceStateRules,
              );
              next.links.push({
                ...link,
                trace_id: linkContext.traceId,
                span_id: linkContext.spanId,
                trace_state: linkContext.traceState,
                attributes: copyAttributes(link.attributes, 0, initialBudget),
              });
            } catch {
              next.dropped_links_count++;
              count('invalid_links');
            }
        if (commit(next)) active++;
      } catch {
        count('invalid_span');
      }
    } else count(closed ? 'closing' : !(flags & 1) ? 'sampled_out' : 'active_limit');
    function update(
      work: (value: SpanData) => void,
      drop?: 'dropped_attributes_count' | 'dropped_events_count',
    ) {
      if (ended || !span) return;
      if (closed) {
        release();
        return;
      }
      try {
        const next = { ...span };
        work(next);
        if (!commit(next) && drop) span[drop] = Math.min(4294967295, span[drop] + 1);
      } catch {
        count('invalid_update');
      }
    }
    return {
      context,
      setAttribute(key, value) {
        update((next) => {
          try {
            const old = next.attributes.find((item) => item.key === key);
            const reclaimed = old ? Buffer.byteLength(JSON.stringify(old)) : 0;
            const budget = {
              nodes: spanNodes(next) - (old ? valueNodes(old.value) : 0),
              bytes: 0,
              maxBytes: Math.max(
                0,
                Math.min(limits.maxSpanBytes - charged, limits.recordingBytes - recording) +
                  reclaimed,
              ),
            };
            const item = copyAttributes([{ key, value }], 0, budget)[0];
            const exists = next.attributes.some((a) => a.key === key);
            if (!exists && next.attributes.length >= limits.maxAttributes)
              throw new Error('Attribute count');
            next.attributes = [...next.attributes.filter((a) => a.key !== key), item];
          } catch {
            next.dropped_attributes_count++;
            count('invalid_attributes');
          }
        }, 'dropped_attributes_count');
      },
      addEvent(name, attributes = []) {
        update((next) => {
          try {
            safeText(name, limits.maxNameBytes);
            if (!name || next.events.length >= limits.maxEvents) throw new Error('Event count');
            next.events = [
              ...next.events,
              {
                name,
                attributes: copyAttributes(attributes, 0, {
                  nodes: spanNodes(next),
                  bytes: 0,
                  maxBytes: Math.max(
                    0,
                    Math.min(limits.maxSpanBytes - charged, limits.recordingBytes - recording) -
                      Buffer.byteLength(name) -
                      128,
                  ),
                }),
                time_unix_nano: (anchor + process.hrtime.bigint() - monotonic).toString(),
                dropped_attributes_count: 0,
              },
            ];
          } catch {
            next.dropped_events_count++;
            count('invalid_events');
          }
        }, 'dropped_events_count');
      },
      setStatus(code, message = '') {
        update((next) => {
          if (!Number.isInteger(code) || code < -2147483648 || code > 2147483647)
            throw new Error('Invalid status');
          next.status = { code, message: safeText(message, limits.maxValueBytes) };
        });
      },
      end() {
        if (ended) return;
        ended = true;
        if (!span) {
          return;
        }
        if (closed) {
          release();
          return;
        }
        const duration = process.hrtime.bigint() - monotonic;
        span = {
          ...span,
          end_time_unix_nano: (anchor + duration).toString(),
          duration_ns: duration.toString(),
        };
        const payload = span;
        release();
        exporter.enqueue(payload);
      },
    };
  }
  return {
    startSpan,
    withSpan<T>(start: StartSpanOptions, callback: (span: SpanHandle) => T): T {
      const span = startSpan(start);
      contexts++;
      function finish() {
        try {
          span.end();
        } finally {
          contexts--;
          if (closed && contexts === 0) als.disable();
        }
      }
      return als.run(span.context, () => {
        let asynchronous = false;
        try {
          const result = callback(span);
          if (result && typeof (result as unknown as PromiseLike<unknown>).then === 'function') {
            const pending = Promise.resolve(result)
              .catch((error: unknown) => {
                span.setStatus(2);
                throw error;
              })
              .finally(finish);
            asynchronous = true;
            return pending as T;
          }
          return result;
        } catch (error) {
          span.setStatus(2);
          throw error;
        } finally {
          if (!asynchronous) finish();
        }
      });
    },
    currentContext: () => als.getStore(),
    flush: (options) => exporter.flush(options),
    close(options) {
      const promise = exporter.close(options);
      closed = true;
      if (contexts === 0) als.disable();
      return promise;
    },
    getDiagnostics: () => ({
      ...exporter.stats(),
      activeSpans: active,
      recordingBytes: recording,
      counts: { ...counts },
    }),
  };
}
