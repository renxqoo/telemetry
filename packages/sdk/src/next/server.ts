import type { Instrumentation } from 'next';
import { captureAdapted } from '../adapters.js';
import type { CaptureContext, FlushOptions, TelemetryClient } from '../types.js';

export { createServerClient } from '../server.js';
export type { ServerOptions, TelemetryClient, CaptureContext, CaptureEvent } from '../types.js';

export function createOnRequestError(
  client: TelemetryClient,
  options: FlushOptions = {},
): Instrumentation.onRequestError {
  return async (error, _request, context) => {
    try {
      const id = captureAdapted(client, error, { route: context.routePath }, 'next_request', false);
      if (id) await client.flush({ timeoutMs: options.timeoutMs ?? 2000 });
    } catch {
      return;
    }
  };
}

export function captureHandledResult(
  client: TelemetryClient,
  error: unknown,
  context?: CaptureContext,
): string | null {
  return captureAdapted(client, error, context, 'handled_result', true);
}
