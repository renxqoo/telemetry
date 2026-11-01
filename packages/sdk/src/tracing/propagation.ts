import {
  traceId,
  traceState,
  filterTraceState,
  type SpanContext,
} from '../../../protocol/src/traces/context.js';
import type { TraceStateRules } from '../../../protocol/src/traces/types.js';
export function validateContext(context: SpanContext, rules: TraceStateRules = {}): SpanContext {
  const validatedTraceId = traceId(context.traceId);
  const validatedSpanId = traceId(context.spanId, 16);
  let state = '';
  try {
    state = filterTraceState(context.traceState, rules);
  } catch {}
  return Object.freeze({
    traceId: validatedTraceId,
    spanId: validatedSpanId,
    traceFlags: context.traceFlags & 255,
    traceState: state,
    isRemote: !!context.isRemote,
  });
}
export function extractTraceContext(
  headers: Headers | Record<string, string | string[] | undefined>,
  options: { traceStateRules?: TraceStateRules } = {},
): SpanContext | undefined {
  try {
    if (
      !(headers instanceof Headers) &&
      Object.keys(headers).filter((key) => key.toLowerCase() === 'traceparent').length > 1
    )
      return;
    const get = (name: string) =>
      headers instanceof Headers
        ? headers.get(name)
        : Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
    const parent = get('traceparent');
    if (typeof parent !== 'string' || parent.includes(',')) return;
    const match = /^([a-f0-9]{2})-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})(.*)$/.exec(parent);
    if (
      !match ||
      match[1] === 'ff' ||
      (match[1] === '00' && match[5]) ||
      (match[5] && !match[5].startsWith('-'))
    )
      return;
    let state = '';
    try {
      const raw = get('tracestate');
      state = traceState(Array.isArray(raw) ? raw.join(',') : raw);
    } catch {}
    return validateContext(
      {
        traceId: match[2],
        spanId: match[3],
        traceFlags: parseInt(match[4], 16),
        traceState: state,
        isRemote: true,
      },
      options.traceStateRules,
    );
  } catch {
    return;
  }
}
export function injectTraceContext(
  context: SpanContext,
  options: { traceStateRules?: TraceStateRules } = {},
): Record<string, string> {
  try {
    const safe = validateContext(context, options.traceStateRules);
    return {
      traceparent: `00-${safe.traceId}-${safe.spanId}-${(safe.traceFlags & 1).toString(16).padStart(2, '0')}`,
      ...(safe.traceState ? { tracestate: safe.traceState } : {}),
    };
  } catch {
    return {};
  }
}
export function sampled(trace: string, rate: number): boolean {
  if (rate === 0) return false;
  if (rate === 1) return true;
  const data = new DataView(new ArrayBuffer(8));
  data.setFloat64(0, rate);
  const high = data.getUint32(0),
    low = data.getUint32(4);
  const mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low) | (1n << 52n);
  const shift = ((high >>> 20) & 0x7ff) - 1011;
  const threshold = shift >= 0 ? mantissa << BigInt(shift) : mantissa >> BigInt(-shift);
  return BigInt(`0x${trace.slice(16)}`) < threshold;
}
