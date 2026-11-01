import { it, expect, vi } from 'vitest';
const vector = vi.hoisted(() => ({ trace: '1'.repeat(32) }));
vi.mock('node:crypto', () => ({
  randomBytes: (size: number) =>
    Buffer.from(size === 16 ? vector.trace : '1111111111111111', 'hex'),
}));
import { createTracer } from '../server.js';
it.each([
  [0, '0000000000000000', false],
  [1, 'ffffffffffffffff', true],
  [0.5, '7fffffffffffffff', true],
  [0.5, '8000000000000000', false],
  [0.5, 'ffffffffffffffff', false],
  [0.25, '3fffffffffffffff', true],
  [0.25, '4000000000000000', false],
] as const)(
  'uses the specified unsigned low64 sampling threshold for rate=%s low64=%s',
  async (rate, low, expected) => {
    vector.trace = '1'.repeat(16) + low;
    const tracer = createTracer({
      endpoints: ['http://127.0.0.1:4320'],
      environment: 'test',
      service: 'web',
      writeToken: 'writer.' + 's'.repeat(32),
      sampleRate: rate,
      transport: async () => Response.json({}),
    });
    try {
      const span = tracer.startSpan({ name: 'root' });
      expect(Boolean(span.context.traceFlags & 1)).toBe(expected);
      span.end();
      const result = await tracer.flush();
      expect(result.confirmedSpans).toBe(expected ? 1 : 0);
    } finally {
      await tracer.close();
    }
  },
);
