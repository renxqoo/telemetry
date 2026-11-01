import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SpanPageKey, PageKey } from '../../storage-contract/src/index.js';
import { HttpError } from './errors.js';
export interface CursorKey {
  id: string;
  secret: string;
}
interface Payload<T> {
  version: 1;
  binding: string;
  expires: number;
  after: T;
  from: string;
  to: string;
}
export function cursorCodec<T extends PageKey | SpanPageKey = PageKey>(
  keys: CursorKey[],
  now: () => number,
) {
  if (
    !keys.length ||
    keys.some((key) => !/^[A-Za-z0-9_-]+$/.test(key.id) || Buffer.byteLength(key.secret) < 32) ||
    new Set(keys.map((key) => key.id)).size !== keys.length
  )
    throw new Error('Invalid cursor signing keys');
  return {
    encode(payload: Omit<Payload<T>, 'version' | 'expires'>) {
      const key = keys[0]!;
      const body = Buffer.from(
        JSON.stringify({ ...payload, version: 1, expires: now() + 15 * 60 * 1000 }),
      ).toString('base64url');
      const signature = createHmac('sha256', key.secret)
        .update(`${key.id}.${body}`)
        .digest('base64url');
      return `${key.id}.${body}.${signature}`;
    },
    decode(token: string): Payload<T> {
      try {
        if (token.length > 8192) throw new Error();
        const parts = token.split('.');
        if (parts.length !== 3) throw new Error();
        const key = keys.find((candidate) => candidate.id === parts[0]);
        if (!key) throw new Error();
        const expected = createHmac('sha256', key.secret)
          .update(`${parts[0]}.${parts[1]}`)
          .digest();
        const actual = Buffer.from(parts[2]!, 'base64url');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
          throw new Error();
        const payload = JSON.parse(
          Buffer.from(parts[1]!, 'base64url').toString('utf8'),
        ) as Payload<T>;
        if (
          payload.version !== 1 ||
          !Number.isSafeInteger(payload.expires) ||
          payload.expires <= now() ||
          typeof payload.binding !== 'string' ||
          typeof payload.from !== 'string' ||
          typeof payload.to !== 'string' ||
          !payload.after ||
          typeof payload.after.received_at !== 'string' ||
          ('trace_id' in payload.after
            ? !/^[a-f0-9]{32}$/.test(String(payload.after.trace_id)) ||
              !('span_id' in payload.after) ||
              !/^[a-f0-9]{16}$/.test(String(payload.after.span_id))
            : !('service' in payload.after) ||
              typeof payload.after.service !== 'string' ||
              !('source' in payload.after) ||
              !['browser', 'server'].includes(String(payload.after.source)) ||
              !('id' in payload.after) ||
              !/^[a-f0-9-]{36}$/.test(String(payload.after.id)))
        )
          throw new Error();
        return payload;
      } catch {
        throw new HttpError('invalid_cursor');
      }
    },
  };
}
