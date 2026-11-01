import { configuration } from './config.js';
import { createClient } from './core.js';
import { captureAdapted, registerClient } from './adapters.js';
import { utf8Bytes } from '../../protocol/src/index.js';
import type { BrowserClient, BrowserOptions, InternalClient } from './types.js';

export type {
  BrowserClient,
  BrowserOptions,
  CaptureContext,
  CaptureEvent,
  FlushOptions,
  FlushResult,
  Diagnostics,
  PropertyDefinitions,
  PropertyRule,
} from './types.js';

interface Subscription {
  captureGlobalErrors: boolean;
  capture: (error: unknown, mechanism: 'window_error' | 'unhandled_rejection') => void;
  visibility: () => void;
}
interface ListenerRegistry {
  groups: Map<string, Subscription[]>;
  remove: () => void;
}
const registryKey = Symbol.for('oneaster.telemetry.browser.listeners.v1');

function listen(
  client: BrowserClient,
  internal: InternalClient,
  key: string,
  captureGlobalErrors: boolean,
): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const target = globalThis as typeof globalThis & { [registryKey]?: ListenerRegistry };
  let registry = target[registryKey];
  if (!registry) {
    const groups = new Map<string, Subscription[]>();
    function dispatch(error: unknown, mechanism: 'window_error' | 'unhandled_rejection'): void {
      for (const subscriptions of groups.values()) {
        const current = subscriptions.findLast((subscription) => subscription.captureGlobalErrors);
        current?.capture(error, mechanism);
      }
    }
    const onError = (event: ErrorEvent) => dispatch(event.error, 'window_error');
    const onRejection = (event: PromiseRejectionEvent) =>
      dispatch(event.reason, 'unhandled_rejection');
    const onPageHide = () => {
      for (const subscriptions of groups.values()) subscriptions.at(-1)?.visibility();
    };
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') onPageHide();
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    window.addEventListener('pagehide', onPageHide);
    if (typeof document !== 'undefined')
      document.addEventListener('visibilitychange', onVisibility);
    registry = {
      groups,
      remove() {
        window.removeEventListener('error', onError);
        window.removeEventListener('unhandledrejection', onRejection);
        window.removeEventListener('pagehide', onPageHide);
        if (typeof document !== 'undefined')
          document.removeEventListener('visibilitychange', onVisibility);
        delete target[registryKey];
      },
    };
    target[registryKey] = registry;
  }
  const subscription: Subscription = {
    captureGlobalErrors,
    capture: (error, mechanism) => {
      captureAdapted(client, error, undefined, mechanism, false);
    },
    visibility: () => {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        internal.supplementWithBeacon((endpoint, body) =>
          navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' })),
        );
      }
    },
  };
  const subscriptions = registry.groups.get(key) ?? [];
  subscriptions.push(subscription);
  registry.groups.set(key, subscriptions);
  return () => {
    const index = subscriptions.indexOf(subscription);
    if (index >= 0) subscriptions.splice(index, 1);
    if (subscriptions.length === 0) registry.groups.delete(key);
    if (registry.groups.size === 0) registry.remove();
  };
}

export function createBrowserClient(options: BrowserOptions): BrowserClient {
  const config = configuration(options, 'browser');
  const internal = createClient(config);
  let userId: string | undefined;
  let sessionId = crypto.randomUUID();
  internal.setBrowserContext(userId, sessionId);
  const client: BrowserClient = {
    track: internal.track,
    captureError: internal.captureError,
    flush: internal.flush,
    close: internal.close,
    getDiagnostics: internal.getDiagnostics,
    setUser(id) {
      if (id !== null && (typeof id !== 'string' || utf8Bytes(id) > 128))
        throw new Error('Invalid telemetry user ID');
      userId = id ?? undefined;
      internal.setBrowserContext(userId, sessionId);
    },
    reset() {
      userId = undefined;
      sessionId = crypto.randomUUID();
      internal.setBrowserContext(userId, sessionId);
    },
  };
  registerClient(client, internal);
  internal.onClose(
    listen(
      client,
      internal,
      JSON.stringify([options.projectKey, options.environment, options.service]),
      options.captureGlobalErrors !== false,
    ),
  );
  return client;
}
