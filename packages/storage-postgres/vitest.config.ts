import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['packages/storage-postgres/src/__test__/**/*.test.ts'],
    testTimeout: 10000,
    fileParallelism: false,
  },
});
