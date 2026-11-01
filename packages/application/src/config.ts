import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TracePolicy } from '../../protocol/src/traces/types.js';
import { traceLimitsSchema, tracePolicySchema } from './trace-config.js';
import { projectIdSchema } from '../../protocol/src/schema.js';

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]*$/)
  .max(64);
const instant = z.iso.datetime({ precision: 3 });
const strings = z
  .array(z.string().min(1))
  .min(1)
  .refine((v) => new Set(v).size === v.length);
const property = z
  .strictObject({
    type: z.enum(['string', 'number', 'boolean']),
    nullable: z.boolean(),
    values: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .superRefine((rule, context) => {
    if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max)
      context.addIssue({ code: 'custom', message: 'Invalid property range' });
    if (rule.values?.some((value) => typeof value !== rule.type))
      context.addIssue({ code: 'custom', message: 'Invalid property enum' });
    if (rule.type !== 'number' && (rule.min !== undefined || rule.max !== undefined))
      context.addIssue({ code: 'custom', message: 'Numeric range requires number' });
  });
const propertyMap = z.record(identifier, property);
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return url.origin === value && ['https:', 'http:'].includes(url.protocol);
});
const account = z.strictObject({
  key_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  secret_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  environments: strings,
  services: strings,
  permissions: z
    .array(z.enum(['write:server', 'write:traces', 'read:events', 'read:errors', 'read:traces']))
    .min(1),
});
const project = z.strictObject({
  id: projectIdSchema,
  environments: strings.refine((items) => items.every((item) => Buffer.byteLength(item) <= 32)),
  services: strings.refine((items) => items.every((item) => Buffer.byteLength(item) <= 64)),
  events: z.record(identifier, propertyMap),
  error_policy: z.strictObject({
    properties: propertyMap,
    codes: z.array(identifier),
    safe_messages: z.array(z.string().max(256)),
  }),
  browser_keys: z.array(
    z.strictObject({
      key: z.string().min(1).max(128),
      environment: z.string(),
      service: z.string(),
      origins: z.array(origin).min(1),
    }),
  ),
  service_accounts: z.array(account),
  trace_policy: tracePolicySchema as z.ZodType<TracePolicy>,
  trace_quota: z
    .strictObject({
      spans_per_second: z.number().positive().finite(),
      burst: z.number().int().min(512),
    })
    .default({ spans_per_second: 2000, burst: 4000 }),
  quota: z.strictObject({
    events_per_second: z.number().positive().finite(),
    burst: z.number().int().min(20),
  }),
});
const schema = z
  .strictObject({
    schema_version: z.literal('2'),
    revision: z.number().int().positive().safe(),
    created_at: instant,
    not_before: instant,
    expires_at: instant,
    profile: z.enum(['development', 'ha']),
    endpoints: z.array(z.url()).min(1),
    trusted_proxies: z.array(z.string()),
    limits: z.strictObject({
      traces: traceLimitsSchema,
      trace_queries: z
        .strictObject({ page_bytes: z.number().int().min(4194304).max(8388608).default(4194304) })
        .default({ page_bytes: 4194304 }),
      max_concurrent: z.number().int().positive(),
      request_timeout_ms: z.number().int().positive(),
      body_timeout_ms: z.number().int().positive(),
      shutdown_timeout_ms: z.number().int().positive(),
      latency_buckets_ms: z
        .array(z.number().positive().finite())
        .min(1)
        .max(32)
        .refine((values) =>
          values.every((value, index) => index === 0 || value > values[index - 1]!),
        ),
    }),
    retention: z.strictObject({
      trace_days: z.number().int().min(1).max(3660).default(30),
      event_days: z.number().int().min(1).max(3660),
      receipt_days: z.number().int().min(1).max(3660),
      audit_days: z.number().int().min(1).max(3660),
    }),
    projects: z.array(project).min(1),
  })
  .superRefine((value, context) => {
    const issue = () =>
      context.addIssue({ code: 'custom', message: 'Invalid configuration constraints' });
    if (
      Date.parse(value.created_at) > Date.parse(value.not_before) ||
      Date.parse(value.not_before) >= Date.parse(value.expires_at)
    )
      issue();
    if (value.limits.body_timeout_ms > value.limits.request_timeout_ms) issue();
    if (value.profile === 'ha' && value.endpoints.some((url) => new URL(url).protocol !== 'https:'))
      issue();
    if (value.limits.traces.max_concurrent > value.limits.max_concurrent) issue();
    if (value.projects.some((project) => project.trace_quota.burst < value.limits.traces.max_spans))
      issue();
    const ids = new Set<string>();
    const keys = new Set<string>();
    const accounts = new Set<string>();
    for (const item of value.projects) {
      if (ids.has(item.id)) issue();
      ids.add(item.id);
      for (const key of item.browser_keys) {
        if (
          keys.has(key.key) ||
          !item.environments.includes(key.environment) ||
          !item.services.includes(key.service)
        )
          issue();
        keys.add(key.key);
      }
      for (const key of item.service_accounts) {
        if (
          accounts.has(key.key_id) ||
          key.environments.some((env) => !item.environments.includes(env)) ||
          key.services.some((service) => !item.services.includes(service)) ||
          (key.permissions.some((permission) => permission.startsWith('write:')) &&
            key.permissions.some((permission) => permission.startsWith('read:'))) ||
          new Set(key.permissions).size !== key.permissions.length
        )
          issue();
        accounts.add(key.key_id);
      }
    }
  });
