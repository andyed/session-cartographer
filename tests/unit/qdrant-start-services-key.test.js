// scripts/start-services.sh starts Qdrant with an API key, and that key is what
// closes blind writes.
//
// With CORS off and no key, a web page can still write to :6333: Qdrant 1.12.1
// parses a `text/plain` POST, which needs no CORS preflight, as JSON, and such
// a POST to /points/delete returned 200 and removed the point (2026-10-16).
// The launcher now generates a key on first start, keeps it in a mode-600 file
// the clients read without anything exported, and writes it into a mode-600
// config as `service.api_key`.
//
// The provisioning tests stand a recorder in for the `qdrant` binary, so they
// run everywhere. The last test starts a real Qdrant through the launcher and
// sends it the blind write; it needs a binary (`qdrant` on PATH, or
// CARTOGRAPHER_TEST_QDRANT_BIN) and skips without one. It never touches a
// Qdrant this test did not start: its own storage dir, its own free ports, and
// teardown by pid, never `start-services.sh --stop`, which pkills every qdrant.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qdrantApiKey, qdrantFetch } from '../../scripts/qdrant-auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const START = path.join(ROOT, 'scripts', 'start-services.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-start-key-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const mode = (p) => fs.statSync(p).mode & 0o777;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const portIsFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
// Qdrant takes the HTTP port and the next one up for gRPC.
async function freePortPair() {
  for (let i = 0; i < 20; i += 1) {
    const port = await freePort();
    if (await portIsFree(port + 1)) return port;
  }
  throw new Error('no free port pair');
}

function cleanEnv(extra) {
  const env = { ...process.env };
  for (const name of [
    'CARTOGRAPHER_QDRANT_API_KEY', 'CARTOGRAPHER_QDRANT_API_KEY_FILE', 'CARTOGRAPHER_QDRANT_STORAGE',
    'CARTOGRAPHER_QDRANT_PORT', 'CARTOGRAPHER_EMBED_PORT', 'CARTOGRAPHER_EMBED_MODEL_PATH',
  ]) delete env[name];
  return { ...env, ...extra };
}

