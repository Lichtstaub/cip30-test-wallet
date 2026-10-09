import { defineConfig } from 'vitest/config';

// The integration suite against a local devnet in Docker. One file at a time: each file
// starts its own devnet. npm test never collects these files, vitest.config.ts includes test/ only.
export default defineConfig({
  test: {
    include: ['test-devnet/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 300_000,
    teardownTimeout: 60_000,
  },
});
