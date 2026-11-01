import { startService } from '../../../packages/application/src/runtime.js';
import { createPostgresStore } from '../../../packages/storage-postgres/src/index.js';
try {
  await startService('query', createPostgresStore);
} catch {
  process.stderr.write('Query API startup failed.\n');
  process.exitCode = 1;
}
