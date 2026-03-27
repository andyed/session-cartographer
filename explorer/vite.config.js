import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 2527,
    proxy: {
      '/api': 'http://127.0.0.1:2526',
    },
  },
  // SPA fallback — /session/* deep links route to index.html
  appType: 'spa',
});
