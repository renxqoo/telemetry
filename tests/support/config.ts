import { traceDefaults, emptyTracePolicy } from '../../packages/protocol/src/traces/types.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Configuration } from '../../packages/application/src/config.js';
export function createTestConfiguration(origin = 'http://127.0.0.1:4317'): {
  configuration: Configuration;
  writeToken: string;
  readToken: string;
  cursorSecret: string;
  projectId: string;
} {
  const writeSecret = randomBytes(32).toString('base64url');
  const readSecret = randomBytes(32).toString('base64url');
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const now = Date.now();
  const projectId = randomUUID();
  return {
    writeToken: `writer.${writeSecret}`,
    readToken: `reader.${readSecret}`,
    cursorSecret: randomBytes(32).toString('base64url'),
    projectId,
    configuration: {
      schema_version: '2',
      revision: 1,
      created_at: new Date(now - 1000).toISOString(),
      not_before: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 86400000).toISOString(),
      profile: 'development',
      endpoints: [origin],
      trusted_proxies: [],
      limits: {
        traces: { ...traceDefaults, max_concurrent: 1 },
        trace_queries: { page_bytes: 4194304 },
        max_concurrent: 20,
        latency_buckets_ms: [10, 50, 100, 250, 500, 1000, 2000, 3000],
        request_timeout_ms: 3000,
        body_timeout_ms: 750,
        shutdown_timeout_ms: 15000,
      },
      retention: { trace_days: 30, event_days: 30, receipt_days: 7, audit_days: 90 },
      projects: [
        {
          id: projectId,
          environments: ['test'],
          services: ['web', 'api'],
          events: {
            smoke_event: { action: { type: 'string', nullable: false } },
            load_event: {
              p0: { type: 'string', nullable: false },
              p1: { type: 'string', nullable: false },
              p2: { type: 'string', nullable: false },
              p3: { type: 'string', nullable: false },
            },
          },
          error_policy: {
            properties: {
              operation: { type: 'string', nullable: false, values: ['smoke', 'load'] },
            },
            codes: [],
            safe_messages: [],
          },
          browser_keys: [
            { key: 'pub_smoke', environment: 'test', service: 'web', origins: [origin] },
          ],
          service_accounts: [
            {
              key_id: 'writer',
              secret_sha256: digest(writeSecret),
              environments: ['test'],
              services: ['api', 'web'],
              permissions: ['write:server'],
            },
            {
              key_id: 'reader',
              secret_sha256: digest(readSecret),
              environments: ['test'],
              services: ['api', 'web'],
              permissions: ['read:events', 'read:errors'],
            },
          ],
          trace_policy: structuredClone(emptyTracePolicy),
          trace_quota: { spans_per_second: 2000, burst: 4000 },
          quota: { events_per_second: 2000, burst: 4000 },
        },
      ],
    },
  };
}
