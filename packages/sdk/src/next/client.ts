'use client';

import { createBrowserClient } from '../browser.js';
import { captureAdapted } from '../adapters.js';
import type { BrowserClient, BrowserOptions, CaptureContext } from '../types.js';

export { TelemetryErrorBoundary } from '../react.js';
export { createBrowserClient } from '../browser.js';
export type { BrowserClient, BrowserOptions, CaptureContext, CaptureEvent } from '../types.js';

export function initializeNextClient(options: BrowserOptions): BrowserClient {
  return createBrowserClient({ ...options, captureGlobalErrors: true });
}

export function captureHandledResult(
  client: BrowserClient,
  error: unknown,
  context?: CaptureContext,
): string | null {
  return captureAdapted(client, error, context, 'handled_result', true);
}
