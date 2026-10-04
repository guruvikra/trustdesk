import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds into server/public so `npm start` serves the dashboard and API from one port.
export default defineConfig({
  plugins: [react()],
  server: { port: 3000, proxy: { '/api': 'http://localhost:8000', '/health': 'http://localhost:8000', '/widget.js': 'http://localhost:8000' } },
  build: { outDir: '../server/public', emptyOutDir: true },
});
