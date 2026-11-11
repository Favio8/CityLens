import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'shared/**/*.test.ts',
      'server/**/*.test.ts',
      'scripts/**/*.test.ts',
      'client/**/*.test.{ts,tsx}',
    ],
    testTimeout: 20000,
  },
});
