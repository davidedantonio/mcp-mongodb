import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/integration/**/*.test.ts'],
    environment: 'node',
    // A real cluster is slower than a mock, and the suites share one
    // database, so they run one file at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000
  }
})
