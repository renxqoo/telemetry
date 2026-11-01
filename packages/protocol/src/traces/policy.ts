import { utf8Bytes } from '../index.js';
import { filterTraceState } from './context.js';
import type {
  AttributeRule,
  Attributes,
  AttributeValue,
  SafeSpan,
  SpanData,
  TracePolicy,
} from './types.js';
export function ruleAllows(value: AttributeValue, rule: AttributeRule, depth = 0): boolean {
  if (depth > 8 || value.type !== rule.type) return false;
  if (value.type === 'empty') return true;
  if (value.type === 'array')
    return (
      !!rule.items &&
      value.value.length <= (rule.max_items ?? 0) &&
      value.value.every((v) => ruleAllows(v, rule.items!, depth + 1))
    );
  if (value.type === 'kvlist')
    return (
      !!rule.children &&
      value.value.every(
        (v) =>
          Object.hasOwn(rule.children!, v.key) &&
          ruleAllows(v.value, rule.children![v.key], depth + 1),
      )
    );
  if (rule.values && !rule.values.includes(value.value)) return false;
  if (value.type === 'string' || value.type === 'bytes')
    return (
      rule.max_bytes !== undefined &&
      (value.type === 'string'
        ? utf8Bytes(value.value)
        : Math.floor((value.value.length * 3) / 4) -
          (value.value.endsWith('==') ? 2 : value.value.endsWith('=') ? 1 : 0)) <= rule.max_bytes
    );
  if (value.type === 'int')
    return (
      (rule.min === undefined || BigInt(value.value) >= BigInt(rule.min)) &&
      (rule.max === undefined || BigInt(value.value) <= BigInt(rule.max))
    );
  if (value.type === 'double')
    return (
      !(rule.finite && typeof value.value !== 'number') &&
      (rule.min === undefined ||
        (typeof value.value === 'number' && value.value >= Number(rule.min))) &&
      (rule.max === undefined ||
        (typeof value.value === 'number' && value.value <= Number(rule.max)))
    );
  return true;
}
export function projectSpan(span: SpanData, policy: TracePolicy): SafeSpan {
  const result: SafeSpan = { ...structuredClone(span), collector_dropped: {} };
  const drops = result.collector_dropped;
  function count(key: string, amount = 1) {
    if (amount > 0) drops[key] = (drops[key] ?? 0) + amount;
  }
  function attributes(
    input: Attributes,
    rules: Record<string, AttributeRule>,
    level: string,
  ): Attributes {
    return input.filter((item) => {
      const keep = Object.hasOwn(rules, item.key) && ruleAllows(item.value, rules[item.key]);
      if (!keep) count(`${level}_attributes`);
      return keep;
    });
  }
  function allowed(value: string, values: string[], fallback = ''): string {
    if (!value || values.includes(value)) return value;
    count('strings');
    return fallback;
  }
  function state(value: string): string {
    const safe = filterTraceState(value, policy.tracestate_rules);
    count(
      'tracestate',
      (value ? value.split(',').length : 0) - (safe ? safe.split(',').length : 0),
    );
    return safe;
  }
  result.attributes = attributes(result.attributes, policy.span, 'span');
  result.resource.attributes = result.resource.attributes.filter((item) => {
    if (['service.name', 'deployment.environment.name'].includes(item.key)) return true;
    if (item.key === 'service.version') {
      const keep =
        item.value.type === 'string' && policy.service_versions.includes(item.value.value);
      if (!keep) count('resource_attributes');
      return keep;
    }
    const keep =
      Object.hasOwn(policy.resource, item.key) && ruleAllows(item.value, policy.resource[item.key]);
    if (!keep) count('resource_attributes');
    return keep;
  });
  result.resource.schema_url = allowed(result.resource.schema_url, policy.schema_urls);
  result.scope.schema_url = allowed(result.scope.schema_url, policy.schema_urls);
  result.scope.name = allowed(result.scope.name, policy.scope_names);
  result.scope.version = allowed(result.scope.version, policy.scope_versions);
  result.scope.attributes = attributes(result.scope.attributes, policy.scope, 'scope');
  result.name = allowed(result.name, policy.span_names, 'span');
  result.status.message = allowed(result.status.message, policy.safe_messages);
  result.trace_state = state(result.trace_state);
  for (const event of result.events) {
    event.name = allowed(event.name, policy.event_names, 'event');
    event.attributes = attributes(event.attributes, policy.event, 'event');
  }
  for (const link of result.links) {
    link.trace_state = state(link.trace_state);
    link.attributes = attributes(link.attributes, policy.link, 'link');
  }
  return result;
}
export function safeSpanBytes(span: SafeSpan): number {
  return utf8Bytes(JSON.stringify(span));
}
