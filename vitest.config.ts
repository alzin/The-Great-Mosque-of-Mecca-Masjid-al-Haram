import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These are simulation tests: several of them run tens of thousands of
    // fixed timesteps with thousands of agents. On a single core that takes
    // tens of seconds, which is expected rather than a hang.
    testTimeout: 180_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.ts'],
    // The soak test runs forty simulated minutes and takes several minutes of
    // wall time. It is a deliberate, separate step (`npm run soak`), not part
    // of the default suite.
    exclude: ['tests/soak.test.ts', '**/node_modules/**', '**/dist/**'],
    environment: 'node',
  },
});
