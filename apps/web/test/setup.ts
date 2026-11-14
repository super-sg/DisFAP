import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// Unmount any React trees rendered during a test so effects (and their
// teardown) run between cases.
afterEach(() => {
  cleanup();
});
