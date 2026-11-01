import { read } from './normalize.js';
import type { CaptureContext, InternalClient, TelemetryClient } from './types.js';
import type { Mechanism } from '../../protocol/src/types.js';

const clientsKey = Symbol.for('oneaster.telemetry.adapters.v1');
const adapterGlobal = globalThis as typeof globalThis & {
  [clientsKey]?: WeakMap<TelemetryClient, InternalClient>;
};
const clients = (adapterGlobal[clientsKey] ??= new WeakMap<TelemetryClient, InternalClient>());

export function registerClient(client: TelemetryClient, internal: InternalClient): void {
  clients.set(client, internal);
}

export function expectedControlFlow(error: unknown): boolean {
  if (read(error, 'name') === 'AbortError') return true;
  const digest = read(error, 'digest');
  if (typeof digest !== 'string') return false;
  if (/^NEXT_HTTP_ERROR_FALLBACK;(401|403|404)$/.test(digest)) return true;
  const parts = digest.split(';');
  return (
    parts[0] === 'NEXT_REDIRECT' &&
    ['push', 'replace'].includes(parts[1]) &&
    ['303', '307', '308'].includes(parts.at(-2) ?? '')
  );
}

export function captureAdapted(
  client: TelemetryClient,
  error: unknown,
  context: CaptureContext | undefined,
  mechanism: Mechanism,
  handled: boolean,
): string | null {
  if (expectedControlFlow(error)) return null;
  return clients.get(client)?.captureWithMechanism(error, context, mechanism, handled) ?? null;
}
