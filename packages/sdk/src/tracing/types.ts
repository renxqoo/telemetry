import type {
  Attributes,
  AttributeValue,
  SpanLink,
  TraceStateRules,
} from '../../../protocol/src/traces/types.js';
import type { SpanContext } from '../../../protocol/src/traces/context.js';
export type { Attributes, AttributeValue, SpanContext, TraceStateRules };
export interface TracerLimits {
  queueCapacity: number;
  queueBytes: number;
  batchSize: number;
  batchBytes: number;
  flushIntervalMs: number;
  maxAttempts: number;
  retryBudgetMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  requestTimeoutMs: number;
  responseBytes: number;
  maxActiveSpans: number;
  recordingBytes: number;
  resourceBytes: number;
  maxSpanBytes: number;
  maxAttributes: number;
  maxEvents: number;
  maxLinks: number;
  maxValueDepth: number;
  maxValueNodes: number;
  maxKeyBytes: number;
  maxValueBytes: number;
  maxNameBytes: number;
}
export const tracerDefaults: TracerLimits = {
  queueCapacity: 2048,
  queueBytes: 8388608,
  batchSize: 256,
  batchBytes: 1048576,
  flushIntervalMs: 1000,
  maxAttempts: 5,
  retryBudgetMs: 30000,
  retryBaseMs: 200,
  retryMaxMs: 5000,
  requestTimeoutMs: 5000,
  responseBytes: 65536,
  maxActiveSpans: 1024,
  recordingBytes: 8388608,
  resourceBytes: 65536,
  maxSpanBytes: 262144,
  maxAttributes: 128,
  maxEvents: 128,
  maxLinks: 128,
  maxValueDepth: 8,
  maxValueNodes: 4096,
  maxKeyBytes: 128,
  maxValueBytes: 4096,
  maxNameBytes: 256,
};
export interface TracerOptions {
  endpoints: readonly string[];
  environment: string;
  service: string;
  writeToken: string;
  sampleRate: number;
  resourceAttributes?: Attributes;
  scope?: { name: string; version?: string; attributes?: Attributes };
  traceStateRules?: TraceStateRules;
  limits?: Partial<TracerLimits>;
  transport?: typeof fetch;
}
export interface StartSpanOptions {
  name: string;
  kind?: number;
  parent?: SpanContext | null;
  attributes?: Attributes;
  links?: SpanLink[];
}
export interface SpanHandle {
  readonly context: SpanContext;
  setAttribute(this: void, key: string, value: AttributeValue): void;
  addEvent(this: void, name: string, attributes?: Attributes): void;
  setStatus(this: void, code: number, message?: string): void;
  end(this: void): void;
}
export interface TraceFlushResult {
  readonly confirmedSpans: number;
  readonly rejectedSpans: number;
  readonly unconfirmedSpans: number;
  readonly pendingSpans: number;
  readonly droppedSpans: number;
  readonly timedOut: boolean;
}
export interface Tracer {
  startSpan(this: void, options: StartSpanOptions): SpanHandle;
  withSpan<T>(this: void, options: StartSpanOptions, callback: (span: SpanHandle) => T): T;
  currentContext(this: void): SpanContext | undefined;
  flush(this: void, options?: { timeoutMs?: number }): Promise<TraceFlushResult>;
  close(this: void, options?: { timeoutMs?: number }): Promise<TraceFlushResult>;
  getDiagnostics(this: void): {
    closed: boolean;
    activeSpans: number;
    recordingBytes: number;
    queuedSpans: number;
    queuedBytes: number;
    counts: Readonly<Record<string, number>>;
  };
}
