import type {
  ErrorData,
  ErrorFrame,
  EventContext,
  Mechanism,
  Properties,
  PropertyValue,
  TelemetryEvent,
} from '../../protocol/src/types.js';

export type CaptureEvent = Readonly<Omit<TelemetryEvent, 'properties' | 'context' | 'error'>> & {
  readonly properties: Readonly<Properties>;
  readonly context?: Readonly<EventContext>;
  readonly error?: Readonly<Omit<ErrorData, 'frames'>> & {
    readonly frames: readonly Readonly<ErrorFrame>[];
  };
};

export interface PropertyRule {
  type: 'string' | 'number' | 'boolean';
  nullable?: boolean;
  enum?: readonly PropertyValue[];
  minimum?: number;
  maximum?: number;
  maxBytes?: number;
}
export type PropertyDefinitions = Readonly<Record<string, PropertyRule>>;
export interface CaptureContext {
  requestId?: string;
  traceId?: string;
  spanId?: string;
  userId?: string;
  sessionId?: string;
  route?: string;
  operation?: string;
}
export interface Limits {
  queueCapacity: number;
  queueBytes: number;
  errorReserve: number;
  batchSize: number;
  batchBytes: number;
  flushIntervalMs: number;
  maxAttempts: number;
  retryBudgetMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  requestTimeoutMs: number;
  dedupeWindowMs: number;
  maxDeduplicatedErrors: number;
}
export interface CommonOptions {
  endpoints: readonly string[];
  environment: string;
  service: string;
  release: string;
  buildId: string;
  projectId?: string;
  events?: Readonly<Record<string, PropertyDefinitions>>;
  errorProperties?: PropertyDefinitions;
  errorCodes?: readonly string[];
  safeMessages?: Readonly<Record<string, string>>;
  sampleRate?: { event?: number; error?: number };
  eventFilter?: (this: void, event: CaptureEvent) => boolean;
  limits?: Partial<Limits>;
  transport?: typeof fetch;
}
export interface BrowserOptions extends CommonOptions {
  projectKey: string;
  captureGlobalErrors?: boolean;
}
export interface ServerOptions extends CommonOptions {
  writeToken: string;
}
export interface FlushOptions {
  timeoutMs?: number;
}
export interface FlushResult {
  acknowledgedIds: string[];
  pendingIds: string[];
  droppedCount: number;
  timedOut: boolean;
}
export interface Diagnostics {
  dropped: Readonly<Record<string, number>>;
  queuedEvents: number;
  queuedBytes: number;
  state: 'active' | 'flushing' | 'closing' | 'closed';
}
export interface TelemetryClient {
  track(this: void, name: string, properties?: Properties, context?: CaptureContext): string | null;
  captureError(this: void, error: unknown, context?: CaptureContext): string | null;
  flush(this: void, options?: FlushOptions): Promise<FlushResult>;
  close(this: void, options?: FlushOptions): Promise<FlushResult>;
  getDiagnostics(this: void): Diagnostics;
}
export interface BrowserClient extends TelemetryClient {
  setUser(this: void, id: string | null): void;
  reset(this: void): void;
}
export interface InternalClient extends TelemetryClient {
  captureWithMechanism(
    this: void,
    error: unknown,
    context: CaptureContext | undefined,
    mechanism: Mechanism,
    handled: boolean,
  ): string | null;
  setBrowserContext(this: void, userId: string | undefined, sessionId: string): void;
  onClose(this: void, cleanup: () => void): void;
  supplementWithBeacon(this: void, send: (endpoint: string, body: string) => boolean): void;
}
