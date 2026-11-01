import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: [
      'packages/**/__test__/**/*.test.{ts,tsx}',
      'ops/__test__/**/*.test.ts',
      'scripts/__test__/**/*.test.ts',
    ],
    exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
    testTimeout: 10000,
    coverage: {
      provider: 'v8',
      include: ['packages/**/src/**/*.{ts,tsx}'],
      exclude: ['packages/**/src/types.ts', 'packages/**/src/**/__test__/**'],
      reporter: ['text', 'json-summary', 'html'],
      thresholds: { statements: 75, branches: 65, functions: 75, lines: 75 },
    },
  },
});
