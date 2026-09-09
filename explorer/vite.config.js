import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { turboEntryPlugin } from './server/turbo-entry.js';

// Load telemetry as native Node modules: its workers and executable helpers
// must retain their source paths instead of being bundled into Vite's config.
const internalsRouteUrl = new URL('./server/internals-route.js', import.meta.url).href;
const { internalsUiPlugin } = await import(internalsRouteUrl);

const isDemo = process.env.VITE_DEMO === 'true';

export default defineConfig({
  plugins: [react(), ...(!isDemo ? [turboEntryPlugin(), internalsUiPlugin()] : [])],
  base: isDemo ? '/session-cartographer/' : '/',
  server: {
    host: '127.0.0.1',
    port: 2527,
    proxy: {
      '/api': 'http://127.0.0.1:2526',
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 2527,
    proxy: {
      '/api': 'http://127.0.0.1:2526',
    },
  },
  // SPA fallback — /session/* deep links route to index.html
  appType: 'spa',
});
