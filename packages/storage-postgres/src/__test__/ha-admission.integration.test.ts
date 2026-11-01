import { it } from 'vitest';

it('regression: HA admission preserves writes and connection bounds across concurrency and node failure', async () => {
  await import('../../probes/tls-cluster.js');
}, 60000);
