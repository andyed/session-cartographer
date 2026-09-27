/**
 * tests/unit/memory-day.test.js
 *
 * GET /api/memory/day exists so the Memory Desk shows the day digest the
 * command line prints — the same numbers, not a second fold that agrees today
 * and drifts later. The first test is the contract: the endpoint's body equals
 * `session-digest.js --day --json` byte for byte once the generation stamp is
 * set aside, and its Markdown equals `--md`. The fixture holds an amended
 * commit, a plain-terminal commit, and a hook false positive, so an endpoint
 * that re-derived statuses instead of running the script would fail it.
 *
 * The rest pin the edges a UI will hit: bad parameters are refused before a
 * process starts, a missing log is an outage (503), repeated clicks share one
 * run, and git runs without optional locks so a desk refresh never takes
 * index.lock from a session committing in the same repository.
 *
 * Run with: node --test tests/unit/memory-day.test.js
 */
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'session-digest.js');
const { createDayDigestSource, readDayParams, DAY_DIGEST_SCHEMA } = await import('../../explorer/server/memory-day.js');
const { createMemoryHandler } = await import('../../explorer/server/memory.js');

const TZ = 'America/Los_Angeles';
const DAY = '2026-09-26';

const dev = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-memory-day-')));
test.after(() => fs.rmSync(dev, { recursive: true, force: true }));
const repo = path.join(dev, 'fixture');
fs.mkdirSync(repo);
const git = (argv, env = {}) => execFileSync('git', argv, { cwd: repo, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'me@example.com']);
git(['config', 'user.name', 'Me']);
git(['config', 'commit.gpgsign', 'false']);
const commit = (subject, at) => {
  fs.appendFileSync(path.join(repo, 'log.txt'), `${subject}\n`);
  git(['add', 'log.txt']);
  git(['commit', '-q', '-m', subject], { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at });
  return git(['rev-parse', 'HEAD']);
};
const a = commit('feat(core): logged and landed', '2026-09-26T10:00:00-07:00');
const b = commit('fix(core): amended later', '2026-09-26T11:00:00-07:00');
git(['commit', '-q', '--amend', '--no-edit'], { GIT_COMMITTER_DATE: '2026-09-26T11:30:00-07:00' });
commit('docs(core): made in a plain terminal', '2026-09-26T12:00:00-07:00');
const base = { session_id: 's1', project: 'fixture', cwd: repo, provider: 'claude' };
const rows = [
  { ...base, event_id: 'evt-a', timestamp: '2026-09-26T17:00:05Z', type: 'git_commit', summary: `[feature] Commit ${a}: feat(core): logged and landed` },
  { ...base, event_id: 'evt-b', timestamp: '2026-09-26T18:00:00Z', type: 'git_commit', summary: `[fix] Commit ${b}: fix(core): amended later` },
  { ...base, event_id: 'evt-m', timestamp: '2026-09-26T18:30:00Z', type: 'git_commit', summary: '[other] Commit deadbeefdeadbeefdeadbeefdeadbeefdeadbeef: rows 2 git_commit 0' },
  { ...base, event_id: 'evt-e', timestamp: '2026-09-26T19:00:00Z', type: 'tool_file_edit', summary: `Modified: ${path.join(repo, 'log.txt')}` },
];
const changelog = path.join(dev, 'changelog.jsonl');
fs.writeFileSync(changelog, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');

const env = { ...process.env, TZ, CARTOGRAPHER_CHANGELOG: changelog };
for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CARTOGRAPHER_SESSION_ID']) delete env[key];

function cli(format) {
  const run = spawnSync('node', [SCRIPT, '--day', DAY, `--${format}`], { encoding: 'utf8', env: { ...env, CARTOGRAPHER_DEV_DIR: dev } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

function invoke(handler, url) {
  return new Promise((resolve, reject) => {
    let status;
    handler({ url, method: 'GET' }, {
      writeHead(code) { status = code; },
      end(raw) { resolve({ status, body: JSON.parse(raw) }); },
    }).then((handled) => { if (!handled) resolve({ handled: false }); }, reject);
  });
}
const handler = (source) => createMemoryHandler({ getEvents: () => [], corpusRoot: dev, dayDigest: source });
const withoutStamp = ({ generated_at: _g, ...doc }) => doc;

test('the endpoint returns exactly what the command line prints', async () => {
  const source = createDayDigestSource({ corpusRoot: dev, env });
  const json = await invoke(handler(source), `/api/memory/day?day=${DAY}`);
  assert.equal(json.status, 200, JSON.stringify(json.body));
  assert.equal(json.body.schema, DAY_DIGEST_SCHEMA);
  assert.deepEqual(withoutStamp(json.body), withoutStamp(JSON.parse(cli('json'))));
  // The fixture reaches every status the view renders.
  const statuses = json.body.projects[0].commits.map((c) => [c.status, Boolean(c.landed_as)]);
  assert.deepEqual(statuses.sort(), [['landed', false], ['landed', true], ['missing', false]]);
  assert.equal(json.body.projects[0].git_only_commits.length, 1);

  const md = await invoke(handler(source), `/api/memory/day?day=${DAY}&format=md`);
  assert.equal(md.status, 200);
  assert.equal(md.body.text, cli('md').replace(/\n$/, ''));
});

test('bad parameters are refused before any process starts', async () => {
  let runs = 0;
  const source = createDayDigestSource({ corpusRoot: dev, run: () => { runs += 1; } });
  for (const query of ['day=2026-9-26', 'day=today', 'day=2026-09-26&format=pdf', 'day=2026-09-26&projects=a%3Brm', 'day=2026-09-26&projects=']) {
    const response = await invoke(handler(source), `/api/memory/day?${query}`);
    assert.equal(response.status, 400, query);
  }
  assert.equal(runs, 0);
  assert.deepEqual(readDayParams(new URLSearchParams('day=2026-09-26&projects=a,b-c')), { day: DAY, format: 'json', projects: 'a,b-c' });
});

test('a missing event log is an outage, never an empty day', async () => {
  const source = createDayDigestSource({ corpusRoot: dev, env: { ...env, CARTOGRAPHER_CHANGELOG: path.join(dev, 'absent.jsonl') } });
  const response = await invoke(handler(source), `/api/memory/day?day=${DAY}`);
  assert.equal(response.status, 503);
  assert.match(response.body.error, /outage, not a quiet day/);
});

test('repeated requests share one run, and git runs without optional locks', async () => {
  const calls = [];
  let finish;
  const source = createDayDigestSource({
    corpusRoot: dev,
    run: (bin, args, options, callback) => { calls.push({ args, options }); finish = () => callback(null, JSON.stringify({ schema: DAY_DIGEST_SCHEMA, day: DAY }), ''); },
  });
  const first = source({ day: DAY, format: 'json', projects: null });
  const second = source({ day: DAY, format: 'json', projects: null });
  assert.equal(first, second);
  finish();
  assert.equal((await first).day, DAY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(calls[0].options.env.CARTOGRAPHER_DEV_DIR, dev);
  assert.deepEqual(calls[0].args.slice(1), ['--day', DAY, '--json']);
  // Settled runs leave the table, so the next click runs again.
  source({ day: DAY, format: 'json', projects: null });
  assert.equal(calls.length, 2);
});
