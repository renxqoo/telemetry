import type { TraceStateRules } from './types.js';
export interface SpanContext {
  readonly traceId: string;
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceState: string;
  readonly isRemote: boolean;
}
export function traceId(value: unknown, length = 32): string {
  if (
    typeof value !== 'string' ||
    !new RegExp(`^[0-9a-fA-F]{${length}}$`).test(value) ||
    /^0+$/.test(value)
  )
    throw new Error('invalid_id');
  return value.toLowerCase();
}
export function traceState(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 512) throw new Error('invalid_tracestate');
  const members = value.split(',');
  const keys = new Set<string>();
  if (members.length > 32) throw new Error('invalid_tracestate');
  return members
    .map((member) => {
      member = member.replace(/^[ \t]+|[ \t]+$/g, '');
      const match =
        /^([a-z][a-z0-9_*/-]{0,255}|[a-z0-9][a-z0-9_*/-]{0,240}@[a-z][a-z0-9_*/-]{0,13})=([\x20-\x2b\x2d-\x3c\x3e-\x7e]{1,256})$/.exec(
          member,
        );
      if (!match || keys.has(match[1]) || match[2].endsWith(' '))
        throw new Error('invalid_tracestate');
      keys.add(match[1]);
      return `${match[1]}=${match[2]}`;
    })
    .join(',');
}
export function filterTraceState(value: string, rules: TraceStateRules = {}): string {
  return traceState(value)
    .split(',')
    .filter((member) => {
      if (!member) return false;
      const split = member.indexOf('=');
      const key = member.slice(0, split),
        item = member.slice(split + 1);
      return (
        Object.hasOwn(rules, key) &&
        rules[key].safe_values.includes(item) &&
        new TextEncoder().encode(item).length <= rules[key].max_value_bytes
      );
    })
    .join(',');
}
