import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The broker package (`@disfap/broker`) ships TypeScript source with no build
 * step and no `exports` map, so a deep specifier like
 * `@disfap/broker/src/session-token.js` must be rewritten to the `.ts` source
 * for Vite/Vitest to transform it. `tsc` resolves the same specifier natively
 * via NodeNext (it maps `.js` → `.ts` inside the linked package), so only the
 * test runner needs this alias.
 */
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@disfap\/broker\/(.*)\.js$/,
        replacement: resolve(here, '../broker/$1.ts'),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
