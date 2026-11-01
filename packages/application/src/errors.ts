import type { ErrorItem } from '../../protocol/src/types.js';
const definitions: Record<string, { status: number; message: string; retryable: boolean }> = {
  unsupported_media: { status: 415, message: 'Unsupported media type.', retryable: false },
  invalid_request: { status: 400, message: 'Invalid request.', retryable: false },
  unsupported_schema: { status: 400, message: 'Unsupported schema version.', retryable: false },
  unauthenticated: { status: 401, message: 'Authentication required.', retryable: false },
  forbidden: { status: 403, message: 'Scope not permitted.', retryable: false },
  not_found: { status: 404, message: 'Record not found.', retryable: false },
  invalid_cursor: { status: 400, message: 'Invalid cursor.', retryable: false },
  event_conflict: {
    status: 409,
    message: 'Event identity conflicts with an existing payload.',
    retryable: false,
  },
  event_expired: { status: 410, message: 'Event retention has expired.', retryable: false },
  payload_too_large: { status: 413, message: 'Payload exceeds protocol limits.', retryable: false },
  invalid_event: { status: 422, message: 'Event does not match project policy.', retryable: false },
  quota_exceeded: { status: 429, message: 'Per-instance project quota exceeded.', retryable: true },
  overloaded: { status: 503, message: 'Service capacity unavailable.', retryable: true },
  storage_unavailable: { status: 503, message: 'Storage unavailable.', retryable: true },
  confirmation_unknown: {
    status: 503,
    message: 'Commit confirmation unavailable.',
    retryable: true,
  },
  audit_unavailable: { status: 503, message: 'Audit barrier unavailable.', retryable: true },
};
export class HttpError extends Error {
  constructor(
    public code: string,
    public outcome: 'not_committed' | 'unknown' = 'not_committed',
    public items?: ErrorItem[],
    public retryAfterMs?: number,
  ) {
    super(code);
    this.name = 'HttpError';
  }
}
export function errorDefinition(code: string) {
  return definitions[code] ?? definitions.storage_unavailable!;
}
