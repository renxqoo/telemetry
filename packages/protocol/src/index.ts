import { envelopeSchema, eventSchema, utf8Bytes } from './schema.js';
import type { Envelope, ErrorItem, Source, TelemetryEvent } from './types.js';

export * from './types.js';
export { utf8Bytes };

export class ProtocolError extends Error {
  readonly code: string;
  readonly items?: ErrorItem[];

  constructor(code: string, items?: ErrorItem[]) {
    super(code);
    this.name = 'ProtocolError';
    this.code = code;
    this.items = items;
  }
}

export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>();
  let nodes = 0;
  function encode(input: unknown, depth: number): string {
    nodes += 1;
    if (depth > 16 || nodes > 20000) throw new ProtocolError('invalid_request');
    if (input === null || typeof input === 'boolean' || typeof input === 'string')
      return JSON.stringify(input);
    if (
      typeof input === 'number' &&
      Number.isFinite(input) &&
      (!Number.isInteger(input) || Number.isSafeInteger(input))
    )
      return JSON.stringify(input);
    if (typeof input !== 'object' || input === null || ancestors.has(input))
      throw new ProtocolError('invalid_request');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        if (input.length > 20000) throw new ProtocolError('invalid_request');
        const entries: string[] = [];
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
          if (!descriptor || !('value' in descriptor)) throw new ProtocolError('invalid_request');
          entries.push(encode(descriptor.value, depth + 1));
        }
        if (Object.keys(input).length !== input.length) throw new ProtocolError('invalid_request');
        return `[${entries.join(',')}]`;
      }
      const prototype: unknown = Object.getPrototypeOf(input);
      if (prototype !== Object.prototype && prototype !== null)
        throw new ProtocolError('invalid_request');
      if (Object.getOwnPropertySymbols(input).length !== 0)
        throw new ProtocolError('invalid_request');
      const entries: string[] = [];
      for (const key of Object.keys(input).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (!descriptor || !('value' in descriptor)) throw new ProtocolError('invalid_request');
        entries.push(`${JSON.stringify(key)}:${encode(descriptor.value, depth + 1)}`);
      }
      return `{${entries.join(',')}}`;
    } finally {
      ancestors.delete(input);
    }
  }
  try {
    return encode(value, 0);
  } catch (error) {
    if (error instanceof ProtocolError) throw error;
    throw new ProtocolError('invalid_request');
  }
}

export function validateEvent(input: unknown): TelemetryEvent {
  const serialized = canonicalize(input);
  if (utf8Bytes(serialized) > 8192) throw new ProtocolError('payload_too_large');
  const result = eventSchema.safeParse(JSON.parse(serialized));
  if (!result.success) throw new ProtocolError('invalid_event');
  if (result.data.context?.span_id) {
    result.data.context.span_id = result.data.context.span_id.toLowerCase();
    result.data.context.trace_id = result.data.context.trace_id!.toLowerCase();
  }
  return result.data;
}

export function parseEnvelope(input: unknown, source: Source): Envelope {
  const serialized = canonicalize(input);
  if (utf8Bytes(serialized) > 32768) throw new ProtocolError('payload_too_large');
  const snapshot: unknown = JSON.parse(serialized);
  if (
    typeof snapshot === 'object' &&
    snapshot !== null &&
    'schema_version' in snapshot &&
    snapshot.schema_version !== '1'
  )
    throw new ProtocolError('unsupported_schema');
  const result = envelopeSchema.safeParse(snapshot);
  if (!result.success || (source !== 'browser' && source !== 'server'))
    throw new ProtocolError('invalid_request');
  const envelope = result.data;
  if ((source === 'browser') !== (envelope.project_key !== undefined))
    throw new ProtocolError('invalid_request');
  const seen = new Set<string>();
  for (const [index, event] of envelope.events.entries()) {
    if (seen.has(event.id))
      throw new ProtocolError('invalid_event', [{ index, id: event.id, reason: 'duplicate_id' }]);
    seen.add(event.id);
    if (event.context?.span_id) {
      event.context.span_id = event.context.span_id.toLowerCase();
      event.context.trace_id = event.context.trace_id!.toLowerCase();
    }
    if (utf8Bytes(canonicalize(event)) > 8192)
      throw new ProtocolError('payload_too_large', [
        { index, id: event.id, reason: 'event_too_large' },
      ]);
  }
  return envelope;
}
