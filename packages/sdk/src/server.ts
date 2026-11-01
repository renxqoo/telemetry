import { configuration } from './config.js';
import { createClient } from './core.js';
import { registerClient } from './adapters.js';
import type { ServerOptions, TelemetryClient } from './types.js';

export type {
  ServerOptions,
  TelemetryClient,
  CaptureContext,
  CaptureEvent,
  FlushOptions,
  FlushResult,
  Diagnostics,
  PropertyDefinitions,
  PropertyRule,
} from './types.js';

export function createServerClient(options: ServerOptions): TelemetryClient {
  const internal = createClient(configuration(options, 'server'));
  const client: TelemetryClient = {
    track: internal.track,
    captureError: internal.captureError,
    flush: internal.flush,
    close: internal.close,
    getDiagnostics: internal.getDiagnostics,
  };
  registerClient(client, internal);
  return client;
}
