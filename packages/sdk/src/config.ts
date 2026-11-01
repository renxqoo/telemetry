import { canonicalize, parseEnvelope, utf8Bytes } from '../../protocol/src/index.js';
import { projectIdSchema } from '../../protocol/src/schema.js';
import type { Envelope, Source } from '../../protocol/src/types.js';
import type {
  BrowserOptions,
  CommonOptions,
  Limits,
  PropertyDefinitions,
  ServerOptions,
} from './types.js';

export const maximumTimerDelayMs = 2 ** 31 - 1;

const defaults: Limits = {
  queueCapacity: 200,
  queueBytes: 262144,
  errorReserve: 50,
  batchSize: 20,
  batchBytes: 32768,
  flushIntervalMs: 1000,
  maxAttempts: 5,
  retryBudgetMs: 60000,
  retryBaseMs: 1000,
  retryMaxMs: 16000,
  requestTimeoutMs: 10000,
  dedupeWindowMs: 1000,
  maxDeduplicatedErrors: 200,
};
export interface Configuration {
  source: Source;
  envelope: Omit<Envelope, 'events'>;
  endpoints: readonly string[];
  token?: string;
  projectId?: string;
  events: Readonly<Record<string, PropertyDefinitions>>;
  errorProperties: PropertyDefinitions;
  errorCodes: readonly string[];
  safeMessages: Readonly<Record<string, string>>;
  sampleRate: { event: number; error: number };
  eventFilter?: CommonOptions['eventFilter'];
  limits: Limits;
  transport: typeof fetch;
}

function definitions(input: PropertyDefinitions): void {
  if (Object.keys(input).length > 32) throw new Error('Invalid property definitions');
  for (const [key, rule] of Object.entries(input)) {
    if (
      !key ||
      key === '__proto__' ||
      utf8Bytes(key) > 128 ||
      !['string', 'number', 'boolean'].includes(rule.type)
    )
      throw new Error('Invalid property definition');
    if (
      rule.maxBytes !== undefined &&
      (!Number.isSafeInteger(rule.maxBytes) || rule.maxBytes < 1 || rule.maxBytes > 256)
    )
      throw new Error('Invalid property byte limit');
    if (rule.minimum !== undefined && !Number.isFinite(rule.minimum))
      throw new Error('Invalid property minimum');
    if (
      rule.maximum !== undefined &&
      (!Number.isFinite(rule.maximum) ||
        (rule.minimum !== undefined && rule.maximum < rule.minimum))
    )
      throw new Error('Invalid property maximum');
    for (const value of rule.enum ?? []) {
      if (value !== null && typeof value !== rule.type) throw new Error('Invalid property enum');
    }
  }
}

