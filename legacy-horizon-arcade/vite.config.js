import { defineConfig } from 'vite';

// Open-world arcade racer build config.
export default defineConfig({
  plugins: [],
  server: {
    port: 5180,
    strictPort: true,
  },
  build: {
    target: 'esnext',
    chunkSizeWarningLimit: 1500,
  },
});
