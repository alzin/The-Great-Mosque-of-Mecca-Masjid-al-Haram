import { defineConfig } from 'vitest/config';

/** Configuration for the long-running soak test only: `npm run soak`. */
export default defineConfig({
  test: {
    testTimeout: 1_800_000,
    hookTimeout: 60_000,
    include: ['tests/soak.test.ts'],
    environment: 'node',
  },
});
