/**
 * tests/unit/pulse-day-digest.test.js
 *
 * `cartographer-pulse.sh --day-digest DAY` nests the git-checked day digest in
 * the pulse a scheduled agent reads each morning. Three properties matter to
 * that reader, and each assertion below fails if one is lost:
 *
 *   - the section is opt-in, so a pulse without the flag is unchanged;
 *   - a digest that fails renders as an outage, never as an empty day, which
 *     a consumer would read as a day with no work in it;
 *   - the digest's headings are demoted one level, so its `##` title does not
 *     read to the consumer as the start of a second report.
 *
 * Hermetic by construction: Turbo and semantic search are off, the facts URL is
 * a closed port, the indexer's Qdrant and embedding URLs are the dead port
 * (OFFLINE_INDEX_ENV — the feed's search can reach index-event.sh), and the
 * Turbo state dir is a temp dir. Without that last one the facts client's spool
 * fallback would drop a request into the live Turbo service's queue and the
 * census would come back from the real corpus.
 *
 * Run with: node --test tests/unit/pulse-day-digest.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PULSE = path.join(ROOT, 'scripts', 'cartographer-pulse.sh');
const DAY = '2026-09-26';

const dev = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-pulse-day-')));
test.after(() => fs.rmSync(dev, { recursive: true, force: true }));

const repo = path.join(dev, 'fixture');
fs.mkdirSync(repo);
const git = (argv, env = {}) => execFileSync('git', argv, {
  cwd: repo, encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();
git(['init', '-q', '-b', 'main']);
git(['config', 'user.email', 'me@example.com']);
git(['config', 'user.name', 'Me']);
git(['config', 'commit.gpgsign', 'false']);
fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
git(['add', 'a.txt']);
git(['commit', '-q', '-m', 'feat(core): the one commit'], {
  GIT_AUTHOR_DATE: '2026-09-26T10:00:00-07:00', GIT_COMMITTER_DATE: '2026-09-26T10:00:00-07:00',
});
const sha = git(['rev-parse', 'HEAD']);

const changelog = path.join(dev, 'changelog.jsonl');
fs.writeFileSync(changelog, `${JSON.stringify({
  event_id: 'evt-one', timestamp: '2026-09-26T17:00:05Z', type: 'git_commit', provider: 'claude',
  session_id: 's1', project: 'fixture', cwd: repo, summary: `[feature] Commit ${sha}: feat(core): the one commit`,
})}\n`);
const registry = path.join(dev, 'registry.json');
fs.writeFileSync(registry, JSON.stringify({ aliases: {} }));
const empty = path.join(dev, 'empty');
fs.mkdirSync(empty);

function pulse(extra, envOverrides = {}) {
  const env = {
    ...process.env,
    ...OFFLINE_INDEX_ENV,
    TZ: 'America/Los_Angeles',
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_CHANGELOG: changelog,
    CARTOGRAPHER_PROJECT_REGISTRY: registry,
    CARTOGRAPHER_TURBO: '0',
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(dev, 'turbo-state'),
    CARTOGRAPHER_TRANSCRIPTS_DIR: empty,
    CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: empty,
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: empty,
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: empty,
    CARTOGRAPHER_SERVED_LOG: path.join(dev, 'served.jsonl'),
    CARTOGRAPHER_ACCESS_LEDGER: path.join(dev, 'access.jsonl'),
    CARTOGRAPHER_SEARCH_CALL_LOG: path.join(dev, 'calls.jsonl'),
    ...envOverrides,
  };
  for (const key of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CARTOGRAPHER_SESSION_ID']) delete env[key];
  return spawnSync('bash', [PULSE, '--projects', 'fixture', '--since', '24h',
    '--facts-url', 'http://127.0.0.1:9', '--facts-timeout-ms', '300', ...extra], { encoding: 'utf8', env });
}

test('without the flag the pulse has no day section', () => {
  const run = pulse([]);
  assert.equal(run.status, 0, run.stderr);
  assert.ok(run.stdout.includes('# Session Cartographer Pulse'));
  assert.ok(!run.stdout.includes('The day, by project'));
  assert.ok(!run.stdout.includes('Day digest:'));
});

test('with the flag the digest nests, demoted one level', () => {
  const run = pulse(['--day-digest', DAY]);
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout;
  assert.ok(out.includes(`- Day digest: local calendar day \`${DAY}\``));
  assert.ok(out.includes('## The day, by project (checked against git)'));
  assert.match(out, /^### Saturday, September 26, 2026$/m);
  assert.match(out, /^#### fixture — 1 commit · 1 session/m);
  assert.ok(out.includes(`feat(core): the one commit \`${sha.slice(0, 7)}\``));
  assert.ok(!/^## Saturday/m.test(out), 'digest title left at report level');
  // Counted and git-checked sections sit above the relevance sample.
  assert.ok(out.indexOf('## The day, by project') < out.indexOf('## What the search surfaced'));
  assert.ok(out.includes('The day digest is checked against git, and its window differs'));
});

test('a failed digest is an outage, not a quiet day', () => {
  const run = pulse(['--day-digest', DAY], { CARTOGRAPHER_CHANGELOG: path.join(dev, 'absent.jsonl') });
  assert.equal(run.status, 0, run.stderr);
  const section = run.stdout.slice(run.stdout.indexOf('## The day, by project'), run.stdout.indexOf('## What the search surfaced'));
  assert.match(section, /\*\*UNAVAILABLE this run\.\*\* The day digest exited 1/);
  assert.match(section, /This is an outage, not a quiet day/);
  assert.ok(!/commits? across/.test(section), 'a failed digest rendered as a day');
});

test('a day spec the digest cannot read is refused before any work', () => {
  const run = pulse(['--day-digest', 'tomorrow']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--day-digest takes today, yesterday, or YYYY-MM-DD/);
});
