export type AttributeValue =
  | { type: 'empty' }
  | { type: 'string'; value: string }
  | { type: 'bool'; value: boolean }
  | { type: 'int'; value: string }
  | { type: 'double'; value: number | 'NaN' | 'Infinity' | '-Infinity' }
  | { type: 'bytes'; value: string }
  | { type: 'array'; value: AttributeValue[] }
  | { type: 'kvlist'; value: Attribute[] };
export interface Attribute {
  key: string;
  value: AttributeValue;
}
export type Attributes = Attribute[];
export interface TraceStateRule {
  safe_values: string[];
  max_value_bytes: number;
}
export type TraceStateRules = Record<string, TraceStateRule>;
export interface TraceLimits {
  body_bytes: number;
  response_bytes: number;
  max_spans: number;
  max_resource_spans: number;
  max_scope_spans: number;
  max_attributes: number;
  max_events: number;
  max_links: number;
  max_value_depth: number;
  max_value_nodes: number;
  max_attribute_key_bytes: number;
  max_value_bytes: number;
  max_span_bytes: number;
  max_safe_span_bytes: number;
  max_concurrent: number;
}
export const traceDefaults: TraceLimits = {
  body_bytes: 4194304,
  response_bytes: 65536,
  max_spans: 512,
  max_resource_spans: 64,
  max_scope_spans: 128,
  max_attributes: 128,
  max_events: 128,
  max_links: 128,
  max_value_depth: 8,
  max_value_nodes: 4096,
  max_attribute_key_bytes: 128,
  max_value_bytes: 4096,
  max_span_bytes: 262144,
  max_safe_span_bytes: 1048576,
  max_concurrent: 10,
};
export const traceBounds = {
  maxSpans: 512,
  metadataBytes: 16384,
  maxSafeSpanBytes: 1048576,
  minPageBytes: 4194304,
  maxPageBytes: 8388608,
};
export interface SpanEvent {
  time_unix_nano: string;
  name: string;
  attributes: Attributes;
  dropped_attributes_count: number;
}
export interface SpanLink {
  trace_id: string;
  span_id: string;
  trace_state: string;
  flags: number;
  attributes: Attributes;
  dropped_attributes_count: number;
}
export interface SpanData {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  trace_state: string;
  name: string;
  kind: number;
  flags: number;
  status: { code: number; message: string };
  start_time_unix_nano: string;
  end_time_unix_nano: string;
  duration_ns: string;
  attributes: Attributes;
  events: SpanEvent[];
  links: SpanLink[];
  dropped_attributes_count: number;
  dropped_events_count: number;
  dropped_links_count: number;
  resource: { attributes: Attributes; dropped_attributes_count: number; schema_url: string };
  scope: {
    name: string;
    version: string;
    attributes: Attributes;
    dropped_attributes_count: number;
    schema_url: string;
  };
}
export interface SafeSpan extends SpanData {
  collector_dropped: Record<string, number>;
}
export interface StoredSpan extends SafeSpan {
  project_id: string;
  environment: string;
  service: string;
  received_at: string;
  retain_until: string;
  policy_version: string;
}
export interface SpanPage {
  items: StoredSpan[];
  next_cursor: string | null;
  query_id: string;
  consistency: 'primary_committed';
  range: { from: string; to: string };
  pagination: 'live-pagination';
  scope: 'authorized_services';
}
export interface AttributeRule {
  type: AttributeValue['type'];
  max_bytes?: number;
  values?: (string | number | boolean)[];
  min?: string | number;
  max?: string | number;
  finite?: boolean;
  max_items?: number;
  items?: AttributeRule;
  children?: Record<string, AttributeRule>;
}
export interface TracePolicy {
  resource: Record<string, AttributeRule>;
  scope: Record<string, AttributeRule>;
  span: Record<string, AttributeRule>;
  event: Record<string, AttributeRule>;
  link: Record<string, AttributeRule>;
  span_names: string[];
  event_names: string[];
  scope_names: string[];
  scope_versions: string[];
  service_versions: string[];
  schema_urls: string[];
  safe_messages: string[];
  tracestate_rules: TraceStateRules;
}
export const emptyTracePolicy: TracePolicy = {
  resource: {},
  scope: {},
  span: {},
  event: {},
  link: {},
  span_names: [],
  event_names: [],
  scope_names: [],
  scope_versions: [],
  service_versions: [],
  schema_urls: [],
  safe_messages: [],
  tracestate_rules: {},
};
