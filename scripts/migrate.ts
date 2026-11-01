import { migrate } from '../packages/storage-postgres/src/index.js';
const connectionString = process.env.TELEMETRY_MIGRATION_DATABASE_URL;
if (!connectionString) throw new Error('TELEMETRY_MIGRATION_DATABASE_URL is required');
const args = process.argv.slice(2);
if (
  args.length > 1 ||
  args.some((arg) => !['--prepare', '--finalize', '--event-rollback'].includes(arg))
)
  throw new Error('Usage: bun run db:migrate [--prepare|--finalize|--event-rollback]');
await migrate(connectionString, {
  finalize: !['--prepare', '--event-rollback'].includes(args[0] ?? ''),
  rollbackEvents: args[0] === '--event-rollback',
});
process.stdout.write('Migration completed\n');
