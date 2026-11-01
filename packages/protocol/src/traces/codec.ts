import protobuf from 'protobufjs/light.js';
import descriptor from './descriptor.json';
import { utf8Bytes } from '../index.js';
import { parseTraceJson } from './json.js';
import { traceId, traceState } from './context.js';
import {
  traceDefaults,
  type Attributes,
  type AttributeValue,
  type SpanData,
  type TraceLimits,
} from './types.js';
export class TraceDecodeError extends Error {
  constructor(public status = 400) {
    super('Invalid trace request.');
  }
}
const root = protobuf.Root.fromJSON(descriptor);
const requestType = root.lookupType(
  'opentelemetry.proto.collector.trace.v1.ExportTraceServiceRequest',
);
const responseType = root.lookupType(
  'opentelemetry.proto.collector.trace.v1.ExportTraceServiceResponse',
);
const statusType = root.lookupType('google.rpc.Status');
export type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (value === null || value === undefined) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TraceDecodeError();
  return value as ObjectValue;
}
function array(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((item) => item === null)) throw new TraceDecodeError();
  return value;
}
export function decimal(value: unknown, signed = false): string {
  if (value === undefined || value === null) return '0';
  let result: bigint;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) throw new TraceDecodeError();
    result = BigInt(value);
  } else if (typeof value === 'string' && value.length <= 128) {
    const matched = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
    if (!matched) throw new TraceDecodeError();
    const exponent = Number(matched[4] ?? 0) - (matched[3]?.length ?? 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 128) throw new TraceDecodeError();
    let digits = BigInt(`${matched[1]}${matched[2]}${matched[3] ?? ''}`);
    if (exponent >= 0) digits *= 10n ** BigInt(exponent);
    else {
      const divisor = 10n ** BigInt(-exponent);
      if (digits % divisor !== 0n) throw new TraceDecodeError();
      digits /= divisor;
    }
    result = digits;
  } else throw new TraceDecodeError();
  if (
    result < (signed ? -(1n << 63n) : 0n) ||
    result > (signed ? (1n << 63n) - 1n : (1n << 64n) - 1n)
  )
    throw new TraceDecodeError();
  return result.toString();
}
function text(value: unknown, max = Infinity): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TraceDecodeError();
  if (utf8Bytes(value) > max) throw new Error('invalid_span');
  return value;
}
function integer(value: unknown, uint = true): number {
  if (value === undefined || value === null) return 0;
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < (uint ? 0 : -2147483648) ||
    value > (uint ? 4294967295 : 2147483647)
  )
    throw new TraceDecodeError();
  return value;
}
export function normalizeAttributes(
  input: unknown,
  limits: TraceLimits = traceDefaults,
  depth = 0,
  counter = { nodes: 0, ignored: 0 },
): Attributes {
  const values = array(input);
  if (values.length > limits.max_attributes) throw new Error('invalid_span');
  const keys = new Set<string>();
  return values
    .map((value) => {
      const item = object(value);
      const key = text(item.key, limits.max_attribute_key_bytes);
      if (item.keyStrindex !== undefined && integer(item.keyStrindex, false) !== 0)
        counter.ignored++;
      if (keys.has(key)) throw new Error('invalid_span');
      keys.add(key);
      return { key, value: normalizeValue(item.value, limits, depth, counter) };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
function normalizeValue(
  input: unknown,
  limits: TraceLimits,
  depth: number,
  counter: { nodes: number; ignored: number },
): AttributeValue {
  if (depth > limits.max_value_depth || ++counter.nodes > limits.max_value_nodes)
    throw new Error('invalid_span');
  const item = object(input);
  const variants = [
    'stringValue',
    'boolValue',
    'intValue',
    'doubleValue',
    'bytesValue',
    'arrayValue',
    'kvlistValue',
    'stringValueStrindex',
  ].filter((key) => item[key] !== undefined && item[key] !== null);
  if (variants.length > 1) throw new TraceDecodeError();
  switch (variants[0]) {
    case 'stringValue':
      return { type: 'string', value: text(item.stringValue, limits.max_value_bytes) };
    case 'boolValue':
      if (typeof item.boolValue !== 'boolean') throw new TraceDecodeError();
      return { type: 'bool', value: item.boolValue };
    case 'intValue':
      return { type: 'int', value: decimal(item.intValue, true) };
    case 'doubleValue': {
      const value = item.doubleValue;
      if (
        !(typeof value === 'number' && Number.isFinite(value)) &&
        !['NaN', 'Infinity', '-Infinity'].includes(value as string)
      )
        throw new TraceDecodeError();
      return { type: 'double', value: value as number | 'NaN' | 'Infinity' | '-Infinity' };
    }
    case 'bytesValue': {
      let value = text(item.bytesValue).replaceAll('-', '+').replaceAll('_', '/');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.replace(/=+$/, '').length % 4 === 1)
        throw new TraceDecodeError();
      value = value.replace(/=+$/, '');
      value += '='.repeat((4 - (value.length % 4)) % 4);
      const size = protobuf.util.base64.length(value);
      if (size > limits.max_value_bytes) throw new Error('invalid_span');
      const bytes = protobuf.util.newBuffer(size);
      protobuf.util.base64.decode(value, bytes, 0);
      return { type: 'bytes', value: protobuf.util.base64.encode(bytes, 0, size) };
    }
    case 'arrayValue':
      return {
        type: 'array',
        value: array(object(item.arrayValue).values).map((v) =>
          normalizeValue(v, limits, depth + 1, counter),
        ),
      };
    case 'kvlistValue':
      return {
        type: 'kvlist',
        value: normalizeAttributes(object(item.kvlistValue).values, limits, depth + 1, counter),
      };
    case 'stringValueStrindex':
      integer(item.stringValueStrindex, false);
      counter.ignored++;
      return { type: 'empty' };
    default:
      return { type: 'empty' };
  }
}
function rawId(value: unknown, bytes: number, binary: boolean): string {
  if (!binary) return traceId(value, bytes * 2);
  const encoded = text(value);
  const buffer = protobuf.util.newBuffer(protobuf.util.base64.length(encoded));
  protobuf.util.base64.decode(encoded, buffer, 0);
  return traceId(
    Array.from(buffer)
      .map((n) => n.toString(16).padStart(2, '0'))
      .join(''),
    bytes * 2,
  );
}
function varint(reader: protobuf.Reader): bigint {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    if (reader.pos >= reader.len) throw new TraceDecodeError();
    const byte = reader.buf[reader.pos++];
    if (i === 9 && byte > 1) throw new TraceDecodeError();
    value |= BigInt(byte & 127) << BigInt(i * 7);
    if (!(byte & 128)) return value;
  }
  throw new TraceDecodeError();
}
function skipUnknownGroup(
  reader: protobuf.Reader,
  field: number,
  depth: number,
  counter: { nodes: number },
): void {
  if (depth > 64) throw new TraceDecodeError();
  while (reader.pos < reader.len) {
    if (++counter.nodes > 200000) throw new TraceDecodeError();
    const raw = varint(reader);
    if (raw > 4294967295n) throw new TraceDecodeError();
    const tag = Number(raw),
      wire = tag & 7,
      id = tag >>> 3;
    if (!id) throw new TraceDecodeError();
    if (wire === 4) {
      if (id !== field) throw new TraceDecodeError();
      return;
    }
    if (wire === 3) skipUnknownGroup(reader, id, depth + 1, counter);
    else if (wire === 0) varint(reader);
    else if (wire === 2) {
      const length = varint(reader);
      if (length > BigInt(reader.len - reader.pos)) throw new TraceDecodeError();
      reader.pos += Number(length);
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      if (size > reader.len - reader.pos) throw new TraceDecodeError();
      reader.pos += size;
    } else throw new TraceDecodeError();
  }
  throw new TraceDecodeError();
}
function validateWire(
  bytes: Uint8Array,
  type: protobuf.Type,
  depth = 0,
  counter = { nodes: 0, ignored: 0 },
): void {
  if (depth > 64 || ++counter.nodes > 200000) throw new TraceDecodeError();
  type.resolveAll();
  const reader = protobuf.Reader.create(bytes);
  while (reader.pos < reader.len) {
    const raw = varint(reader);
    if (raw > 4294967295n) throw new TraceDecodeError();
    const tag = Number(raw),
      wire = tag & 7,
      field = type.fieldsById[tag >>> 3];
    if (!(tag >>> 3)) throw new TraceDecodeError();
    if (field) {
      const expected =
        field.resolvedType instanceof protobuf.Type || ['string', 'bytes'].includes(field.type)
          ? 2
          : ['fixed64', 'sfixed64', 'double'].includes(field.type)
            ? 1
            : ['fixed32', 'sfixed32', 'float'].includes(field.type)
              ? 5
              : 0;
      if (wire !== expected) throw new TraceDecodeError();
    }
    if (wire === 2) {
      const length = varint(reader);
      if (length > BigInt(reader.len - reader.pos)) throw new TraceDecodeError();
      const end = reader.pos + Number(length);
      const value = reader.buf.subarray(reader.pos, end);
      reader.pos = end;
      if (field?.type === 'string') new TextDecoder('utf-8', { fatal: true }).decode(value);
      else if (field?.resolvedType instanceof protobuf.Type)
        validateWire(value, field.resolvedType, depth + 1, counter);
    } else if (wire === 0) {
      const value = varint(reader);
      if (field && ['uint32', 'sint32'].includes(field.type) && value > 4294967295n)
        throw new TraceDecodeError();
      if (
        field &&
        (field.type === 'int32' || field.resolvedType instanceof protobuf.Enum) &&
        value > 4294967295n &&
        value < 18446744071562067968n
      )
        throw new TraceDecodeError();
    } else if (wire === 3 && !field) {
      skipUnknownGroup(reader, tag >>> 3, depth + 1, counter);
    } else {
      if (![1, 5].includes(wire)) throw new TraceDecodeError();
      const size = wire === 1 ? 8 : 4;
      if (reader.len - reader.pos < size) throw new TraceDecodeError();
      reader.pos += size;
    }
  }
}
export interface DecodedSpan {
  service: string;
  span: SpanData;
}
export interface DecodedTraces {
  candidates: DecodedSpan[];
  rejected: number;
  total: number;
  services: string[];
  environments: unknown[];
  ignoredExtensions: number;
}
export function decodeTraces(
  body: Uint8Array,
  binary: boolean,
  limits: TraceLimits = traceDefaults,
): DecodedTraces {
  try {
    if (body.byteLength > limits.body_bytes) throw new TraceDecodeError(413);
    if (binary) validateWire(body, requestType);
    const raw = binary
      ? requestType.toObject(requestType.decode(body), {
          longs: String,
          bytes: String,
          enums: Number,
          json: true,
        })
      : parseTraceJson(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (raw === null) throw new TraceDecodeError();
    const resources = array(object(raw).resourceSpans);
    if (resources.length > limits.max_resource_spans) throw new TraceDecodeError(413);
    const result: DecodedTraces = {
      candidates: [],
      rejected: 0,
      total: 0,
      services: [],
      environments: [],
      ignoredExtensions: 0,
    };
    for (const group of resources) {
      const resourceGroup = object(group);
      const resource = object(resourceGroup.resource);
      if (resource.entityRefs !== undefined)
        result.ignoredExtensions += array(resource.entityRefs).length;
      const original = array(resource.attributes).map(object);
      const service = original.find((a) => a.key === 'service.name')?.value;
      const serviceValue = object(service).stringValue;
      if (typeof serviceValue === 'string' && serviceValue) result.services.push(serviceValue);
      const environment = original.find((a) => a.key === 'deployment.environment.name');
      if (environment) result.environments.push(object(environment.value).stringValue);
      const scopes = array(resourceGroup.scopeSpans);
      if (scopes.length > limits.max_scope_spans) throw new TraceDecodeError(413);
      for (const group of scopes) {
        const scopeGroup = object(group);
        const scope = object(scopeGroup.scope);
        for (const input of array(scopeGroup.spans)) {
          if (++result.total > limits.max_spans) throw new TraceDecodeError(413);
          try {
            const item = object(input);
            if (utf8Bytes(JSON.stringify({ resource, scope, span: item })) > limits.max_span_bytes)
              throw new Error('invalid_span');
            if (typeof serviceValue !== 'string' || !serviceValue || utf8Bytes(serviceValue) > 64)
              throw new Error('invalid_span');
            const start = decimal(item.startTimeUnixNano),
              end = decimal(item.endTimeUnixNano);
            if (start === '0' || end === '0' || BigInt(end) < BigInt(start))
              throw new Error('invalid_span');
            const spanId = rawId(item.spanId, 8, binary);
            const parent =
              item.parentSpanId === undefined ||
              item.parentSpanId === null ||
              item.parentSpanId === ''
                ? null
                : rawId(item.parentSpanId, 8, binary);
            if (parent === spanId) throw new Error('invalid_span');
            const name = text(item.name, 256);
            if (!name) throw new Error('invalid_span');
            const events = array(item.events),
              links = array(item.links);
            if (events.length > limits.max_events || links.length > limits.max_links)
              throw new Error('invalid_span');
            const counter = { nodes: 0, ignored: 0 };
            const span: SpanData = {
              trace_id: rawId(item.traceId, 16, binary),
              span_id: spanId,
              parent_span_id: parent,
              trace_state: traceState(item.traceState),
              name,
              kind: integer(item.kind, false),
              flags: integer(item.flags),
              start_time_unix_nano: start,
              end_time_unix_nano: end,
              duration_ns: (BigInt(end) - BigInt(start)).toString(),
              status: {
                code: integer(object(item.status).code, false),
                message: text(object(item.status).message, limits.max_value_bytes),
              },
              attributes: normalizeAttributes(item.attributes, limits, 0, counter),
              events: events.map((value) => {
                const event = object(value);
                const eventName = text(event.name, 256);
                if (!eventName) throw new Error('invalid_span');
                return {
                  time_unix_nano: decimal(event.timeUnixNano),
                  name: eventName,
                  attributes: normalizeAttributes(event.attributes, limits, 0, counter),
                  dropped_attributes_count: integer(event.droppedAttributesCount),
                };
              }),
              links: links.map((value) => {
                const link = object(value);
                return {
                  trace_id: rawId(link.traceId, 16, binary),
                  span_id: rawId(link.spanId, 8, binary),
                  trace_state: traceState(link.traceState),
                  flags: integer(link.flags),
                  attributes: normalizeAttributes(link.attributes, limits, 0, counter),
                  dropped_attributes_count: integer(link.droppedAttributesCount),
                };
              }),
              dropped_attributes_count: integer(item.droppedAttributesCount),
              dropped_events_count: integer(item.droppedEventsCount),
              dropped_links_count: integer(item.droppedLinksCount),
              resource: {
                attributes: normalizeAttributes(resource.attributes, limits, 0, counter),
                dropped_attributes_count: integer(resource.droppedAttributesCount),
                schema_url: text(resourceGroup.schemaUrl, limits.max_value_bytes),
              },
              scope: {
                name: text(scope.name, limits.max_value_bytes),
                version: text(scope.version, limits.max_value_bytes),
                attributes: normalizeAttributes(scope.attributes, limits, 0, counter),
                dropped_attributes_count: integer(scope.droppedAttributesCount),
                schema_url: text(scopeGroup.schemaUrl, limits.max_value_bytes),
              },
            };
            result.ignoredExtensions += counter.ignored;
            result.candidates.push({ service: serviceValue, span });
          } catch (error) {
            if (error instanceof TraceDecodeError) throw error;
            result.rejected++;
          }
        }
      }
    }
    return result;
  } catch (error) {
    throw error instanceof TraceDecodeError ? error : new TraceDecodeError();
  }
}
export function encodeTraceResponse(
  binary: boolean,
  rejected = 0,
  warning = false,
): Uint8Array | object {
  const payload =
    rejected || warning
      ? {
          partialSuccess: {
            rejectedSpans: String(rejected),
            errorMessage: rejected
              ? `${rejected} span rejected: invalid_span.`
              : 'Unsafe fields removed.',
          },
        }
      : {};
  return binary ? responseType.encode(responseType.fromObject(payload)).finish() : payload;
}
export function encodeTraceStatus(
  binary: boolean,
  code: number,
  message: string,
): Uint8Array | object {
  const payload = { code, message };
  return binary ? statusType.encode(payload).finish() : payload;
}
export function decodeTraceResponse(body: Uint8Array, binary: boolean, count: number): number {
  if (binary) validateWire(body, responseType);
  const raw = binary
    ? responseType.toObject(responseType.decode(body), { longs: String })
    : parseTraceJson(new TextDecoder('utf-8', { fatal: true }).decode(body));
  if (raw === null) throw new Error('invalid_response');
  const value = object(raw);
  if (Object.keys(value).some((key) => key !== 'partialSuccess'))
    throw new Error('invalid_response');
  if (value.partialSuccess === undefined || value.partialSuccess === null) return 0;
  const partial = object(value.partialSuccess);
  const rejected = BigInt(decimal(partial.rejectedSpans));
  if (
    rejected > BigInt(count) ||
    (partial.errorMessage !== undefined && typeof partial.errorMessage !== 'string')
  )
    throw new Error('invalid_response');
  return Number(rejected);
}
export function valueToOtlp(value: AttributeValue): ObjectValue {
  switch (value.type) {
    case 'empty':
      return {};
    case 'array':
      return { arrayValue: { values: value.value.map(valueToOtlp) } };
    case 'kvlist':
      return { kvlistValue: { values: attributesToOtlp(value.value) } };
    default:
      return { [`${value.type === 'int' ? 'int' : value.type}Value`]: value.value };
  }
}
export function attributesToOtlp(attributes: Attributes): object[] {
  return attributes.map((item) => ({ key: item.key, value: valueToOtlp(item.value) }));
}
export function spanToOtlp(span: SpanData): object {
  return {
    traceId: span.trace_id,
    spanId: span.span_id,
    parentSpanId: span.parent_span_id ?? '',
    traceState: span.trace_state,
    name: span.name,
    kind: span.kind,
    flags: span.flags,
    startTimeUnixNano: span.start_time_unix_nano,
    endTimeUnixNano: span.end_time_unix_nano,
    status: span.status,
    attributes: attributesToOtlp(span.attributes),
    droppedAttributesCount: span.dropped_attributes_count,
    droppedEventsCount: span.dropped_events_count,
    droppedLinksCount: span.dropped_links_count,
    events: span.events.map((event) => ({
      timeUnixNano: event.time_unix_nano,
      name: event.name,
      attributes: attributesToOtlp(event.attributes),
      droppedAttributesCount: event.dropped_attributes_count,
    })),
    links: span.links.map((link) => ({
      traceId: link.trace_id,
      spanId: link.span_id,
      traceState: link.trace_state,
      flags: link.flags,
      attributes: attributesToOtlp(link.attributes),
      droppedAttributesCount: link.dropped_attributes_count,
    })),
  };
}
