import * as z from 'zod/mini';

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function text(maximum: number, minimum = 0) {
  return z
    .string()
    .check(z.refine((value) => utf8Bytes(value) >= minimum && utf8Bytes(value) <= maximum));
}

export const uuidSchema = z
  .string()
  .check(z.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/));
export const projectIdSchema = z.uuid();
export const timestampSchema = z
  .string()
  .check(
    z.refine(
      (value) =>
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
        Number.isFinite(Date.parse(value)) &&
        new Date(value).toISOString() === value,
    ),
  );
const safeNumber = z
  .number()
  .check(
    z.refine(
      (value) =>
        Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)),
    ),
  );
const position = z.number().check(z.refine(Number.isSafeInteger));
const propertiesSchema = z
  .pipe(
    z
      .unknown()
      .check(
        z.refine(
          (value) =>
            typeof value === 'object' && value !== null && !Object.hasOwn(value, '__proto__'),
        ),
      ),
    z.record(z.string(), z.union([text(256), safeNumber, z.boolean(), z.null()])),
  )
  .check(
    z.refine(
      (value) => Object.keys(value).length <= 32 && utf8Bytes(JSON.stringify(value)) <= 2048,
    ),
  );
const contextSchema = z
  .strictObject({
    request_id: z.optional(text(128)),
    trace_id: z.optional(text(128)),
    span_id: z.optional(text(16, 16)),
    user_id: z.optional(text(128)),
    session_id: z.optional(text(128)),
    route: z.optional(text(256)),
  })
  .check(
    z.refine(
      (value) =>
        value.span_id === undefined ||
        (typeof value.trace_id === 'string' &&
          /^[a-fA-F0-9]{32}$/.test(value.trace_id) &&
          !/^0+$/.test(value.trace_id) &&
          /^[a-fA-F0-9]{16}$/.test(value.span_id) &&
          !/^0+$/.test(value.span_id)),
    ),
  );
const frameSchema = z.strictObject({
  file: text(512, 1),
  function: z.optional(text(128)),
  line: z.optional(position.check(z.gte(1))),
  column: z.optional(position.check(z.gte(0))),
});
const errorSchema = z.strictObject({
  type: text(64, 1).check(z.regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)),
  mechanism: z.enum([
    'manual',
    'window_error',
    'unhandled_rejection',
    'react_boundary',
    'next_request',
    'handled_result',
  ]),
  handled: z.boolean(),
  code: z.optional(text(64, 1)),
  safe_message: z.optional(text(256)),
  frames: z.array(frameSchema).check(z.maxLength(30)),
});
export const eventSchema = z
  .strictObject({
    id: uuidSchema,
    occurred_at: timestampSchema,
    kind: z.enum(['event', 'error']),
    name: text(64, 1).check(z.regex(/^[a-z][a-z0-9_.-]*$/)),
    properties: propertiesSchema,
    context: z.optional(contextSchema),
    truncated: z.optional(z.boolean()),
    sample_rate: z.optional(z.number().check(z.gt(0), z.lte(1))),
    error: z.optional(errorSchema),
  })
  .check(
    z.refine((value) =>
      value.kind === 'error' ? value.error !== undefined : value.error === undefined,
    ),
  );

export const envelopeSchema = z.strictObject({
  schema_version: z.literal('1'),
  project_key: z.optional(text(128, 1)),
  environment: text(32, 1),
  service: text(64, 1),
  release: text(128, 1),
  build_id: text(128, 1),
  events: z.array(eventSchema).check(z.minLength(1), z.maxLength(20)),
});
