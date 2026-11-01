import './trace-proto.js';
import { build } from 'esbuild';
import { mkdir, writeFile, cp, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
await mkdir('dist/telemetry-sdk', { recursive: true });
await build({
  entryPoints: [
    'apps/collector/src/main.ts',
    'apps/query-api/src/main.ts',
    'packages/cli/src/main.ts',
    'scripts/migrate.ts',
    'scripts/maintain.ts',
    'ops/probe.ts',
    'scripts/load.ts',
    'scripts/ha.ts',
  ],
  outdir: 'dist',
  outbase: '.',
  bundle: true,
  platform: 'node',
  target: 'node26',
  format: 'esm',
  packages: 'external',
  sourcemap: false,
});
const browser = await build({
  entryPoints: ['packages/sdk/src/browser.ts'],
  outfile: 'dist/telemetry-sdk/browser.js',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  minify: true,
  metafile: true,
  banner: { js: "'use client';" },
});
const forbidden = Object.keys(browser.metafile?.inputs ?? {}).filter(
  (input) =>
    /node_modules\/(pg|fastify)\//.test(input) ||
    /storage-postgres|sdk\/src\/tracing|node_modules\/@opentelemetry\//.test(input),
);
if (forbidden.length) throw new Error('Browser bundle includes server dependencies');
await build({
  entryPoints: {
    server: 'packages/sdk/src/server.ts',
    'next/server': 'packages/sdk/src/next/server.ts',
    'tracing/server': 'packages/sdk/src/tracing/server.ts',
  },
  outdir: 'dist/telemetry-sdk',
  bundle: true,
  platform: 'neutral',
  target: 'es2022',
  format: 'esm',
  packages: 'external',
});
await build({
  entryPoints: {
    react: 'packages/sdk/src/react.tsx',
    'next/client': 'packages/sdk/src/next/client.ts',
  },
  outdir: 'dist/telemetry-sdk',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'esm',
  packages: 'external',
  banner: { js: "'use client';" },
});
const declaration = spawnSync(
  'node',
  ['node_modules/typescript/bin/tsc', '--project', 'tsconfig.build.json'],
  { stdio: 'inherit' },
);
if (declaration.status !== 0) throw new Error('Declaration build failed');
for (const name of ['sdk', 'protocol'])
  await cp(`dist/types/packages/${name}`, `dist/telemetry-sdk/types/packages/${name}`, {
    recursive: true,
  });
await cp('packages/sdk/README.md', 'dist/telemetry-sdk/README.md');
await cp('packages/sdk/TRACING.md', 'dist/telemetry-sdk/TRACING.md');
await cp('packages/protocol/proto', 'dist/telemetry-sdk/protocol-sources', { recursive: true });
const root = JSON.parse(await readFile('package.json', 'utf8')) as {
  dependencies: Record<string, string>;
};
const exports = Object.fromEntries(
  ['browser', 'server', 'react', 'next/client', 'next/server', 'tracing/server'].map((entry) => [
    `./${entry}`,
    { types: `./types/packages/sdk/src/${entry}.d.ts`, import: `./${entry}.js` },
  ]),
);
await writeFile(
  'dist/telemetry-sdk/package.json',
  JSON.stringify(
    {
      name: '@oneaster/telemetry',
      version: '0.1.0',
      type: 'module',
      sideEffects: false,
      exports,
      dependencies: { zod: root.dependencies.zod, protobufjs: root.dependencies.protobufjs },
      peerDependencies: { react: '^19.0.0', next: '^16.0.0' },
      peerDependenciesMeta: { react: { optional: true }, next: { optional: true } },
    },
    null,
    2,
  ) + '\n',
);
await writeFile(
  'dist/build.json',
  JSON.stringify(
    {
      node: process.version,
      browserBytes: Object.values(browser.metafile?.outputs ?? {}).reduce(
        (sum, item) => sum + item.bytes,
        0,
      ),
    },
    null,
    2,
  ) + '\n',
);
