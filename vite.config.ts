import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/socket.io': { target: 'http://127.0.0.1:3000', ws: true },
    },
  },
});
