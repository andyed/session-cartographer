import { createExplorerApp } from './app.js';

const PORT = parseInt(process.env.CARTOGRAPHER_API_PORT || '2526', 10);
const { app, close } = createExplorerApp();

// ─── Start ───
// turbo-server.js binds this same port and serves only the recall contract, so
// a headless Turbo left running makes the Explorer UI unstartable. Say what to
// do about it instead of printing a bare EADDRINUSE stack.
const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`Cartographer API: http://127.0.0.1:${PORT}`);
  console.log(`Health: http://127.0.0.1:${PORT}/api/health`);
});

server.on('error', (error) => {
  close();
  if (error.code !== 'EADDRINUSE') throw error;
  console.error(`Port ${PORT} is already in use.`);
  console.error('If a headless Turbo server holds it, stop that first:');
  console.error('  node scripts/cartographer-turbo.js stop');
  console.error('The Explorer serves the recall contract itself, so Turbo stays warm without it.');
  process.exit(1);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  close();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
