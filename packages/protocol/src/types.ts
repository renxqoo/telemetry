export type Source = 'browser' | 'server';
export type EventKind = 'event' | 'error';
export type PropertyValue = string | number | boolean | null;
export type Properties = Record<string, PropertyValue>;
export type Mechanism =
  | 'manual'
  | 'window_error'
  | 'unhandled_rejection'
  | 'react_boundary'
  | 'next_request'
  | 'handled_result';
export interface ErrorFrame {
  file: string;
  function?: string;
  line?: number;
  column?: number;
}
export interface ErrorData {
  type: string;
  mechanism: Mechanism;
  handled: boolean;
  code?: string;
  safe_message?: string;
  frames: ErrorFrame[];
}
export interface EventContext {
  request_id?: string;
  trace_id?: string;
  span_id?: string;
  user_id?: string;
  session_id?: string;
  route?: string;
}
export interface TelemetryEvent {
  id: string;
  occurred_at: string;
  kind: EventKind;
  name: string;
  properties: Properties;
  context?: EventContext;
  truncated?: boolean;
  sample_rate?: number;
  error?: ErrorData;
}
export interface Envelope {
  schema_version: '1';
  project_key?: string;
  environment: string;
  service: string;
  release: string;
  build_id: string;
  events: TelemetryEvent[];
}
export interface Acknowledgement {
  id: string;
  status: 'stored' | 'already_present';
  received_at: string;
  retain_until: string;
}
export interface IngestResponse {
  request_id: string;
  project_id: string;
  environment: string;
  source: Source;
  service: string;
  acknowledged: Acknowledgement[];
}
export interface ErrorItem {
  index: number;
  id?: string;
  reason: string;
}
export interface ApiErrorBody {
  request_id: string;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    retry_after_ms?: number;
    outcome: 'not_committed' | 'unknown';
    items?: ErrorItem[];
  };
}
export interface StoredEvent extends TelemetryEvent {
  clock_skew_ms: number;
  project_id: string;
  environment: string;
  service: string;
  source: Source;
  release: string;
  build_id: string;
  received_at: string;
  retain_until: string;
  policy_version: string;
  fingerprint?: string;
}
export interface EventPage {
  items: StoredEvent[];
  next_cursor: string | null;
  query_id: string;
  consistency: 'primary_committed';
  range: { from: string; to: string };
  pagination: 'live-pagination';
}
