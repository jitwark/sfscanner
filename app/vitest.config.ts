import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'jsdom',
    // Must match the `app` project's include in the root `vitest.config.ts`,
    // which is what `npm run test` (and therefore CI) actually runs. When this
    // omitted `app/**`, running vitest from inside `app/` silently skipped the
    // route-level tests — which reads as "these tests do not exist" rather than
    // "this config is narrower", and invites the wrong conclusion that CI is
    // not covering them.
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'app/**/*.test.ts', 'app/**/*.test.tsx', 'e2e/**/*.test.ts'],
    alias: {
      '@': path.resolve(__dirname, './'),
    },
  },
});
