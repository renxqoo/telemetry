import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { createServerClient } from '../packages/sdk/src/server.js';
const endpoint = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash &&
    url.pathname === '/' &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  );
});
const schema = z.strictObject({
  collector_endpoints: z.array(endpoint).min(1).max(8),
  query_endpoints: z.array(endpoint).min(1).max(8),
  project_id: z.uuid(),
  environment: z.string().min(1),
  service: z.string().min(1),
  release: z.string().min(1),
  build_id: z.string().min(1),
  event_name: z.string().regex(/^[a-z][a-z0-9_.-]*$/),
  timeouts: z
    .strictObject({
      total_ms: z.number().int().positive().max(60000),
      write_ms: z.number().int().positive(),
    })
    .refine((value) => value.write_ms < value.total_ms)
    .default({ total_ms: 5000, write_ms: 3000 }),
});
export async function runProbe(
  input: unknown,
  secrets: { writeToken: string; readToken: string },
): Promise<{ success: boolean; durationMs: number }> {
  const configuration = schema.parse(input);
  const started = performance.now();
  const deadline = started + configuration.timeouts.total_ms;
  const writeDeadline = started + configuration.timeouts.write_ms;
  let confirmedId: string | undefined;
  for (const [index, base] of configuration.collector_endpoints.entries()) {
    const remaining = writeDeadline - performance.now();
    if (remaining <= 0) break;
    const attemptMs = Math.max(
      1,
      Math.floor(remaining / (configuration.collector_endpoints.length - index)),
    );
    const client = createServerClient({
      endpoints: [new URL('/v1/ingest/server', base).href],
      writeToken: secrets.writeToken,
      projectId: configuration.project_id,
      environment: configuration.environment,
      service: configuration.service,
      release: configuration.release,
      buildId: configuration.build_id,
      events: { [configuration.event_name]: {} },
      limits: { maxAttempts: 1, requestTimeoutMs: attemptMs, retryBudgetMs: attemptMs },
    });
    try {
      const id = client.track(configuration.event_name, {});
      if (id && (await client.flush({ timeoutMs: attemptMs })).acknowledgedIds.includes(id)) {
        confirmedId = id;
        break;
      }
    } finally {
      await client.close({ timeoutMs: 1 });
    }
  }
  if (confirmedId) {
    for (const [index, base] of configuration.query_endpoints.entries()) {
      const left = deadline - performance.now();
      if (left <= 0) break;
      const attemptMs = Math.max(
        1,
        Math.floor(left / (configuration.query_endpoints.length - index)),
      );
      const signal = AbortSignal.timeout(attemptMs);
      try {
        const url = new URL(`/v1/events/server/${confirmedId}`, base);
        url.searchParams.set('environment', configuration.environment);
        url.searchParams.set('service', configuration.service);
        const response = await fetch(url, {
          headers: { authorization: `Bearer ${secrets.readToken}` },
          signal,
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          continue;
        }
        const reader = response.body?.getReader();
        if (!reader) continue;
        const abort = () => {
          void reader.cancel().catch(() => undefined);
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        let body = '';
        let bytes = 0;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 32768) throw new Error('Invalid probe response');
            body += decoder.decode(part.value, { stream: true });
          }
          body += decoder.decode();
        } finally {
          signal.removeEventListener('abort', abort);
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
        const event = JSON.parse(body) as {
          id?: string;
          project_id?: string;
          environment?: string;
          service?: string;
          source?: string;
        };
        if (
          !signal.aborted &&
          event.id === confirmedId &&
          event.project_id === configuration.project_id &&
          event.environment === configuration.environment &&
          event.service === configuration.service &&
          event.source === 'server'
        )
          return { success: true, durationMs: performance.now() - started };
      } catch {
        continue;
      }
    }
  }
  return { success: false, durationMs: performance.now() - started };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let result = { success: false, durationMs: 0 };
  try {
    const path = process.argv[2];
    const writeToken = process.env.TELEMETRY_PROBE_WRITE_TOKEN,
      readToken = process.env.TELEMETRY_PROBE_READ_TOKEN;
    if (!path || !writeToken || !readToken) throw new Error('Probe configuration required');
    result = await runProbe(JSON.parse(await readFile(path, 'utf8')), { writeToken, readToken });
  } catch {
    process.exitCode = 1;
  }
  process.stdout.write(
    `telemetry_probe_success ${Number(result.success)}\ntelemetry_probe_duration_seconds ${result.durationMs / 1000}\n`,
  );
  if (!result.success) process.exitCode = 1;
}
