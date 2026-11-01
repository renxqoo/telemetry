import type {
  Acknowledgement,
  ErrorItem,
  EventKind,
  EventPage,
  Source,
  StoredEvent,
  TelemetryEvent,
} from '../../protocol/src/types.js';
export interface OperationOptions {
  signal: AbortSignal;
  deadlineAtMs: number;
}
export interface StoreCapabilities {
  driver: string;
  contractVersion: 2;
  durability: 'single_node' | 'fault_domain_sync';
  idempotency: 'strict_receipt' | 'windowed';
  readConsistency: 'primary_committed' | 'eventual';
  auditedReadBarrier: boolean;
}
export interface CanonicalBatch {
  scope: {
    projectId: string;
    environment: string;
    service: string;
    source: Source;
    release: string;
    buildId: string;
    policyVersion: string;
    retentionDays: number;
    receiptDays: number;
  };
  events: { payload: TelemetryEvent; digest: string; fingerprint?: string }[];
}
export interface WriteReceipt {
  acknowledged: Acknowledgement[];
}
export interface QueryAccess {
  projectId: string;
  environment: string;
  allowedServices: string[];
  allowedKinds: EventKind[];
  actorKeyId: string;
  requestId: string;
  queryKind: 'events' | 'errors' | 'event' | 'error';
  queryDigest: string;
  auditRetentionDays: number;
}
export interface PageKey {
  received_at: string;
  service: string;
  source: Source;
  id: string;
}
export interface EventQuery {
  from: string;
  to: string;
  limit: number;
  source?: Source;
  name?: string;
  service?: string;
  release?: string;
  request_id?: string;
  trace_id?: string;
  span_id?: string;
  user_id?: string;
  code?: string;
  fingerprint?: string;
  after?: PageKey;
}
export interface EventKey {
  environment: string;
  service: string;
  source: Source;
  id: string;
}
export type EventLookup =
  | { status: 'found'; event: StoredEvent }
  | { status: 'expired' }
  | { status: 'absent' };
export interface StoreReadiness {
  ready: boolean;
  reason?: string;
}
export interface TelemetryStore {
  capabilities: StoreCapabilities;
  traces: TraceStore;
  writer: { appendBatch(batch: CanonicalBatch, options: OperationOptions): Promise<WriteReceipt> };
  reader: {
    findEvents(
      query: EventQuery,
      access: QueryAccess,
      options: OperationOptions,
    ): Promise<EventPage>;
    findErrors(
      query: EventQuery,
      access: QueryAccess,
      options: OperationOptions,
    ): Promise<EventPage>;
    getEvent(key: EventKey, access: QueryAccess, options: OperationOptions): Promise<EventLookup>;
  };
  readiness(options: OperationOptions): Promise<StoreReadiness>;
  close(options: OperationOptions): Promise<void>;
}
export class StoreError extends Error {
  constructor(
    public code: string,
    public outcome: 'not_committed' | 'unknown' = 'not_committed',
    public items?: ErrorItem[],
  ) {
    super(code);
    this.name = 'StoreError';
  }
}
export function requireCapabilities(
  capabilities: StoreCapabilities,
  profile: 'development' | 'ha',
): void {
  if (
    profile === 'ha' &&
    (capabilities.durability !== 'fault_domain_sync' ||
      capabilities.idempotency !== 'strict_receipt' ||
      capabilities.readConsistency !== 'primary_committed' ||
      !capabilities.auditedReadBarrier)
  )
    throw new Error('HA storage capabilities required');
}

export interface SpanPageKey {
  received_at: string;
  trace_id: string;
  span_id: string;
}
export interface SpanQuery {
  from: string;
  to: string;
  limit: number;
  pageBytes: number;
  service?: string;
  trace_id?: string;
  span_id?: string;
  name?: string;
  status_code?: number;
  min_duration_ns?: string;
  max_duration_ns?: string;
  after?: SpanPageKey;
}
export interface TraceQueryAccess extends Omit<QueryAccess, 'queryKind' | 'allowedKinds'> {
  queryKind: 'spans' | 'trace';
}
export interface CanonicalSpans {
  projectId: string;
  environment: string;
  allowedServices: string[];
  policyVersion: string;
  retentionDays: number;
  receiptDays: number;
  spans: {
    service: string;
    payload: import('../../protocol/src/traces/types.js').SafeSpan;
    digest: string;
  }[];
}
export interface TraceStore {
  appendSpans(
    batch: CanonicalSpans,
    options: OperationOptions,
  ): Promise<{ rejectedSpans: number; duplicateSpans?: number; conflictSpans?: number }>;
  findSpans(
    query: SpanQuery,
    access: TraceQueryAccess,
    options: OperationOptions,
  ): Promise<import('../../protocol/src/traces/types.js').SpanPage>;
}
