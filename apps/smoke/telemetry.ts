'use client';
import { initializeNextClient } from '@oneaster/telemetry/next/client';
import type { BrowserClient } from '../../packages/sdk/src/types.js';
let client: BrowserClient | undefined;
export function getSmokeClient(): BrowserClient {
  if (!client)
    client = initializeNextClient({
      endpoints: ['/api/ingest'],
      projectKey: 'pub_smoke',
      environment: 'test',
      service: 'web',
      release: 'smoke-1',
      buildId: 'smoke-build',
      events: { smoke_event: { action: { type: 'string' } } },
      errorProperties: { operation: { type: 'string', enum: ['smoke'] } },
      limits: { flushIntervalMs: 100 },
    });
  return client;
}
