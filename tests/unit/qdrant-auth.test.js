// Which Qdrant API key a request carries is decided twice: scripts/qdrant-auth.js
// for the Node clients and scripts/qdrant-auth.sh for index-event.sh and the CLI.
// Two copies of one rule drift, and here a drift is either a key sent where it
// does not belong or a client that silently stops authenticating. So both are
// run over one table and held to an expected answer written from the rule, not
// to each other. Shell cases run under /bin/bash as well as the bash on PATH:
// macOS ships 3.2, and CI runs whatever Linux has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isLoopbackUrl, qdrantApiKey, qdrantFetch, qdrantKeyFile } from '../../scripts/qdrant-auth.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LIB = path.join(ROOT, 'scripts', 'qdrant-auth.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-qdrant-auth-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const file = (name, content) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, content);
  return p;
};
const FILES = {
  plain: file('plain', 'filekey\n'),
  crlf: file('crlf', 'filekey\r\n'),
  padded: file('padded', '  filekey \t\n'),
  noNewline: file('no-newline', 'filekey'),
  twoLines: file('two-lines', 'filekey\nsecond-line\n'),
  empty: file('empty', ''),
  blankFirst: file('blank-first', '\nfilekey\n'),
  missing: path.join(tmp, 'missing'),
  directory: (() => { const p = path.join(tmp, 'a-directory'); fs.mkdirSync(p); return p; })(),
};
const FILE_KEY = { plain: 'filekey', crlf: 'filekey', padded: 'filekey', noNewline: 'filekey', twoLines: 'filekey' };

// [url, is it loopback?]. The rule is the host as written plus an optional
// port, with no userinfo, so that the shell's `case` can apply it exactly.
const URLS = [
  ['http://localhost:6333', true],
  ['http://127.0.0.1:6333', true],
  ['http://[::1]:6333', true],
  ['https://localhost', true],
  ['http://localhost/', true],
  ['http://127.0.0.1', true],
  ['http://127.0.0.1:6333/collections?x=1', true],
  ['http://127.0.0.1.evil.example:6333', false],
  ['http://localhost.evil.example', false],
  ['http://localhost:6333@evil.example/', false],
  ['http://user@127.0.0.1:6333', false],
  ['http://LOCALHOST:6333', false],
  ['http://127.1:6333', false],
  ['http://10.0.0.5:6333', false],
  ['https://qdrant.example.com', false],
  ['ftp://localhost', false],
  ['', false],
];
const ENV_KEYS = [null, 'envkey', '  envkey  ', '   '];

function expected(url, envKey, fileName) {
  if (envKey && envKey.trim()) return envKey.trim();
  if (!URLS.find(([u]) => u === url)[1]) return '';
  return FILE_KEY[fileName] ?? '';
}

const CASES = [];
for (const [url] of URLS) {
  for (const envKey of ENV_KEYS) {
    for (const fileName of Object.keys(FILES)) CASES.push({ url, envKey, fileName });
  }
}

test('isLoopbackUrl matches the written host only', () => {
  for (const [url, loopback] of URLS) assert.equal(isLoopbackUrl(url), loopback, url);
  assert.equal(isLoopbackUrl(new URL('http://127.0.0.1:6333/x')), true, 'a URL object is read as its string');
  assert.equal(isLoopbackUrl(undefined), false);
});

test('the JS resolver gives every case the expected key', () => {
  const wrong = [];
  for (const c of CASES) {
    const env = { CARTOGRAPHER_QDRANT_API_KEY_FILE: FILES[c.fileName] };
    if (c.envKey !== null) env.CARTOGRAPHER_QDRANT_API_KEY = c.envKey;
    const got = qdrantApiKey(c.url, env);
    if (got !== expected(c.url, c.envKey, c.fileName)) wrong.push({ ...c, got });
  }
  assert.deepEqual(wrong, []);
});

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
// Each distinct bash once: on macOS /bin/bash is 3.2 and PATH often has 5.x.
const SHELLS = [];
for (const shell of ['/bin/bash', 'bash']) {
  const probe = spawnSync(shell, ['-c', 'printf %s "$BASH_VERSION"'], { encoding: 'utf8' });
  if (probe.status === 0 && !SHELLS.some((s) => s.version === probe.stdout)) SHELLS.push({ shell, version: probe.stdout });
}

