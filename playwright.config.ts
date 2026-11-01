import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  timeout: 30000,
  use: { headless: true, browserName: 'chromium' },
  projects: [
    { name: 'development', use: { baseURL: 'http://127.0.0.1:4317' } },
    { name: 'production', use: { baseURL: 'http://127.0.0.1:4318' } },
  ],
  webServer: [
    {
      command: 'node --import tsx scripts/smoke-server.ts development',
      url: 'http://127.0.0.1:4317',
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
      timeout: 120000,
    },
    {
      command: 'node --import tsx scripts/smoke-server.ts production',
      url: 'http://127.0.0.1:4318',
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 5000 },
      timeout: 120000,
    },
  ],
});
