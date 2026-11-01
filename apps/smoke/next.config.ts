import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
const entries = ['browser', 'server', 'react', 'next/client', 'next/server'];
const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  turbopack: {
    root,
    resolveAlias: Object.fromEntries(
      entries.map((entry) => [
        `@oneaster/telemetry/${entry}`,
        `../../dist/telemetry-sdk/${entry}.js`,
      ]),
    ),
  },
};
export default config;
