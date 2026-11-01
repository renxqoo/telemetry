import type { Instrumentation } from 'next';
import { createServerClient, createOnRequestError } from '@oneaster/telemetry/next/server';
import type { TelemetryClient } from '../../packages/sdk/src/types.js';
let client: TelemetryClient | undefined;
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  const endpoint = process.env.TELEMETRY_SMOKE_COLLECTOR;
  const token = process.env.TELEMETRY_SMOKE_WRITE_TOKEN;
  if (!endpoint || !token) return;
  client ??= createServerClient({
    endpoints: [`${endpoint}/v1/ingest/server`],
    writeToken: token,
    environment: 'test',
    service: 'api',
    release: 'smoke-1',
    buildId: 'smoke-build',
  });
  await createOnRequestError(client, { timeoutMs: 2000 })(error, request, context);
};
