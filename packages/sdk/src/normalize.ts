import { utf8Bytes } from '../../protocol/src/index.js';
import type { ErrorData, EventContext, Mechanism, Properties } from '../../protocol/src/types.js';
import type { CaptureContext, PropertyDefinitions } from './types.js';

export function read(value: unknown, key: PropertyKey): unknown {
  try {
    if ((typeof value === 'object' && value !== null) || typeof value === 'function')
      return Reflect.get(value, key);
  } catch {
    return undefined;
  }
  return undefined;
}

export function clip(value: string, maximum: number): string {
  let result = '';
  let length = 0;
  for (const character of value) {
    const bytes = utf8Bytes(character);
    if (length + bytes > maximum) break;
    result += character;
    length += bytes;
  }
  return result;
}

export function safeProperties(
  input: unknown,
  definitions: PropertyDefinitions,
): Properties | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  try {
    const keys = Object.keys(input);
    if (keys.length > 32) return null;
    const result: Properties = {};
    for (const key of keys) {
      if (!Object.hasOwn(definitions, key)) return null;
      const rule = definitions[key];
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !('value' in descriptor)) return null;
      const value: unknown = descriptor.value;
      if (value === null) {
        if (!rule.nullable) return null;
        Object.defineProperty(result, key, { value: null, enumerable: true });
        continue;
      }
      if (typeof value !== rule.type) return null;
      if (typeof value === 'string' && utf8Bytes(value) > Math.min(rule.maxBytes ?? 256, 256))
        return null;
      if (
        typeof value === 'number' &&
        (!Number.isFinite(value) ||
          (Number.isInteger(value) && !Number.isSafeInteger(value)) ||
          (rule.minimum !== undefined && value < rule.minimum) ||
          (rule.maximum !== undefined && value > rule.maximum))
      )
        return null;
      if (rule.enum && !rule.enum.includes(value as string | number | boolean)) return null;
      Object.defineProperty(result, key, { value, enumerable: true });
    }
    if (utf8Bytes(JSON.stringify(result)) > 2048) return null;
    return result;
  } catch {
    return null;
  }
}

export function normalizeContext(
  input: CaptureContext | undefined,
  userId?: string,
  sessionId?: string,
): { context: EventContext; truncated: boolean } {
  const result: EventContext = {};
  let truncated = false;
  const mappings = [
    ['requestId', 'request_id', 128],
    ['traceId', 'trace_id', 128],
    ['spanId', 'span_id', 16],
    ['userId', 'user_id', 128],
    ['sessionId', 'session_id', 128],
    ['route', 'route', 256],
  ] as const;
  for (const [key, wireKey, maximum] of mappings) {
    const value =
      read(input, key) ?? (key === 'userId' ? userId : key === 'sessionId' ? sessionId : undefined);
    if (value === undefined) continue;
    if (typeof value !== 'string') throw new Error('Invalid capture context');
    const clean = key === 'route' ? value.split(/[?#]/, 1)[0] : value;
    result[wireKey] = clip(clean, maximum);
    truncated ||= result[wireKey] !== value;
  }
  if (read(input, 'spanId') !== undefined) {
    const span = read(input, 'spanId'),
      trace = read(input, 'traceId');
    if (
      typeof span !== 'string' ||
      typeof trace !== 'string' ||
      !/^[a-fA-F0-9]{16}$/.test(span) ||
      /^0+$/.test(span) ||
      !/^[a-fA-F0-9]{32}$/.test(trace) ||
      /^0+$/.test(trace)
    )
      throw new Error('Invalid span context');
    result.span_id = span.toLowerCase();
    result.trace_id = trace.toLowerCase();
  }
  return { context: result, truncated };
}

export function normalizeError(
  input: unknown,
  mechanism: Mechanism,
  handled: boolean,
  codes: readonly string[],
  messages: Readonly<Record<string, string>>,
): ErrorData {
  const name = read(input, 'name');
  const error: ErrorData = {
    type:
      typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) && utf8Bytes(name) <= 64
        ? name
        : 'Error',
    mechanism,
    handled,
    frames: [],
  };
  const code = read(input, 'code');
  if (typeof code === 'string' && codes.includes(code)) {
    error.code = code;
    if (Object.hasOwn(messages, code)) error.safe_message = messages[code];
  }
  return error;
}
