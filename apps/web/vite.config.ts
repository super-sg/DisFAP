import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Minimal Vite setup for the React 19 client. The control-plane origin is
// injected at build time via VITE_API_BASE_URL (see src/api/client.ts); in dev
// the proxy below lets the app talk to a locally-running services/api.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Dev-only convenience: forward API + broker WS to the local stack.
      '/api': {
        target: `http://localhost:${process.env.API_PORT || '3000'}`,
        changeOrigin: true,
      },
      '/tunnel': {
        target: `ws://localhost:${process.env.BROKER_PORT || '8080'}`,
        ws: true,
      },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
