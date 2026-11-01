import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { startPostgres } from '../tests/support/postgres.js';
import { createTestConfiguration } from '../tests/support/config.js';
import {
  createConfigManager,
  createCollector,
  createQueryApi,
} from '../packages/application/src/index.js';
import { createPostgresStore, migrate } from '../packages/storage-postgres/src/index.js';
const mode = process.argv[2];
if (mode !== 'development' && mode !== 'production')
  throw new Error('Expected development or production');
const port = mode === 'development' ? 4317 : 4318;
const origin = `http://127.0.0.1:${port}`;
const database = await startPostgres();
const fixture = createTestConfiguration(origin);
const config = createConfigManager(fixture.configuration);
const makeStore = (role: 'collector' | 'query') =>
  createPostgresStore({
    connectionString: database.url,
    profile: 'development',
    role,
    instanceId: `smk${randomUUID().slice(0, 8)}`,
    nodeId: 'local-smoke',
  });
await migrate(database.url);
const collectorStore = makeStore('collector');
const queryStore = makeStore('query');
const collector = createCollector({ store: collectorStore, config });
const query = createQueryApi({
  store: queryStore,
  config,
  cursorKeys: [{ id: 'smoke', secret: fixture.cursorSecret }],
});
let child: ReturnType<typeof spawn> | undefined;
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  child?.kill('SIGTERM');
  await Promise.allSettled([collector.close(), query.close()]);
  const options = { signal: new AbortController().signal, deadlineAtMs: Date.now() + 3000 };
  await Promise.allSettled([collectorStore.close(options), queryStore.close(options)]);
  await database.stop();
}
process.once('SIGTERM', () => {
  void stop().then(() => process.exit(0));
});
process.once('SIGINT', () => {
  void stop().then(() => process.exit(0));
});
try {
  const collectorUrl = await collector.listen({ host: '127.0.0.1', port: 0 });
  const queryUrl = await query.listen({ host: '127.0.0.1', port: 0 });
  child = spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      mode === 'development' ? 'dev' : 'start',
      'apps/smoke',
      '--hostname',
      '127.0.0.1',
      '--port',
      String(port),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        NEXT_TELEMETRY_DISABLED: '1',
        TELEMETRY_SMOKE_COLLECTOR: collectorUrl,
        TELEMETRY_SMOKE_QUERY: queryUrl,
        TELEMETRY_SMOKE_READ_TOKEN: fixture.readToken,
        TELEMETRY_SMOKE_WRITE_TOKEN: fixture.writeToken,
      },
    },
  );
  const code = await new Promise<number>((resolve, reject) => {
    child?.once('error', reject);
    child?.once('exit', (status) => resolve(status ?? 0));
  });
  await stop();
  process.exitCode = code;
} catch (error) {
  await stop();
  throw error;
}