for (const { shell, version } of SHELLS) {
  test(`the shell resolver gives every case the expected key (bash ${version})`, () => {
    // One process for the whole table; the library is sourced once, the way
    // index-event.sh sources it.
    const script = [
      `. ${sq(LIB)}`,
      'run_case() {',
      '  if [ "$2" = "__unset__" ]; then unset CARTOGRAPHER_QDRANT_API_KEY; else CARTOGRAPHER_QDRANT_API_KEY="$2"; fi',
      '  CARTOGRAPHER_QDRANT_API_KEY_FILE="$3"',
      '  cartographer_qdrant_auth "$1"',
      '  printf "[%s]\\n" "$CARTOGRAPHER_QDRANT_KEY"',
      '}',
      ...CASES.map((c) => `run_case ${sq(c.url)} ${sq(c.envKey ?? '__unset__')} ${sq(FILES[c.fileName])}`),
    ].join('\n');
    const result = spawnSync(shell, ['-c', script], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: tmp } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '', 'the resolver must stay quiet, including on a directory at the key path');
    const lines = result.stdout.trimEnd().split('\n');
    assert.equal(lines.length, CASES.length);
    const wrong = CASES
      .map((c, i) => ({ ...c, got: lines[i].slice(1, -1) }))
      .filter((c) => c.got !== expected(c.url, c.envKey, c.fileName));
    assert.deepEqual(wrong, []);
  });
}

test('both resolvers find the launcher key from the storage dir, and from HOME by default', () => {
  const home = path.join(tmp, 'home');
  const defaultStorage = path.join(home, 'Documents', 'dev', 'qdrant-storage');
  const customStorage = path.join(tmp, 'custom-storage');
  fs.mkdirSync(defaultStorage, { recursive: true });
  fs.mkdirSync(customStorage);
  fs.writeFileSync(path.join(defaultStorage, 'api-key'), 'default-dir-key\n');
  fs.writeFileSync(path.join(customStorage, 'api-key'), 'custom-dir-key\n');

  const cases = [
    [{ HOME: home }, 'default-dir-key'],
    [{ HOME: home, CARTOGRAPHER_QDRANT_STORAGE: customStorage }, 'custom-dir-key'],
    [{ HOME: home, CARTOGRAPHER_QDRANT_STORAGE: customStorage, CARTOGRAPHER_QDRANT_API_KEY_FILE: FILES.missing }, ''],
  ];
  for (const [env, key] of cases) {
    assert.equal(qdrantApiKey('http://localhost:6333', env), key, `js ${JSON.stringify(env)}`);
    const sh = spawnSync('bash', ['-c', `. ${sq(LIB)}; cartographer_qdrant_auth http://localhost:6333; printf %s "$CARTOGRAPHER_QDRANT_KEY"`],
      { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
    assert.equal(sh.stdout, key, `sh ${JSON.stringify(env)}`);
  }
  assert.equal(qdrantKeyFile({ HOME: home }), path.join(defaultStorage, 'api-key'));
});

test('qdrantFetch adds the header, keeps the caller\'s headers, and refuses redirects only when keyed', async () => {
  const calls = [];
  const fetch = async (url, init) => { calls.push({ url, init }); return { ok: true }; };
  const env = { CARTOGRAPHER_QDRANT_API_KEY: 'k1' };

  await qdrantFetch('http://q.test/collections/c', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' }, { env, fetch });
  assert.deepEqual(calls[0].init.headers, { 'Content-Type': 'application/json', 'api-key': 'k1' });
  assert.equal(calls[0].init.redirect, 'error', 'a keyed request must not follow a redirect with the key attached');
  assert.equal(calls[0].init.method, 'PUT');

  await qdrantFetch('http://q.test/x', { headers: new Headers({ 'Content-Type': 'text/plain' }), redirect: 'manual' }, { env, fetch });
  assert.deepEqual(calls[1].init.headers, { 'content-type': 'text/plain', 'api-key': 'k1' }, 'a Headers instance keeps its entries');
  assert.equal(calls[1].init.redirect, 'manual', 'an explicit redirect choice stands');

  // No key: the call is passed through untouched — same init object, nothing
  // added — which is the "behaviour unchanged" promise for keyless installs.
  const init = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
  await qdrantFetch('http://localhost:6333/x', init, { env: { CARTOGRAPHER_QDRANT_API_KEY_FILE: FILES.missing }, fetch });
  assert.equal(calls[2].init, init);
  assert.deepEqual(Object.keys(calls[2].init.headers), ['Content-Type']);
});
