import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3102',
      '/auth': 'http://localhost:3102',
      '/share': 'http://localhost:3102',
    },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 800 },
});
