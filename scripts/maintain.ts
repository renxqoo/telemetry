import { maintain } from '../packages/storage-postgres/src/index.js';
const connectionString = process.env.TELEMETRY_MAINTENANCE_DATABASE_URL;
if (!connectionString) throw new Error('TELEMETRY_MAINTENANCE_DATABASE_URL is required');
const result = await maintain(connectionString, {
  prebuildDays: 7,
  batchSize: 1000,
  deadlineAtMs: Date.now() + 15000,
  lockTimeoutMs: 200,
});
process.stdout.write(`${JSON.stringify(result)}\n`);
