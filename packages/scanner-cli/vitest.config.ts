import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Same single build as the root `scanner-cli` project: test files must never rebuild `dist/`.
    globalSetup: ['./vitest.global-setup.ts'],
  },
});