function run(env, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', [START], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function waitForFile(file, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fs.existsSync(file) && fs.statSync(file).size > 0) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// A launcher sandbox: stand-in llama-server, a model file, a storage dir and
// ports nothing listens on. `qdrantBin` is a real binary for the live test,
// or null for the recorder.
async function sandbox(name, { qdrantBin = null } = {}) {
  const dir = path.join(tmp, name);
  const bin = path.join(dir, 'bin');
  const storage = path.join(dir, 'storage');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(dir, 'model.gguf'), 'not a model');
  fs.writeFileSync(path.join(bin, 'llama-server'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const args = path.join(dir, 'qdrant-args');
  if (qdrantBin) {
    fs.symlinkSync(qdrantBin, path.join(bin, 'qdrant'));
  } else {
    fs.writeFileSync(path.join(bin, 'qdrant'), `#!/bin/sh\nprintf '%s\\n' "$*" > '${args}'\n`, { mode: 0o755 });
    // wait_for_port polls with curl; nothing listens, so answer for it.
    fs.writeFileSync(path.join(bin, 'curl'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  const qdrantPort = await freePortPair();
  return {
    dir, storage, args, qdrantPort,
    keyFile: path.join(storage, 'api-key'),
    config: path.join(storage, 'config.yaml'),
    env: (extra = {}) => cleanEnv({
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      CARTOGRAPHER_QDRANT_STORAGE: storage,
      CARTOGRAPHER_QDRANT_PORT: String(qdrantPort),
      CARTOGRAPHER_EMBED_MODEL_PATH: path.join(dir, 'model.gguf'),
      ...extra,
    }),
  };
}

test('first start generates a key, stores it mode 600, and writes it into a mode-600 config', async () => {
  const s = await sandbox('first-start');
  const { code, out } = await run(s.env({ CARTOGRAPHER_EMBED_PORT: String(await freePort()) }), s.dir);
  assert.equal(code, 0, out);

  const key = fs.readFileSync(s.keyFile, 'utf8').trim();
  assert.match(key, /^[0-9a-f]{64}$/, '32 random bytes as hex');
  assert.equal(mode(s.keyFile), 0o600);
  assert.equal(mode(s.config), 0o600, 'the config holds the key, so it is as private as the key file');
  const config = fs.readFileSync(s.config, 'utf8');
  assert.match(config, new RegExp(`^  api_key: "${key}"$`, 'm'));
  assert.match(config, /^  enable_cors: false$/m);
  assert.match(config, /^  host: 127\.0\.0\.1$/m);
  assert.ok(!out.includes(key), 'the launcher names the key file, never the key');
  assert.match(out, new RegExp(s.keyFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  assert.ok(await waitForFile(s.args), 'the qdrant stand-in was never started');
  assert.equal(fs.readFileSync(s.args, 'utf8').trim(), `--config-path ${s.config}`);

  // What "nothing to export" means: a client given only the storage dir sends
  // this key, and so does one given only HOME when storage is the default.
  assert.equal(qdrantApiKey(`http://127.0.0.1:${s.qdrantPort}`, { HOME: s.dir, CARTOGRAPHER_QDRANT_STORAGE: s.storage }), key);
});

test('a later start reuses the key, and narrows a config left world-readable', async () => {
  const s = await sandbox('restart');
  const embed = String(await freePort());
  assert.equal((await run(s.env({ CARTOGRAPHER_EMBED_PORT: embed }), s.dir)).code, 0);
  const key = fs.readFileSync(s.keyFile, 'utf8').trim();
  fs.chmodSync(s.config, 0o644);

  const second = await run(s.env({ CARTOGRAPHER_EMBED_PORT: embed }), s.dir);
  assert.equal(second.code, 0, second.out);
  assert.equal(fs.readFileSync(s.keyFile, 'utf8').trim(), key, 'the key survives a restart');
  assert.match(fs.readFileSync(s.config, 'utf8'), new RegExp(`api_key: "${key}"`));
  assert.equal(mode(s.config), 0o600);
  assert.doesNotMatch(second.out, /Generated/, 'only a first start generates');
});

test('CARTOGRAPHER_QDRANT_API_KEY wins and is written to the file, so clients without it still match', async () => {
  const s = await sandbox('env-key');
  const supplied = 'Supplied-Key_0123.abc';
  const { code, out } = await run(s.env({ CARTOGRAPHER_EMBED_PORT: String(await freePort()), CARTOGRAPHER_QDRANT_API_KEY: supplied }), s.dir);
  assert.equal(code, 0, out);
  assert.match(fs.readFileSync(s.config, 'utf8'), new RegExp(`api_key: "${supplied}"`));
  assert.equal(fs.readFileSync(s.keyFile, 'utf8').trim(), supplied);
  assert.equal(mode(s.keyFile), 0o600);
  assert.ok(!out.includes(supplied));
});

test('a key that could break the YAML or the header is refused before anything is written', async () => {
  const s = await sandbox('bad-key');
  const { code, out } = await run(s.env({ CARTOGRAPHER_EMBED_PORT: String(await freePort()), CARTOGRAPHER_QDRANT_API_KEY: 'bad"key\n  api_key: x' }), s.dir);
  assert.equal(code, 1, out);
  assert.match(out, /characters outside/);
  assert.ok(!fs.existsSync(s.config), 'no config may be written with a refused key');
  assert.ok(!fs.existsSync(s.keyFile));
  assert.ok(!(await waitForFile(s.args, 300)), 'qdrant must not start');
});

const QDRANT_BIN = process.env.CARTOGRAPHER_TEST_QDRANT_BIN
  || spawnSync('bash', ['-c', 'command -v qdrant'], { encoding: 'utf8' }).stdout.trim();

test('a launcher-started Qdrant refuses the keyless text/plain write a web page can send', {
  skip: !QDRANT_BIN && 'no qdrant binary (put one on PATH or set CARTOGRAPHER_TEST_QDRANT_BIN)',
}, async (t) => {
  const s = await sandbox('live', { qdrantBin: QDRANT_BIN });
  // Stands in for llama-server: the launcher sees the port in use and skips it.
  const embed = createServer((_req, res) => res.writeHead(200).end('{}'));
  await new Promise((resolve) => embed.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => embed.close(resolve));
    // Only the Qdrant whose command line names this sandbox's config. It
    // shuts down gracefully on SIGTERM, which takes a moment; wait for it so
    // the storage dir is not removed under a live process.
    const pids = spawnSync('pgrep', ['-f', s.config], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).map(Number);
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const pid of pids) { try { process.kill(pid); } catch {} }
    for (let waited = 0; pids.some(alive) && waited < 5000; waited += 50) await new Promise((r) => setTimeout(r, 50));
    for (const pid of pids.filter(alive)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  });

  const started = await run(s.env({ CARTOGRAPHER_EMBED_PORT: String(embed.address().port) }), s.dir);
  assert.equal(started.code, 0, started.out);
  const q = `http://127.0.0.1:${s.qdrantPort}`;
  // A client with nothing exported but where the launcher keeps its storage.
  const clientEnv = { HOME: s.dir, CARTOGRAPHER_QDRANT_STORAGE: s.storage };
  const keyed = (p, init = {}) => qdrantFetch(`${q}${p}`, init, { env: clientEnv });
  const json = { 'Content-Type': 'application/json' };
  const count = async () => (await (await keyed('/collections/t/points/count', { method: 'POST', headers: json, body: '{}' })).json()).result.count;

  assert.equal((await keyed('/collections/t', { method: 'PUT', headers: json, body: JSON.stringify({ vectors: { size: 2, distance: 'Cosine' } }) })).status, 200);
  assert.equal((await keyed('/collections/t/points?wait=true', { method: 'PUT', headers: json, body: JSON.stringify({ points: [{ id: 1, vector: [0.1, 0.2] }] }) })).status, 200);
  assert.equal(await count(), 1);

  // The page's request: no preflight, so no way to add a header.
  const blind = await fetch(`${q}/collections/t/points/delete?wait=true`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ points: [1] }),
  });
  assert.equal(blind.status, 401);
  assert.equal(await count(), 1, 'the point survives the refused write');

  // And a page cannot get permission to add the header itself.
  const preflight = await fetch(`${q}/collections/t/points/delete`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://example.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'api-key' },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);

  // The control that makes the 401 mean something: the same text/plain body
  // with the key is parsed and deletes, so this build does honour the blind
  // write and it was the key, not the content type, that refused it.
  const withKey = await keyed('/collections/t/points/delete?wait=true', {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ points: [1] }),
  });
  assert.equal(withKey.status, 200);
  assert.equal(await count(), 0);
});
