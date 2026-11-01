import { spawn } from 'node:child_process';
import { startPostgres } from '../tests/support/postgres.js';
const postgres = await startPostgres();
try {
  const args = [
    'node_modules/vitest/vitest.mjs',
    'run',
    '--config',
    'vitest.integration.config.ts',
    '--coverage',
    ...process.argv.slice(2),
  ];
  const child = spawn('node', args, {
    stdio: 'inherit',
    env: { ...process.env, TELEMETRY_TEST_DATABASE_URL: postgres.url },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (status) => resolve(status ?? 1));
  });
  process.exitCode = code;
} finally {
  await postgres.stop();
}
