import * as z from 'zod/mini';
import { canonicalize, utf8Bytes } from '../../protocol/src/index.js';
import { projectIdSchema, timestampSchema, uuidSchema } from '../../protocol/src/schema.js';
import type { ApiErrorBody, Envelope, IngestResponse, Source } from '../../protocol/src/types.js';

const acknowledgementSchema = z
  .strictObject({
    id: uuidSchema,
    status: z.enum(['stored', 'already_present']),
    received_at: timestampSchema,
    retain_until: timestampSchema,
  })
  .check(z.refine((value) => value.retain_until > value.received_at));
const responseSchema = z.strictObject({
  request_id: uuidSchema,
  project_id: projectIdSchema,
  environment: z.string(),
  source: z.enum(['browser', 'server']),
  service: z.string(),
  acknowledged: z.array(acknowledgementSchema).check(z.maxLength(20)),
});
const errorSchema = z.strictObject({
  request_id: uuidSchema,
  error: z.strictObject({
    code: z.string().check(z.maxLength(64)),
    message: z.string().check(z.maxLength(256)),
    retryable: z.boolean(),
    retry_after_ms: z.optional(z.number().check(z.gte(0), z.refine(Number.isSafeInteger))),
    outcome: z.enum(['not_committed', 'unknown']),
    items: z.optional(
      z
        .array(
          z.strictObject({
            index: z.number().check(z.gte(0), z.refine(Number.isSafeInteger)),
            id: z.optional(uuidSchema),
            reason: z.string().check(z.maxLength(64)),
          }),
        )
        .check(z.maxLength(20)),
    ),
  }),
});
export interface AttemptResult {
  status: number;
  acknowledgement?: IngestResponse;
  error?: ApiErrorBody;
  retryAfterMs?: number;
}

async function readBody(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error('Missing response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let body = '';
  const onAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65536) throw new Error('Oversized response');
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return JSON.parse(body);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

export async function sendAttempt(
  transport: typeof fetch,
  endpoint: string,
  envelope: Envelope,
  source: Source,
  token: string | undefined,
  projectId: string | undefined,
  controller: AbortController,
  onRateLimit: (retryAfterMs: number) => void,
): Promise<AttemptResult> {
  const response = await transport(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: canonicalize(envelope),
    signal: controller.signal,
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
  });
  const retryAfter = response.headers.get('retry-after');
  let retryAfterMs = 0;
  if (retryAfter !== null && utf8Bytes(retryAfter) < 128) {
    const seconds = /^\d+(?:\.\d+)?$/.test(retryAfter)
      ? Number(retryAfter) * 1000
      : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(seconds)) retryAfterMs = Math.max(0, seconds);
  }
  const quotaResult: AttemptResult = { status: 429, retryAfterMs };
  if (response.status === 429) onRateLimit(retryAfterMs);
  let payload: unknown;
  try {
    payload = await readBody(response, controller.signal);
  } catch (error) {
    if (response.status === 429) return quotaResult;
    throw error;
  }
  if (response.status === 200) {
    const result = responseSchema.safeParse(payload);
    if (!result.success) return { status: 0 };
    const data = result.data;
    const ids = new Set(envelope.events.map((event) => event.id));
    if (
      data.environment !== envelope.environment ||
      data.service !== envelope.service ||
      data.source !== source ||
      (projectId !== undefined && data.project_id !== projectId) ||
      data.acknowledged.length !== ids.size
    )
      return { status: 0 };
    for (const item of data.acknowledged) {
      if (!ids.delete(item.id)) return { status: 0 };
    }
    return { status: 200, acknowledgement: data };
  }
  const result = errorSchema.safeParse(payload);
  if (!result.success)
    return response.status === 429
      ? quotaResult
      : { status: response.status >= 500 ? response.status : 0 };
  const data = result.data;
  const seen = new Set<number>();
  for (const item of data.error.items ?? []) {
    const event = envelope.events[item.index];
    if (!event || seen.has(item.index) || (item.id !== undefined && item.id !== event.id))
      return response.status === 429 ? quotaResult : { status: 0 };
    seen.add(item.index);
  }
  retryAfterMs = Math.max(retryAfterMs, data.error.retry_after_ms ?? 0);
  return { status: response.status, error: data, retryAfterMs };
}
