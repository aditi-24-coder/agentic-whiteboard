import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    // Runs inside VS Code via @vscode/test-electron, not vitest.
    exclude: ['**/node_modules/**', 'packages/extension/test/suite/**'],
    testTimeout: 30_000,
  },
});
