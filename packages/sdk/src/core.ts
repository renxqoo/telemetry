import { canonicalize, utf8Bytes, validateEvent } from '../../protocol/src/index.js';
import type { Envelope, Mechanism, Properties, TelemetryEvent } from '../../protocol/src/types.js';
import { maximumTimerDelayMs, type Configuration } from './config.js';
import { normalizeContext, normalizeError, read, safeProperties } from './normalize.js';
import { sendAttempt, type AttemptResult } from './transport.js';
import type { CaptureContext, FlushOptions, FlushResult, InternalClient } from './types.js';

interface Entry {
  event: TelemetryEvent;
  bytes: number;
  attempts: number;
  firstSent?: number;
  readyAt: number;
  inFlight: boolean;
  regrouped: boolean;
  split: boolean;
  batchLimit: number;
}
interface Observer {
  acknowledged: Set<string>;
  wake: () => void;
}

export function createClient(config: Configuration): InternalClient {
  const queue: Entry[] = [];
  const dropped: Record<string, number> = {};
  const observers = new Set<Observer>();
  const cleanups = new Set<() => void>();
  let totalDropped = 0;
  let queuedBytes = 0;
  let state: 'active' | 'flushing' | 'closing' | 'closed' = 'active';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let controller: AbortController | undefined;
  let closePromise: Promise<FlushResult> | undefined;
  let endpoint = 0;
  let cooldownUntil = 0;
  let expectedProject = config.projectId;
  let userId: string | undefined;
  let sessionId: string | undefined;
  let authorizationFailed = false;
  let deduplication = new WeakMap<object, { id: string; time: number }>();
  let deduplicatedCount = 0;
  let filtering = false;
  const envelopeOverhead = utf8Bytes(canonicalize({ ...config.envelope, events: [] }));

  function closed(): boolean {
    return state === 'closed';
  }

  function notify(): void {
    for (const observer of observers) observer.wake();
  }

  function count(reason: string): void {
    dropped[reason] = (dropped[reason] ?? 0) + 1;
    totalDropped += 1;
  }

  function remove(entry: Entry, reason?: string): void {
    const index = queue.indexOf(entry);
    if (index < 0) return;
    queue.splice(index, 1);
    queuedBytes -= entry.bytes;
    if (reason) count(reason);
    notify();
  }

  function schedule(delay?: number): void {
    if (state === 'closed' || running || queue.length === 0) return;
    if (timer !== undefined) clearTimeout(timer);
    const now = performance.now();
    const readyAt = Math.max(
      cooldownUntil,
      delay === undefined ? Math.min(...queue.map((entry) => entry.readyAt)) : now + delay,
    );
    const expiry = Math.min(
      ...queue.map((entry) =>
        entry.firstSent === undefined ? Infinity : entry.firstSent + config.limits.retryBudgetMs,
      ),
    );
    const wait = Math.min(maximumTimerDelayMs, Math.max(0, Math.min(readyAt, expiry) - now));
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, wait);
    if (typeof timer === 'object' && 'unref' in timer) timer.unref();
  }

  function envelope(entries: Entry[]): Envelope {
    return { ...config.envelope, events: entries.map((entry) => entry.event) };
  }

  function select(): Entry[] {
    const now = performance.now();
    for (const entry of queue.slice()) {
      if (entry.firstSent !== undefined && now - entry.firstSent >= config.limits.retryBudgetMs)
        remove(entry, 'retry_budget');
    }
    if (now < cooldownUntil) return [];
    const eligible = queue
      .filter((entry) => entry.readyAt <= now)
      .sort(
        (left, right) => Number(right.event.kind === 'error') - Number(left.event.kind === 'error'),
      );
    const selected: Entry[] = [];
    let batchLimit = config.limits.batchSize;
    let batchBytes = envelopeOverhead;
    for (const entry of eligible) {
      const limit = Math.min(batchLimit, entry.batchLimit);
      if (selected.length >= limit) break;
      const candidateBytes = batchBytes + entry.bytes + (selected.length > 0 ? 1 : 0);
      if (candidateBytes > config.limits.batchBytes) {
        if (selected.length === 0) remove(entry, 'payload_too_large');
        continue;
      }
      selected.push(entry);
      batchBytes = candidateBytes;
      batchLimit = limit;
    }
    return selected;
  }

  async function attempt(entries: Entry[]): Promise<AttemptResult> {
    const currentController = new AbortController();
    controller = currentController;
    const now = performance.now();
    for (const entry of entries) {
      entry.attempts += 1;
      entry.firstSent ??= now;
      entry.inFlight = true;
    }
    const budget = Math.min(
      config.limits.requestTimeoutMs,
      ...entries.map((entry) => config.limits.retryBudgetMs - (now - (entry.firstSent ?? now))),
    );
    let requestTimer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let abortResult: AttemptResult = { status: 0 };
    const cutoff = new Promise<AttemptResult>((resolve) => {
      onAbort = () => resolve(abortResult);
      currentController.signal.addEventListener('abort', onAbort, { once: true });
      requestTimer = setTimeout(() => currentController.abort(), Math.max(1, budget));
    });
    try {
      return await Promise.race([
        sendAttempt(
          config.transport,
          config.endpoints[endpoint],
          envelope(entries),
          config.source,
          config.token,
          expectedProject,
          currentController,
          (retryAfterMs) => {
            abortResult = { status: 429, retryAfterMs };
          },
        ).catch(() => abortResult),
        cutoff,
      ]);
    } finally {
      if (requestTimer !== undefined) clearTimeout(requestTimer);
      if (onAbort) currentController.signal.removeEventListener('abort', onAbort);
      if (controller === currentController) controller = undefined;
      for (const entry of entries) entry.inFlight = false;
    }
  }

  function retry(entry: Entry, retryAfterMs = 0): number {
    const now = performance.now();
    const delay = Math.max(
      retryAfterMs,
      Math.min(config.limits.retryMaxMs, config.limits.retryBaseMs * 2 ** (entry.attempts - 1)) *
        (0.5 + Math.random() * 0.5),
    );
    const readyAt = now + Math.ceil(delay);
    if (entry.attempts >= config.limits.maxAttempts) remove(entry, 'retry_attempts');
    else if (readyAt - (entry.firstSent ?? now) >= config.limits.retryBudgetMs)
      remove(entry, 'retry_budget');
    else entry.readyAt = readyAt;
    return readyAt;
  }

  function handle(entries: Entry[], result: AttemptResult): void {
    if (state === 'closed') return;
    if (result.acknowledgement) {
      expectedProject ??= result.acknowledgement.project_id;
      for (const entry of entries) {
        for (const observer of observers) observer.acknowledged.add(entry.event.id);
        remove(entry);
      }
      return;
    }
    if (result.status === 401 || result.status === 403) {
      authorizationFailed = true;
      for (const entry of queue.slice()) remove(entry, 'authorization');
      return;
    }
    if (result.status === 400) {
      for (const entry of entries) remove(entry, 'invalid_request');
      return;
    }
    if ([409, 410, 422].includes(result.status)) {
      const items = result.error?.error.items;
      if (!items?.length) {
        for (const entry of entries)
          remove(entry, result.status === 410 ? 'event_expired' : 'invalid_response_items');
        return;
      }
      const invalid = new Set(items.map((item) => item.index));
      for (const [index, entry] of entries.entries()) {
        if (invalid.has(index))
          remove(
            entry,
            result.status === 409
              ? 'event_conflict'
              : result.status === 410
                ? 'event_expired'
                : 'invalid_event',
          );
        else if (entry.regrouped) remove(entry, 'regroup_limit');
        else {
          entry.regrouped = true;
          retry(entry);
        }
      }
      return;
    }
    if (result.status === 413) {
      for (const entry of entries) {
        if (entries.length === 1 || entry.split) remove(entry, 'payload_too_large');
        else {
          entry.split = true;
          entry.batchLimit = Math.ceil(entries.length / 2);
          retry(entry);
        }
      }
      return;
    }
    if (result.status !== 429) endpoint = (endpoint + 1) % config.endpoints.length;
    for (const entry of entries) {
      const readyAt = retry(entry, result.status === 429 ? result.retryAfterMs : 0);
      if (result.status === 429) cooldownUntil = Math.max(cooldownUntil, readyAt);
    }
  }

  async function drain(): Promise<void> {
    if (running || state === 'closed') return;
    running = true;
    if (state === 'active') state = 'flushing';
    try {
      while (!closed()) {
        const selected = select();
        if (selected.length === 0) break;
        const result = await attempt(selected);
        handle(selected, result);
      }
    } finally {
      running = false;
      if (state === 'flushing') state = 'active';
      notify();
      schedule();
    }
  }

  function enqueue(event: TelemetryEvent): string | null {
    const serialized = canonicalize(event);
    const snapshot = validateEvent(JSON.parse(serialized));
    if (snapshot.error) {
      for (const frame of snapshot.error.frames) Object.freeze(frame);
      Object.freeze(snapshot.error.frames);
    }
    for (const value of Object.values(snapshot))
      if (value && typeof value === 'object') Object.freeze(value);
    Object.freeze(snapshot);
    const eventFilter = config.eventFilter;
    if (eventFilter) {
      let decision: unknown;
      filtering = true;
      try {
        decision = eventFilter(snapshot);
      } catch {
        count('filter_failure');
        return null;
      } finally {
        filtering = false;
      }
      if (decision !== true) {
        if (decision !== null && typeof decision === 'object')
          void Promise.resolve(decision).catch(() => undefined);
        count(decision === false ? 'filtered' : 'filter_failure');
        return null;
      }
      if (!allowed()) return null;
    }
    const bytes = utf8Bytes(serialized);
    const ordinaryLimit = config.limits.queueCapacity - config.limits.errorReserve;
    if (
      snapshot.kind === 'event' &&
      queue.filter((entry) => entry.event.kind === 'event').length >= ordinaryLimit
    ) {
      count('error_reserve');
      return null;
    }
    while (
      queue.length >= config.limits.queueCapacity ||
      queuedBytes + bytes > config.limits.queueBytes
    ) {
      const evictable = queue.find((entry) => !entry.inFlight && entry.event.kind === 'event');
      if (snapshot.kind !== 'error' || !evictable) {
        count('queue_capacity');
        return null;
      }
      remove(evictable, 'evicted_event');
    }
    queue.push({
      event: snapshot,
      bytes,
      attempts: 0,
      readyAt: performance.now() + (snapshot.kind === 'error' ? 0 : config.limits.flushIntervalMs),
      inFlight: false,
      regrouped: false,
      split: false,
      batchLimit: config.limits.batchSize,
    });
    queuedBytes += bytes;
    notify();
    schedule();
    return snapshot.id;
  }

  function allowed(): boolean {
    if (filtering) {
      count('filter_failure');
      return false;
    }
    if (state === 'closing' || state === 'closed' || authorizationFailed) {
      count(state === 'closed' || state === 'closing' ? 'closed' : 'authorization');
      return false;
    }
    return true;
  }

  function capture(
    error: unknown,
    context: CaptureContext | undefined,
    mechanism: Mechanism,
    handled: boolean,
  ): string | null {
    try {
      if (!allowed()) return null;
      const object =
        (typeof error === 'object' && error !== null) || typeof error === 'function'
          ? (error as object)
          : undefined;
      if (object) {
        const previous = deduplication.get(object);
        if (previous && performance.now() - previous.time <= config.limits.dedupeWindowMs)
          return previous.id;
      }
      const rate = config.sampleRate.error;
      if (rate < 1 && Math.random() >= rate) {
        count('sampled');
        return null;
      }
      const normalized = normalizeError(
        error,
        mechanism,
        handled,
        config.errorCodes,
        config.safeMessages,
      );
      const normalizedContext = normalizeContext(context, userId, sessionId);
      const operation = read(context, 'operation');
      const properties = safeProperties(
        operation === undefined ? {} : { operation },
        config.errorProperties,
      );
      if (!properties) {
        count('invalid_properties');
        return null;
      }
      const event: TelemetryEvent = {
        id: crypto.randomUUID(),
        occurred_at: new Date().toISOString(),
        kind: 'error',
        name: 'runtime.error',
        properties,
        context: normalizedContext.context,
        error: normalized,
        ...(rate < 1 ? { sample_rate: rate } : {}),
        ...(normalizedContext.truncated ? { truncated: true } : {}),
      };
      const id = enqueue(event);
      if (id && object) {
        if (deduplicatedCount >= config.limits.maxDeduplicatedErrors) {
          deduplication = new WeakMap();
          deduplicatedCount = 0;
        }
        deduplication.set(object, { id, time: performance.now() });
        deduplicatedCount += 1;
      }
      return id;
    } catch {
      count('capture_failure');
      return null;
    }
  }

  async function flush(options: FlushOptions = {}): Promise<FlushResult> {
    const timeout = options.timeoutMs ?? 5000;
    const timeoutMs = Number.isFinite(timeout) && timeout >= 0 ? Math.min(timeout, 60000) : 5000;
    const deadline = performance.now() + timeoutMs;
    const before = totalDropped;
    const observer: Observer = { acknowledged: new Set(), wake: () => undefined };
    observers.add(observer);
    let timedOut = false;
    try {
      for (const entry of queue) if (entry.attempts === 0) entry.readyAt = performance.now();
      schedule(0);
      while (queue.length > 0 && state !== 'closed') {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          timedOut = true;
          break;
        }
        await new Promise<void>((resolve) => {
          let wakeTimer: ReturnType<typeof setTimeout> | undefined;
          observer.wake = () => {
            if (wakeTimer !== undefined) clearTimeout(wakeTimer);
            observer.wake = () => undefined;
            resolve();
          };
          wakeTimer = setTimeout(observer.wake, remaining);
        });
      }
      return {
        acknowledgedIds: [...observer.acknowledged],
        pendingIds: queue.map((entry) => entry.event.id),
        droppedCount: totalDropped - before,
        timedOut,
      };
    } finally {
      observers.delete(observer);
    }
  }

  return {
    track(name: string, properties: Properties = {}, context?: CaptureContext): string | null {
      try {
        if (!allowed()) return null;
        if (typeof name !== 'string' || !Object.hasOwn(config.events, name)) {
          count('unregistered_event');
          return null;
        }
        const rate = config.sampleRate.event;
        if (rate < 1 && Math.random() >= rate) {
          count('sampled');
          return null;
        }
        const sanitized = safeProperties(properties, config.events[name]);
        if (!sanitized) {
          count('invalid_properties');
          return null;
        }
        const normalized = normalizeContext(context, userId, sessionId);
        return enqueue({
          id: crypto.randomUUID(),
          occurred_at: new Date().toISOString(),
          kind: 'event',
          name,
          properties: sanitized,
          context: normalized.context,
          ...(normalized.truncated ? { truncated: true } : {}),
          ...(rate < 1 ? { sample_rate: rate } : {}),
        });
      } catch {
        count('capture_failure');
        return null;
      }
    },
    captureError(error, context) {
      return capture(error, context, 'manual', true);
    },
    captureWithMechanism: capture,
    flush,
    close(options = {}) {
      closePromise ??= (async () => {
        state = 'closing';
        for (const cleanup of cleanups) {
          try {
            cleanup();
          } catch {}
        }
        cleanups.clear();
        const before = totalDropped;
        const result = await flush(options);
        for (const entry of queue.slice()) remove(entry, 'close_unconfirmed');
        state = 'closed';
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        controller?.abort();
        controller = undefined;
        deduplication = new WeakMap();
        userId = undefined;
        sessionId = undefined;
        config.token = undefined;
        config.events = {};
        config.errorProperties = {};
        config.errorCodes = [];
        config.safeMessages = {};
        config.eventFilter = undefined;
        result.droppedCount = totalDropped - before;
        notify();
        return result;
      })();
      return closePromise;
    },
    getDiagnostics() {
      return { dropped: { ...dropped }, queuedEvents: queue.length, queuedBytes, state };
    },
    setBrowserContext(nextUserId, nextSessionId) {
      if (state === 'active' || state === 'flushing') {
        userId = nextUserId;
        sessionId = nextSessionId;
      }
    },
    onClose(cleanup) {
      cleanups.add(cleanup);
    },
    supplementWithBeacon(send) {
      if (state !== 'active' || running || config.source !== 'browser') return;
      try {
        for (const entry of queue) if (entry.attempts === 0) entry.readyAt = performance.now();
        const entries = select();
        if (
          entries.length === 0 ||
          !send(config.endpoints[endpoint], canonicalize(envelope(entries)))
        )
          return;
        for (const entry of entries) {
          entry.firstSent ??= performance.now();
          entry.attempts += 1;
          retry(entry);
        }
        schedule();
      } catch {
        schedule();
      }
    },
  };
}
