import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/default-repo-fixture-setup.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: 'forks',
  },
});
