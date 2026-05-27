import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Dev-only: where Vite's /guardian-proxy forwards to. Override per-developer
// with `VITE_DEV_GUARDIAN_TARGET=https://your-guardian.example npm run dev`.
// In a deployed setup the static bundle is served behind a reverse proxy that
// owns /guardian-proxy directly, so this value is irrelevant in production.
const DEV_GUARDIAN_TARGET =
  process.env.VITE_DEV_GUARDIAN_TARGET ?? 'https://miden-guardian-staging-01.tail48b4d.ts.net';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@miden-sdk/miden-sdk': path.resolve(__dirname, 'node_modules/@miden-sdk/miden-sdk/dist/eager.js'),
      '@openzeppelin/guardian-client': path.resolve(__dirname, '../../packages/guardian-client/dist/index.js'),
      '@openzeppelin/miden-multisig-client': path.resolve(__dirname, '../../packages/miden-multisig-client/dist/index.js'),
    },
  },
  server: {
    port: 3002,
    fs: {
      allow: [
        path.resolve(__dirname, '.'),
        path.resolve(__dirname, '../../packages'),
      ],
    },
    proxy: {
      '/guardian-proxy': {
        target: DEV_GUARDIAN_TARGET,
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/guardian-proxy/, ''),
      },
    },
  },
  build: {
    target: 'esnext',
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        assetFileNames: '[name][extname]',
      },
    },
  },
  worker: {
    format: 'es',
  },
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: [
      '@miden-sdk/miden-sdk',
      '@openzeppelin/guardian-client',
      '@openzeppelin/miden-multisig-client',
    ],
  },
});
