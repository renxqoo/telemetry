import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';

const checker = fileURLToPath(new URL('../check-architecture.ts', import.meta.url));
const names = {
  protocol: '@oneaster/telemetry-protocol',
  sdk: '@oneaster/telemetry',
  application: '@oneaster/telemetry-application',
  'storage-contract': '@oneaster/storage-contract',
  'storage-postgres': '@oneaster/storage-postgres',
  cli: '@oneaster/telemetry-cli',
};
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'telemetry-architecture-'));
  await Promise.all(
    Object.entries(names).map(async ([module, name]) => {
      const root = join(directory, 'packages', module);
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'package.json'), JSON.stringify({ name }));
    }),
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
async function check(module: string, source: string, file = 'probe.ts') {
  await writeFile(join(directory, 'packages', module, 'src', file), source);
  return spawnSync('bun', ['run', checker], { cwd: directory, encoding: 'utf8', timeout: 3000 });
}

it.each([
  ['named', "import { createCollector } from '@oneaster/telemetry-application';"],
  ['side-effect', "import '@oneaster/telemetry-application';"],
  ['dynamic', "await import('@oneaster/telemetry-application');"],
  ['require', "const app = require('@oneaster/telemetry-application');"],
  ['subpath', "import { startService } from '@oneaster/telemetry-application/runtime';"],
  ['re-export', "export { createCollector } from '@oneaster/telemetry-application';"],
  ['type-import', "type Config = import('@oneaster/telemetry-application').Configuration;"],
  ['template', 'await import(`@oneaster/telemetry-application`);'],
  ['relative side-effect', "import '../../application/src/index.js';"],
])(
  'regression: architecture checks must reject forbidden SDK %s dependencies',
  async (_name, source) => {
    const result = await check('sdk', source);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('forbidden dependency');
  },
);

it('regression: architecture checks must read workspace package names from manifests', async () => {
  await writeFile(
    join(directory, 'packages/application/package.json'),
    JSON.stringify({ name: '@fixture/backend' }),
  );
  const result = await check('sdk', "import { createCollector } from '@fixture/backend';");
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('forbidden dependency @fixture/backend');
});

it('ignores regular expressions and template text while checking real imports', async () => {
  const result = await check(
    'sdk',
    [
      String.raw`const pattern = /\s*at\s+/;`,
      "const example = `from '@oneaster/telemetry-application'`;",
    ].join('\n'),
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Architecture boundaries passed');
});

it.each([
  ['sdk', "import { parseEnvelope } from '@oneaster/telemetry-protocol';", 'probe.ts'],
  ['application', "import type { TelemetryStore } from '@oneaster/storage-contract';", 'probe.ts'],
  ['storage-postgres', "import { StoreError } from '@oneaster/storage-contract';", 'probe.ts'],
  ['sdk', "import { AsyncLocalStorage } from 'node:async_hooks';", 'server.ts'],
  ['sdk', 'const example = "from \'@oneaster/telemetry-application\'";', 'probe.ts'],
])('allows the current %s boundary for %s', async (module, source, file) => {
  const result = await check(module, source, file);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Architecture boundaries passed');
});

it.each([
  ['protocol', "import { createServerClient } from '@oneaster/telemetry';"],
  ['application', "import { createPostgresStore } from '@oneaster/storage-postgres';"],
  ['cli', "import { createCollector } from '@oneaster/telemetry-application';"],
])('rejects forbidden cross-package dependencies from %s', async (module, source) => {
  const result = await check(module, source);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('forbidden dependency');
});
