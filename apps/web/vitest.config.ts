import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Tests run in jsdom (the client is DOM-heavy) with globals enabled so RTL's
// automatic cleanup registers against Vitest's afterEach.
export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
  },
});
