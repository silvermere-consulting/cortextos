import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      // Matches the dashboard's tsconfig path alias so tests under
      // dashboard/src/**/__tests__ can import dashboard source via "@/…".
      '@': path.resolve(__dirname, 'dashboard/src'),
      // Dashboard tests need to resolve `next/server` and other Next deps
      // from dashboard/node_modules, because root's package.json does not
      // depend on Next.js.
      'next/server': path.resolve(__dirname, 'dashboard/node_modules/next/server.js'),
    },
  },
  test: {
    globals: true,
    testTimeout: 10000,
    include: [
      'tests/**/*.test.ts',
      'dashboard/src/**/__tests__/**/*.test.ts',
      'dashboard/src/**/__tests__/**/*.test.tsx',
    ],
    // isolate-home MUST run first: it redirects HOME to a temp dir so no
    // suite can write into the real ~/.cortextos (see that file's header).
    setupFiles: ['./tests/isolate-home.setup.ts', './dashboard/vitest.setup.ts'],
  },
});
