import { open, readFile } from 'node:fs/promises';
import { z } from 'zod';
import { createConfigManager } from './config.js';
import { createCollector, createQueryApi } from './index.js';
import type { TelemetryStore } from '../../storage-contract/src/index.js';
const positive = z.number().int().positive();
const secretSchema = z.strictObject({
  database_url: z.string().min(1),
  cursor_keys: z.array(z.strictObject({ id: z.string(), secret: z.string() })).optional(),
  cleanup_database_url: z.string().optional(),
  store_options: z.strictObject({
    instanceId: z.string().min(1),
    nodeId: z.string().min(1),
    maxConnections: positive.optional(),
    maxCleanupConnections: positive.optional(),
    poolWaitMs: positive.optional(),
    statementTimeoutMs: positive.optional(),
    lockTimeoutMs: positive.optional(),
    commitTimeoutMs: positive.optional(),
    responseReserveMs: positive.optional(),
    cleanupTimeoutMs: positive.optional(),
    maxPendingCleanup: positive.optional(),
    physicalNodes: z
      .array(
        z.strictObject({
          id: z.string().min(1),
          connectionString: z.string().min(1),
          cleanupConnectionString: z.string().min(1),
        }),
      )
      .optional(),
    requireTls: z.boolean().optional(),
  }),
});
export type ServiceStoreOptions = z.infer<typeof secretSchema>['store_options'] & {
  connectionString: string;
  cleanupConnectionString?: string;
  profile: 'development' | 'ha';
  role: 'collector' | 'query';
};
export async function startService(
  role: 'collector' | 'query',
  createStore: (options: ServiceStoreOptions) => TelemetryStore,
  env: Record<string, string | undefined> = process.env,
) {
  const configPath = env.TELEMETRY_CONFIG;
  if (!configPath) throw new Error('TELEMETRY_CONFIG required');
  let secrets: unknown;
  if (env.TELEMETRY_SECRETS_FILE) {
    const file = await open(env.TELEMETRY_SECRETS_FILE, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.())
        throw new Error('Secrets file requires owner and mode 0600');
      secrets = JSON.parse(await file.readFile('utf8'));
    } finally {
      await file.close();
    }
  } else {
    secrets = {
      database_url: env.DATABASE_URL,
      cleanup_database_url: env.TELEMETRY_CLEANUP_DATABASE_URL,
      cursor_keys: env.TELEMETRY_CURSOR_KEYS_JSON
        ? JSON.parse(env.TELEMETRY_CURSOR_KEYS_JSON)
        : undefined,
      store_options: env.TELEMETRY_STORE_OPTIONS_JSON
        ? JSON.parse(env.TELEMETRY_STORE_OPTIONS_JSON)
        : undefined,
    };
  }
  const settings = secretSchema.parse(secrets);
  const initialText = await readFile(configPath, 'utf8');
  const config = createConfigManager(JSON.parse(initialText));
  const configuration = config.current().value;
  const port = Number(env.PORT ?? (role === 'collector' ? 4320 : 4321));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  if (role === 'query' && !settings.cursor_keys?.length)
    throw new Error('Query cursor keys required');
  const store = createStore({
    ...settings.store_options,
    instanceId: env.TELEMETRY_INSTANCE_ID ?? settings.store_options.instanceId,
    connectionString: settings.database_url,
    cleanupConnectionString: settings.cleanup_database_url,
    profile: configuration.profile,
    role,
  });
  let app: ReturnType<typeof createCollector> | undefined;
  let closing = false;
  let reloading = false;
  let lastText = initialText;
  const poll = setInterval(() => {
    if (closing || reloading) return;
    reloading = true;
    void readFile(configPath, 'utf8')
      .then((text) => {
        if (text !== lastText) {
          config.update(JSON.parse(text));
          lastText = text;
        }
      })
      .catch(() => {
        process.stderr.write('Configuration update rejected.\n');
      })
      .finally(() => {
        reloading = false;
      });
  }, 15000);
  poll.unref();
  let shutdownPromise: Promise<void> | undefined;
  function shutdown(): Promise<void> {
    shutdownPromise ??= performShutdown();
    return shutdownPromise;
  }
  async function performShutdown() {
    closing = true;
    clearInterval(poll);
    process.off('SIGINT', signal);
    process.off('SIGTERM', signal);
    const timeout = configuration.limits.shutdown_timeout_ms;
    const deadlineAtMs = Date.now() + timeout;
    const controller = new AbortController();
    const expired = new Promise<void>((resolve) =>
      controller.signal.addEventListener(
        'abort',
        () => {
          app?.server.closeAllConnections();
          resolve();
        },
        { once: true },
      ),
    );
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      if (app) await Promise.race([app.close(), expired]);
      await Promise.race([store.close({ signal: controller.signal, deadlineAtMs }), expired]);
    } finally {
      clearTimeout(timer);
    }
  }
  function signal() {
    void shutdown().catch(() => {
      process.stderr.write('Service shutdown failed.\n');
      process.exitCode = 1;
    });
  }
  process.once('SIGINT', signal);
  process.once('SIGTERM', signal);
  try {
    app =
      role === 'collector'
        ? createCollector({ store, config })
        : createQueryApi({ store, config, cursorKeys: settings.cursor_keys! });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), configuration.limits.request_timeout_ms);
    try {
      const readiness = await Promise.race([
        store.readiness({
          signal: controller.signal,
          deadlineAtMs: Date.now() + configuration.limits.request_timeout_ms,
        }),
        new Promise<never>((_resolve, reject) =>
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('Startup readiness deadline exceeded')),
            { once: true },
          ),
        ),
      ]);
      if (!readiness.ready) throw new Error('Storage readiness unavailable');
    } finally {
      clearTimeout(timer);
    }
    await app.listen({ host: env.HOST ?? '127.0.0.1', port });
    return { app, config, close: shutdown };
  } catch (error) {
    await shutdown();
    throw error;
  }
}
