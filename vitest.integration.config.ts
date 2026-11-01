import { defineConfig } from 'vitest/config';
import base from './vitest.config.js';
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'packages/**/__test__/**/*.test.{ts,tsx}',
      'tests/system/**/*.test.ts',
      'ops/__test__/**/*.test.ts',
      'scripts/__test__/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 20000,
    fileParallelism: false,
    coverage: { ...base.test?.coverage, reportsDirectory: 'coverage/integrated' },
  },
});
