import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { turboEntryPlugin } from './server/turbo-entry.js';

// Load telemetry as native Node modules: its workers and executable helpers
// must retain their source paths instead of being bundled into Vite's config.
const internalsRouteUrl = new URL('./server/internals-route.js', import.meta.url).href;
const { internalsUiPlugin } = await import(internalsRouteUrl);

const isDemo = process.env.VITE_DEMO === 'true';
// Keep the proxy target in step with the API server, which reads the same var
// (server/index.js). Lets the Explorer sidestep a 2526 already held by a
// headless Turbo server instead of exiting on EADDRINUSE.
const apiPort = process.env.CARTOGRAPHER_API_PORT || '2526';

export default defineConfig({
  plugins: [react(), ...(!isDemo ? [turboEntryPlugin(), internalsUiPlugin()] : [])],
  base: isDemo ? '/session-cartographer/' : '/',
  server: {
    host: '127.0.0.1',
    port: 2527,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 2527,
    proxy: {
      '/api': `http://127.0.0.1:${apiPort}`,
    },
  },
  // SPA fallback — /session/* deep links route to index.html
  appType: 'spa',
});
