import {
  decodeTraceResponse,
  attributesToOtlp,
  spanToOtlp,
} from '../../../protocol/src/traces/codec.js';
import type { SpanData } from '../../../protocol/src/traces/types.js';
import { maximumTimerDelayMs } from '../config.js';
import type { TraceFlushResult, TracerLimits, TracerOptions } from './types.js';
interface Entry {
  span: SpanData;
  bytes: number;
  sequence: number;
}
interface Batch {
  entries: Entry[];
  body: string;
  first: number;
  attempts: number;
  unknown: boolean;
  ready: number;
}
interface Observer {
  boundary: number;
  forced?: boolean;
  entries: Set<Entry>;
  result: {
    confirmedSpans: number;
    rejectedSpans: number;
    unconfirmedSpans: number;
    droppedSpans: number;
  };
  wake: () => void;
}
export function createExporter(
  options: TracerOptions,
  limits: TracerLimits,
  count: (key: string, n?: number) => void,
) {
  const queue: Entry[] = [];
  const observers = new Set<Observer>();
  let bytes = 0,
    sequence = 0,
    stopped = false,
    closing = false,
    running = false;
  let timer: ReturnType<typeof setTimeout> | undefined,
    controller: AbortController | undefined,
    batch: Batch | undefined,
    endpoint = 0;
  let closePromise: Promise<TraceFlushResult> | undefined;
  let scheduledAt = Infinity;
  let cooldownUntil = 0;
  function body(entries: Entry[]) {
    const first = entries[0].span;
    return JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: attributesToOtlp(first.resource.attributes) },
          scopeSpans: [
            {
              scope: {
                name: first.scope.name,
                version: first.scope.version,
                attributes: attributesToOtlp(first.scope.attributes),
              },
              spans: entries.map((e) => spanToOtlp(e.span)),
            },
          ],
        },
      ],
    });
  }
  function notify() {
    for (const observer of observers) observer.wake();
  }
  function settle(entries: Entry[], confirmed = 0, rejected = 0, unconfirmed = 0, dropped = 0) {
    for (const observer of observers)
      if (entries.every((entry) => observer.entries.has(entry))) {
        observer.result.confirmedSpans += confirmed;
        observer.result.rejectedSpans += rejected;
        observer.result.unconfirmedSpans += unconfirmed;
        observer.result.droppedSpans += dropped;
        for (const entry of entries) observer.entries.delete(entry);
      }
    for (const entry of entries) {
      const index = queue.indexOf(entry);
      if (index >= 0) {
        queue.splice(index, 1);
        bytes -= entry.bytes;
      }
    }
    count('confirmed', confirmed);
    count('rejected', rejected);
    count('unconfirmed', unconfirmed);
    count('dropped', dropped);
    notify();
  }
  function schedule(delay = limits.flushIntervalMs) {
    if (stopped || running || !queue.length) return;
    const deadline = Math.max(cooldownUntil, performance.now() + Math.max(0, delay));
    if (timer !== undefined && scheduledAt <= deadline) return;
    if (timer !== undefined) clearTimeout(timer);
    scheduledAt = deadline;
    timer = setTimeout(
      () => {
        timer = undefined;
        scheduledAt = Infinity;
        void drain();
      },
      Math.min(maximumTimerDelayMs, Math.max(0, deadline - performance.now())),
    );
    timer.unref?.();
  }
  async function read(response: Response, signal: AbortSignal): Promise<Uint8Array> {
    if (!response.body) return new Uint8Array();
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const cancel = () => {
      void reader.cancel().catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      for (;;) {
        if (signal.aborted) throw new Error('aborted');
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > limits.responseBytes) throw new Error('too_large');
        chunks.push(next.value);
      }
      const result = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    } finally {
      signal.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  async function drain() {
    if (running || stopped) return;
    running = true;
    try {
      while (queue.length && !stopped) {
        if (performance.now() < cooldownUntil) break;
        if (!batch) {
          const boundary = Math.min(Infinity, ...[...observers].map((o) => o.boundary));
          const entries: Entry[] = [];
          for (const entry of queue) {
            if (entries.length >= limits.batchSize || (entries.length && entry.sequence > boundary))
              break;
            const candidate = body([...entries, entry]);
            if (new TextEncoder().encode(candidate).length > limits.batchBytes) {
              if (!entries.length) {
                settle([entry], 0, 0, 0, 1);
              }
              break;
            }
            entries.push(entry);
          }
          if (!entries.length) continue;
          batch = {
            entries,
            body: body(entries),
            first: performance.now(),
            attempts: 0,
            unknown: false,
            ready: 0,
          };
        }
        const current = batch;
        if (performance.now() < current.ready) break;
        if (
          performance.now() - current.first >= limits.retryBudgetMs ||
          current.attempts >= limits.maxAttempts
        ) {
          settle(
            current.entries,
            0,
            0,
            current.unknown ? current.entries.length : 0,
            current.unknown ? 0 : current.entries.length,
          );
          batch = undefined;
          continue;
        }
        controller = new AbortController();
        const signal = controller.signal;
        current.attempts++;
        const cutoff = Math.min(
          limits.requestTimeoutMs,
          limits.retryBudgetMs - (performance.now() - current.first),
        );
        let retryAfter = 0;
        let unknown = false;
        let status = 0;
        const timeout = setTimeout(() => controller?.abort(), cutoff);
        let rejectAbort: (() => void) | undefined;
        try {
          const aborted = new Promise<never>((_resolve, reject) => {
            rejectAbort = () => reject(new Error('aborted'));
            signal.addEventListener('abort', rejectAbort, { once: true });
          });
          const response = await Promise.race([
            (options.transport ?? fetch)(new URL('/v1/traces', options.endpoints[endpoint]), {
              method: 'POST',
              headers: {
                authorization: `Bearer ${options.writeToken}`,
                'X-OneAster-Environment': options.environment,
                'Content-Type': 'application/json',
              },
              body: current.body,
              signal,
              redirect: 'error',
              credentials: 'omit',
              cache: 'no-store',
            }),
            aborted,
          ]);
          status = response.status;
          if (stopped) {
            void response.body?.cancel().catch(() => undefined);
            break;
          }
          if (status === 200) {
            const payload = await Promise.race([read(response, signal), aborted]);
            if (stopped) break;
            const type = response.headers.get('content-type') ?? '';
            if (!/^application\/(?:json|x-protobuf)(?:;|$)/i.test(type))
              throw new Error('invalid_response');
            const rejected = decodeTraceResponse(
              payload,
              type.toLowerCase().startsWith('application/x-protobuf'),
              current.entries.length,
            );
            settle(current.entries, current.entries.length - rejected, rejected);
            batch = undefined;
            continue;
          }
          void response.body?.cancel().catch(() => undefined);
          if ([502, 503, 504].includes(status)) unknown = true;
          else if (status !== 429) {
            settle(
              current.entries,
              0,
              current.unknown ? 0 : current.entries.length,
              current.unknown ? current.entries.length : 0,
            );
            batch = undefined;
            continue;
          }
          const header = response.headers.get('retry-after');
          if (header) {
            const value = /^\d+(?:\.\d+)?$/.test(header)
              ? Number(header) * 1000
              : Date.parse(header) - Date.now();
            if (Number.isFinite(value)) retryAfter = Math.max(0, value);
          }
        } catch {
          unknown = true;
        } finally {
          clearTimeout(timeout);
          if (rejectAbort) signal.removeEventListener('abort', rejectAbort);
          controller = undefined;
        }
        if (stopped) break;
        current.unknown ||= unknown;
        if (status !== 429) endpoint = (endpoint + 1) % options.endpoints.length;
        const delay = Math.max(
          retryAfter,
          Math.random() *
            Math.min(limits.retryMaxMs, limits.retryBaseMs * 2 ** (current.attempts - 1)),
        );
        current.ready = performance.now() + delay;
        if (status === 429) cooldownUntil = Math.max(cooldownUntil, current.ready);
        if (
          current.ready - current.first >= limits.retryBudgetMs ||
          current.attempts >= limits.maxAttempts
        ) {
          settle(
            current.entries,
            0,
            0,
            current.unknown ? current.entries.length : 0,
            current.unknown ? 0 : current.entries.length,
          );
          batch = undefined;
          continue;
        }
        break;
      }
    } finally {
      running = false;
      notify();
      schedule(batch ? Math.max(0, batch.ready - performance.now()) : 0);
    }
  }
  function timeoutValue(options?: { timeoutMs?: number }) {
    const value = options?.timeoutMs ?? 5000;
    if (!Number.isInteger(value) || value < 1 || value > 30000)
      throw new Error('Invalid flush timeout');
    return value;
  }
  async function observe(timeout: number, isClose = false): Promise<TraceFlushResult> {
    const entries = new Set(queue);
    const observer: Observer = {
      entries,
      boundary: sequence,
      result: { confirmedSpans: 0, rejectedSpans: 0, unconfirmedSpans: 0, droppedSpans: 0 },
      wake: () => undefined,
    };
    observers.add(observer);
    const deadline = performance.now() + timeout;
    let timedOut = false;
    try {
      schedule(0);
      while (entries.size && !stopped) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) {
          timedOut = true;
          break;
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          observer.wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
      }
      if (isClose) {
        if (entries.size) timedOut = true;
        for (const waiting of observers) if (waiting.entries.size) waiting.forced = true;
        stopped = true;
        options.writeToken = '';
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        scheduledAt = Infinity;
        cooldownUntil = 0;
        if (batch) {
          if (controller) batch.unknown = true;
          settle(
            batch.entries,
            0,
            0,
            batch.unknown ? batch.entries.length : 0,
            batch.unknown ? 0 : batch.entries.length,
          );
          batch = undefined;
        }
        for (const entry of queue.slice()) settle([entry], 0, 0, 0, 1);
        controller?.abort();
        notify();
      }
      return Object.freeze({
        ...observer.result,
        pendingSpans: entries.size,
        timedOut: timedOut || !!observer.forced || (stopped && entries.size > 0),
      });
    } finally {
      observers.delete(observer);
    }
  }
  return {
    enqueue(span: SpanData) {
      const entry: Entry = {
        span,
        bytes: new TextEncoder().encode(JSON.stringify(span)).length,
        sequence: ++sequence,
      };
      if (closing || stopped) {
        count('closing');
        return;
      }
      if (queue.length >= limits.queueCapacity || bytes + entry.bytes > limits.queueBytes) {
        count('queue_full');
        return;
      }
      queue.push(entry);
      bytes += entry.bytes;
      schedule(observers.size ? 0 : limits.flushIntervalMs);
    },
    flush(options?: { timeoutMs?: number }) {
      const timeout = timeoutValue(options);
      return observe(timeout);
    },
    close(options?: { timeoutMs?: number }) {
      if (closePromise) return closePromise;
      const timeout = timeoutValue(options);
      closing = true;
      closePromise = observe(timeout, true);
      return closePromise;
    },
    stats() {
      return { queuedSpans: queue.length, queuedBytes: bytes, closed: closing || stopped };
    },
  };
}
