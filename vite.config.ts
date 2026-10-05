import { defineConfig } from 'vitest/config';

export default defineConfig({
  worker: { format: 'es' },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
