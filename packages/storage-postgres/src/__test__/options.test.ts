import { describe, expect, it } from 'vitest';
import { createPostgresStore, maintain } from '../index.js';
import type { PostgresStoreOptions } from '../options.js';
const base: PostgresStoreOptions = {
  connectionString: 'postgresql://localhost/test',
  profile: 'development',
  role: 'collector',
  instanceId: 'configtest',
  nodeId: 'node',
};
const operation = () => ({ signal: new AbortController().signal, deadlineAtMs: Date.now() + 1000 });

describe('storage admission contracts', () => {
  it('HA cannot be enabled without explicit verified physical cleanup endpoints', () => {
    expect(() => createPostgresStore({ ...base, profile: 'ha' })).toThrow('HA requires');
    const physicalNodes = [1, 2, 3].map((index) => ({
      id: `node${index}`,
      connectionString: `postgresql://localhost:${5400 + index}/test`,
      cleanupConnectionString: `postgresql://localhost:${5400 + index}/test`,
    }));
    expect(() =>
      createPostgresStore({ ...base, profile: 'ha', requireTls: true, physicalNodes }),
    ).toThrow('Verified TLS');
    expect(() =>
      createPostgresStore({
        ...base,
        profile: 'ha',
        requireTls: true,
        physicalNodes: physicalNodes.map((node) => ({ ...node, id: 'same' })),
      }),
    ).toThrow('Invalid physicalNodes');
  });
  it('nonpositive, fractional or unbounded connection budgets cannot enter runtime', () => {
    for (const maxConnections of [0, -1, 0.5, Infinity, 101])
      expect(() => createPostgresStore({ ...base, maxConnections })).toThrow('maxConnections');
    expect(() => createPostgresStore({ ...base, maxCleanupConnections: 3 })).toThrow(
      'maxCleanupConnections',
    );
    expect(() => createPostgresStore({ ...base, instanceId: '../../unsafe' })).toThrow(
      'Invalid instanceId',
    );
  });
  it('wrong runtime roles and empty query scopes fail before a database connection is opened', async () => {
    const reader = createPostgresStore({ ...base, role: 'query' });
    await expect(
      reader.writer.appendBatch(
        {
          scope: {
            projectId: 'p',
            environment: 'production',
            service: 'api',
            source: 'server',
            release: 'v',
            buildId: 'b',
            policyVersion: 'p',
            retentionDays: 30,
            receiptDays: 7,
          },
          events: [],
        },
        operation(),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      reader.reader.findEvents(
        { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z', limit: 1 },
        {
          projectId: 'p',
          environment: 'production',
          allowedServices: [],
          allowedKinds: ['event'],
          actorKeyId: 'actor',
          requestId: 'request',
          queryKind: 'events',
          queryDigest: 'digest',
          auditRetentionDays: 90,
        },
        operation(),
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    await reader.close(operation());
  });
  it('maintenance rejects unsafe deletion and partition budgets before connecting', async () => {
    await expect(maintain(base.connectionString, { prebuildDays: 6 })).rejects.toThrow(
      'At least seven',
    );
    await expect(maintain(base.connectionString, { batchSize: 10001 })).rejects.toThrow(
      'batchSize',
    );
  });
});
