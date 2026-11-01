import { z } from 'zod';
import { decimal } from '../../protocol/src/traces/codec.js';
import {
  traceDefaults,
  emptyTracePolicy,
  type AttributeRule,
  type TracePolicy,
} from '../../protocol/src/traces/types.js';
import { traceState } from '../../protocol/src/traces/context.js';
const strings = z.array(z.string().max(4096)).max(1024);
const attribute: z.ZodType<AttributeRule> = z.lazy(() =>
  z
    .strictObject({
      type: z.enum(['empty', 'string', 'bool', 'int', 'double', 'bytes', 'array', 'kvlist']),
      max_bytes: z.number().int().min(0).max(4096).optional(),
      values: z
        .array(z.union([z.string(), z.number(), z.boolean()]))
        .max(256)
        .optional(),
      min: z.union([z.string(), z.number()]).optional(),
      max: z.union([z.string(), z.number()]).optional(),
      finite: z.boolean().optional(),
      max_items: z.number().int().min(0).max(4096).optional(),
      items: attribute.optional(),
      children: z.record(z.string().max(128), attribute).optional(),
    })
    .superRefine((rule, ctx) => {
      const fail = () => ctx.addIssue({ code: 'custom', message: 'Invalid trace attribute rule' });
      if (['string', 'bytes'].includes(rule.type) && rule.max_bytes === undefined) fail();
      if (rule.type === 'array' && (!rule.items || rule.max_items === undefined)) fail();
      if (rule.type === 'kvlist' && !rule.children) fail();
      try {
        if (rule.type === 'int') {
          for (const n of [rule.min, rule.max])
            if (n !== undefined && (typeof n !== 'string' || decimal(n, true) !== n)) fail();
          if (
            rule.min !== undefined &&
            rule.max !== undefined &&
            BigInt(rule.min) > BigInt(rule.max)
          )
            fail();
        } else if (rule.type === 'double') {
          for (const n of [rule.min, rule.max])
            if (n !== undefined && (typeof n !== 'number' || !Number.isFinite(n))) fail();
          if (
            rule.min !== undefined &&
            rule.max !== undefined &&
            Number(rule.min) > Number(rule.max)
          )
            fail();
        } else if (rule.min !== undefined || rule.max !== undefined) fail();
      } catch {
        fail();
      }
      if (
        rule.values?.some(
          (v) =>
            typeof v !==
            (rule.type === 'bool' ? 'boolean' : rule.type === 'double' ? 'number' : 'string'),
        )
      )
        fail();
    }),
);
const attributes = z.record(z.string().max(128), attribute);
export const tracePolicySchema: z.ZodType<TracePolicy> = z
  .strictObject({
    resource: attributes,
    scope: attributes,
    span: attributes,
    event: attributes,
    link: attributes,
    span_names: strings,
    event_names: strings,
    scope_names: strings,
    scope_versions: strings,
    service_versions: strings,
    schema_urls: strings,
    safe_messages: strings,
    tracestate_rules: z
      .record(
        z.string(),
        z.strictObject({
          safe_values: z.array(z.string().min(1)).min(1),
          max_value_bytes: z.number().int().min(1).max(256),
        }),
      )
      .superRefine((rules, ctx) => {
        try {
          for (const [key, rule] of Object.entries(rules))
            for (const value of rule.safe_values) traceState(`${key}=${value}`);
        } catch {
          ctx.addIssue({ code: 'custom', message: 'Invalid tracestate rule' });
        }
      }),
  })
  .default(emptyTracePolicy);
export const traceLimitsSchema = z
  .strictObject(
    Object.fromEntries(
      Object.entries(traceDefaults).map(([key, value]) => [
        key,
        z
          .number()
          .int()
          .positive()
          .max(
            key === 'max_spans'
              ? 512
              : key === 'max_safe_span_bytes'
                ? 1048576
                : key === 'body_bytes'
                  ? 16777216
                  : key === 'max_concurrent'
                    ? 65536
                    : Math.max(value, 65536),
          )
          .default(value),
      ]),
    ) as { [K in keyof typeof traceDefaults]: z.ZodDefault<z.ZodNumber> },
  )
  .default(traceDefaults);