export type Configuration = z.infer<typeof schema>;
export type ProjectConfiguration = Configuration['projects'][number];
export type PropertyRule = z.infer<typeof property>;
export interface ActiveConfig {
  value: Configuration;
  digest: string;
}
export interface ConfigManager {
  current(): ActiveConfig;
  update(input: unknown): ActiveConfig;
  status(): { active_revision: number; digest: string; expires_at: string; valid: boolean };
}
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
}
export function createConfigManager(
  input: unknown,
  options: { now?: () => number } = {},
): ConfigManager {
  const now = options.now ?? Date.now;
  function parse(value: unknown): ActiveConfig {
    const result = schema.parse(value);
    if (Date.parse(result.not_before) > now() || Date.parse(result.expires_at) <= now())
      throw new Error('Configuration outside validity window');
    freeze(result);
    return Object.freeze({
      value: result,
      digest: createHash('sha256').update(JSON.stringify(result)).digest('hex'),
    });
  }
  let active = parse(input);
  return {
    current() {
      if (
        Date.parse(active.value.expires_at) <= now() ||
        Date.parse(active.value.not_before) > now()
      )
        throw new Error('Configuration expired');
      return active;
    },
    update(value) {
      const next = parse(value);
      if (
        next.value.revision <= active.value.revision ||
        Date.parse(next.value.created_at) < Date.parse(active.value.created_at)
      )
        throw new Error('Configuration rollback refused');
      active = next;
      return next;
    },
    status() {
      return {
        active_revision: active.value.revision,
        digest: active.digest,
        expires_at: active.value.expires_at,
        valid:
          Date.parse(active.value.expires_at) > now() &&
          Date.parse(active.value.not_before) <= now(),
      };
    },
  };
}

export function convertConfigurationV1(input: unknown): Configuration {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (input as { schema_version?: unknown }).schema_version !== '1'
  )
    throw new Error('Expected schema 1 configuration');
  const value = structuredClone(input) as Record<string, unknown>;
  const limits = value.limits as Record<string, unknown>;
  const projects = value.projects as Record<string, unknown>[];
  if (
    !limits ||
    !Array.isArray(projects) ||
    'traces' in limits ||
    'trace_queries' in limits ||
    'trace_days' in (value.retention as object) ||
    projects.some(
      (project) =>
        'trace_policy' in project ||
        'trace_quota' in project ||
        (project.service_accounts as { permissions: string[] }[]).some((account) =>
          account.permissions.some(
            (permission) => !['write:server', 'read:events', 'read:errors'].includes(permission),
          ),
        ),
    )
  )
    throw new Error('Invalid schema 1 configuration');
  return schema.parse({
    ...value,
    schema_version: '2',
    limits: { ...limits, traces: { max_concurrent: Math.min(10, Number(limits.max_concurrent)) } },
  });
}