export function configuration(
  options: CommonOptions & Partial<BrowserOptions & ServerOptions>,
  source: Source,
): Configuration {
  if (
    !Array.isArray(options.endpoints) ||
    options.endpoints.length < 1 ||
    options.endpoints.length > 8
  )
    throw new Error('Expected one to eight endpoints');
  const endpoints = [...options.endpoints];
  for (const [index, endpoint] of endpoints.entries()) {
    if (
      typeof endpoint !== 'string' ||
      utf8Bytes(endpoint) > 2048 ||
      Array.from(endpoint).some(
        (character) =>
          character === '\\' || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      (source === 'browser' && endpoint.startsWith('/') && !endpoint.startsWith('//')
        ? endpoint.includes('?') || endpoint.includes('#')
        : !/^https?:\/\//.test(endpoint))
    )
      throw new Error('Invalid telemetry endpoint');
    const relative = source === 'browser' && endpoint.startsWith('/');
    const origin = relative && typeof location !== 'undefined' ? location.origin : undefined;
    if (relative && (!origin || origin === 'null')) throw new Error('Invalid telemetry endpoint');
    const endpointBase = origin ? new URL(origin) : undefined;
    const parsed = new URL(endpoint, endpointBase);
    if (
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      parsed.search ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      (endpointBase && parsed.origin !== endpointBase.origin) ||
      (!relative &&
        parsed.protocol === 'http:' &&
        !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname))
    )
      throw new Error('Invalid telemetry endpoint');
    if (relative) endpoints[index] = parsed.href;
  }
  if (
    source === 'server' &&
    (typeof options.writeToken !== 'string' ||
      !options.writeToken ||
      /[\r\n]/.test(options.writeToken))
  )
    throw new Error('Missing write token');
  if (source === 'server' && options.projectKey !== undefined)
    throw new Error('Server clients cannot use a browser project key');
  if (source === 'browser' && options.writeToken !== undefined)
    throw new Error('Browser clients cannot use a write token');
  const envelope: Omit<Envelope, 'events'> = {
    schema_version: '1',
    environment: options.environment,
    service: options.service,
    release: options.release,
    build_id: options.buildId,
    ...(source === 'browser' ? { project_key: options.projectKey } : {}),
  };
  parseEnvelope(
    {
      ...envelope,
      events: [
        {
          id: '00000000-0000-4000-8000-000000000000',
          occurred_at: '2026-01-01T00:00:00.000Z',
          kind: 'event',
          name: 'config',
          properties: {},
        },
      ],
    },
    source,
  );
  if (options.projectId !== undefined && !projectIdSchema.safeParse(options.projectId).success)
    throw new Error('Invalid expected project ID');
  const limits = { ...defaults, ...options.limits };
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < (key === 'errorReserve' ? 0 : 1))
      throw new Error('Invalid telemetry limit');
  }
  if (
    limits.queueCapacity > 200 ||
    limits.queueBytes > 262144 ||
    limits.errorReserve > limits.queueCapacity ||
    limits.batchSize > 20 ||
    limits.batchBytes > 32768 ||
    limits.maxAttempts > 5 ||
    limits.retryBudgetMs > 60000 ||
    limits.retryMaxMs > 16000
  )
    throw new Error('Telemetry limit exceeds protocol bounds');
  const events = JSON.parse(canonicalize(options.events ?? {})) as Record<
    string,
    PropertyDefinitions
  >;
  for (const [name, schema] of Object.entries(events)) {
    if (!/^[a-z][a-z0-9_.-]*$/.test(name) || utf8Bytes(name) > 64)
      throw new Error('Invalid registered event name');
    definitions(schema);
  }
  const errorProperties = JSON.parse(
    canonicalize(options.errorProperties ?? {}),
  ) as PropertyDefinitions;
  definitions(errorProperties);
  const errorCodes = JSON.parse(canonicalize(options.errorCodes ?? [])) as string[];
  if (
    errorCodes.length > 256 ||
    errorCodes.some((code) => typeof code !== 'string' || !code || utf8Bytes(code) > 64)
  )
    throw new Error('Invalid registered error code');
  const safeMessages = JSON.parse(canonicalize(options.safeMessages ?? {})) as Record<
    string,
    string
  >;
  if (
    Object.entries(safeMessages).some(
      ([code, message]) =>
        !errorCodes.includes(code) || typeof message !== 'string' || utf8Bytes(message) > 256,
    )
  )
    throw new Error('Invalid safe message');
  const sampleRate = {
    event: options.sampleRate?.event ?? 1,
    error: options.sampleRate?.error ?? 1,
  };
  if (Object.values(sampleRate).some((rate) => !Number.isFinite(rate) || rate < 0 || rate > 1))
    throw new Error('Invalid sample rate');
  if (options.eventFilter !== undefined && typeof options.eventFilter !== 'function')
    throw new Error('Invalid event filter');
  const transport = options.transport ?? globalThis.fetch;
  if (typeof transport !== 'function' || typeof globalThis.crypto?.randomUUID !== 'function')
    throw new Error('Telemetry requires fetch and Web Crypto');
  return {
    source,
    envelope,
    endpoints,
    token: options.writeToken,
    projectId: options.projectId,
    events,
    errorProperties,
    errorCodes,
    safeMessages,
    sampleRate,
    eventFilter: options.eventFilter,
    limits,
    transport,
  };
}
