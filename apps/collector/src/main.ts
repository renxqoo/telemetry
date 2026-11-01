import { startService } from '../../../packages/application/src/runtime.js';
import { createPostgresStore } from '../../../packages/storage-postgres/src/index.js';
try {
  await startService('collector', createPostgresStore);
} catch {
  process.stderr.write('Collector startup failed.\n');
  process.exitCode = 1;
}
