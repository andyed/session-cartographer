import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isDemo = process.env.VITE_DEMO === 'true';

export default defineConfig({
  plugins: [react()],
  base: isDemo ? '/session-cartographer/' : '/',
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
