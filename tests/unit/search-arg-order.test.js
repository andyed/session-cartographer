/**
 * tests/unit/search-arg-order.test.js
 *
 * cartographer-search.sh used to take $1 as the query and discard every token
 * it did not recognise. An agent that puts flags first,
 *
 *   cartographer-search.sh --project session-cartographer --since 10d "milestone decision"
 *
 * searched for the literal "--project", lost the project scope, and got
 * confident results from other projects. Nothing errored. Measured over 30
 * days: 3 logged queries starting with "--" in search-calls.jsonl and 7
 * flag-first invocations in transcripts; --get, --touch and --thread also
 * demanded a dummy "_" first argument.
 *
 * These tests drive the real script against a throwaway corpus and assert on
 * composition: which projects the results came from, and what the telemetry
 * rows say the query was. "It exited 0" and "it returned results" are both
 * true of the broken parser.
 *
 * Run with: node --test tests/unit/search-arg-order.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SEARCH = path.join(ROOT, 'scripts', 'cartographer-search.sh');

const LIVE_IDENTITY_VARS = [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'CARTOGRAPHER_PROVIDER',
  'CODEX_THREAD_ID',
  'CODEX_HOME',
  'HERMES_SESSION_ID',
];

const TOKEN = 'zzargorder';
const SECOND = 'zzsecondword';
const DASH_TOKEN = 'zzdashquery';
const ALPHA_HIT = 'evt-argalphahit';
const BETA_HIT = 'evt-argbetahit';
const ALPHA_DASH = 'evt-argalphadash';

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Two projects, each with enough filler that its token is rare *within the
 * project*. A project filter narrows BM25's pass 1 to that project, so a
 * project holding one document makes every term's idf zero and the search
 * returns nothing for a reason that has nothing to do with argument parsing.
 */
function makeCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-argorder-'));
  const event = (id, project, day, summary) => JSON.stringify({
    event_id: id,
    timestamp: `2026-01-${String(day).padStart(2, '0')}T00:00:00Z`,
    type: 'tool_bash',
    project,
    summary,
  });
  const rows = [];
  for (const project of ['projalpha', 'projbeta']) {
    for (let i = 0; i < 6; i += 1) {
      rows.push(event(`evt-argfill-${project}-${i}`, project, i + 1, `Ran: routine filler command ${i} for ${project}`));
    }
  }
  rows.push(event(ALPHA_HIT, 'projalpha', 10, `Ran: ${TOKEN} ${SECOND} alpha side of the fixture`));
  rows.push(event(BETA_HIT, 'projbeta', 10, `Ran: ${TOKEN} beta side of the fixture`));
  rows.push(event(ALPHA_DASH, 'projalpha', 11, `Ran: ${DASH_TOKEN} only in alpha`));
  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${rows.join('\n')}\n`);
  for (const name of ['session-milestones.jsonl', 'research-log.jsonl', 'tool-use-log.jsonl']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  return {
    dir,
    served: path.join(dir, 'served-log.jsonl'),
    calls: path.join(dir, 'search-calls.jsonl'),
    ledger: path.join(dir, 'access-ledger.jsonl'),
  };
}

function cleanEnv(corpus) {
  const env = { ...process.env };
  for (const key of LIVE_IDENTITY_VARS) delete env[key];
  return {
    ...env,
    ...OFFLINE_INDEX_ENV,
    CARTOGRAPHER_DEV_DIR: corpus.dir,
    CARTOGRAPHER_SERVED_LOG: corpus.served,
    CARTOGRAPHER_SEARCH_CALL_LOG: corpus.calls,
    CARTOGRAPHER_ACCESS_LEDGER: corpus.ledger,
    CARTOGRAPHER_TRANSCRIPTS_DIR: path.join(corpus.dir, 'no-transcripts'),
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(corpus.dir, 'no-transcripts'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(corpus.dir, 'no-transcripts'),
    CARTOGRAPHER_CONFIG: path.join(corpus.dir, 'no-config.json'),
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_TURBO: '0',
    CARTOGRAPHER_PURPOSE: 'remember',
    TMPDIR_BASE: corpus.dir,
  };
}

function run(corpus, args) {
  // The timeout is load-bearing: the old parser spun forever on a value flag
  // with nothing after it (`shift 2` failed without shifting), and a hung child
  // would stall the suite instead of failing this file.
  return spawnSync('bash', [SEARCH, ...args], {
    encoding: 'utf8', env: cleanEnv(corpus), timeout: 30000, killSignal: 'SIGKILL',
  });
}

/** A search whose results must parse as jsonl and reach the exit code of success. */
function search(corpus, args) {
  const result = run(corpus, args);
  assert.equal(result.status, 0, `exit ${result.status}: ${result.stderr}`);
  const rows = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { rows, ids: rows.map((row) => row.event_id), result };
}

function withCorpus(fn) {
  const corpus = makeCorpus();
  try {
    return fn(corpus);
  } finally {
    fs.rmSync(corpus.dir, { recursive: true, force: true });
  }
}

test('the fixture reaches both projects unscoped, so a dropped --project is visible', () => {
  withCorpus((corpus) => {
    // Without this, every scoped assertion below passes against a corpus that
    // only ever held one project's hit.
    const { ids } = search(corpus, [TOKEN, '--format', 'jsonl', '--all']);
    assert.ok(ids.includes(ALPHA_HIT), `alpha hit missing: ${ids}`);
    assert.ok(ids.includes(BETA_HIT), `beta hit missing: ${ids}`);
  });
});

test('flags before the query scope the search and the query is the real one', () => {
  withCorpus((corpus) => {
    const { rows, ids } = search(corpus, [
      '--project', 'projalpha', '--since', '2025-12-01', '--limit', '5', '--format', 'jsonl', '--all', TOKEN,
    ]);
    assert.deepEqual(ids, [ALPHA_HIT]);
    assert.ok(rows.every((row) => row.project === 'projalpha'), `leaked projects: ${rows.map((r) => r.project)}`);

    // The telemetry rows are what hit-rate and attribution reports read; a
    // query of "--project" there poisons all of them.
    const calls = readJsonl(corpus.calls);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].query, TOKEN);
    assert.equal(calls[0].project, 'projalpha');
    assert.equal(calls[0].since, '2025-12-01');
    const served = readJsonl(corpus.served);
    assert.ok(served.length >= 1, 'a served row must exist for the query assertion to mean anything');
    for (const row of served) assert.equal(row.query, TOKEN, `served row query: ${row.query}`);
  });
});

test('flags after the query behave the same as flags before it', () => {
  withCorpus((corpus) => {
    const first = search(corpus, ['--project', 'projbeta', '--format', 'jsonl', '--all', TOKEN]);
    const last = search(corpus, [TOKEN, '--project', 'projbeta', '--format', 'jsonl', '--all']);
    assert.deepEqual(last.ids, first.ids);
    assert.deepEqual(last.ids, [BETA_HIT]);
  });
});

test('flags on both sides of the query, and the --flag=value spelling', () => {
  withCorpus((corpus) => {
    const mixed = search(corpus, ['--format', 'jsonl', TOKEN, '--project', 'projalpha', '--all']);
    assert.deepEqual(mixed.ids, [ALPHA_HIT]);
    const equals = search(corpus, [`--project=projbeta`, TOKEN, '--format=jsonl', '--all']);
    assert.deepEqual(equals.ids, [BETA_HIT]);
    const calls = readJsonl(corpus.calls);
    assert.deepEqual(calls.map((row) => row.query), [TOKEN, TOKEN]);
    assert.deepEqual(calls.map((row) => row.project), ['projalpha', 'projbeta']);
  });
});

test('several unquoted words are joined into one query, not truncated to the first', () => {
  withCorpus((corpus) => {
    const { ids } = search(corpus, ['--project', 'projalpha', '--format', 'jsonl', '--all', TOKEN, SECOND]);
    assert.deepEqual(ids, [ALPHA_HIT]);
    const calls = readJsonl(corpus.calls);
    // The old parser kept only TOKEN here and dropped SECOND without a word.
    assert.equal(calls[0].query, `${TOKEN} ${SECOND}`);
    for (const row of readJsonl(corpus.served)) assert.equal(row.query, `${TOKEN} ${SECOND}`);
  });
});

test('"--" ends flag parsing so a query that starts with "--" is still searchable', () => {
  withCorpus((corpus) => {
    const query = `--${DASH_TOKEN}`;
    const { ids } = search(corpus, ['--project', 'projalpha', '--format', 'jsonl', '--all', '--', query]);
    assert.deepEqual(ids, [ALPHA_DASH]);
    assert.equal(readJsonl(corpus.calls)[0].query, query);
  });
});

test('a dash-leading token that is not a flag is refused rather than searched or dropped', () => {
  withCorpus((corpus) => {
    for (const bad of [`--${DASH_TOKEN}`, '--projct', '-p']) {
      const result = run(corpus, ['--project', 'projalpha', '--format', 'jsonl', bad, TOKEN]);
      assert.equal(result.status, 2, `${bad}: ${result.stdout}`);
      assert.match(result.stderr, new RegExp(`unknown option '${bad}'`));
      assert.equal(result.stdout, '', `${bad}: nothing may be served for a refused call`);
    }
    // Refusal is not a search: no call row, no served row.
    assert.deepEqual(readJsonl(corpus.calls), []);
    assert.deepEqual(readJsonl(corpus.served), []);
  });
});

test('--get, --touch and --thread need no placeholder, and "_" is still accepted', () => {
  withCorpus((corpus) => {
    const get = run(corpus, ['--get', ALPHA_HIT]);
    assert.equal(get.status, 0, get.stderr);
    assert.ok(get.stdout.includes(ALPHA_HIT), get.stdout);
    assert.ok(get.stdout.includes(TOKEN), 'the complete record must come back');

    const legacy = run(corpus, ['_', '--get', ALPHA_HIT]);
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.equal(legacy.stdout, get.stdout, 'the placeholder must not change the answer');

    // A flag in front of the control op, still no placeholder.
    const flagged = run(corpus, ['--call-id', 'call-argorder-1', '--get', ALPHA_HIT]);
    assert.equal(flagged.status, 0, flagged.stderr);
    assert.ok(flagged.stdout.includes(ALPHA_HIT));

    const before = readJsonl(corpus.ledger).length;
    const touch = run(corpus, ['--touch', ALPHA_HIT]);
    assert.equal(touch.status, 0, touch.stderr);
    assert.match(touch.stdout, /recorded 1 reuse access/);
    const legacyTouch = run(corpus, ['_', '--touch', ALPHA_HIT]);
    assert.equal(legacyTouch.status, 0, legacyTouch.stderr);
    const ledger = readJsonl(corpus.ledger).slice(before);
    assert.ok(ledger.length >= 2 && ledger.every((row) => row.event_id === ALPHA_HIT),
      `touch rows: ${JSON.stringify(ledger)}`);

    const thread = run(corpus, ['--thread', ALPHA_HIT]);
    assert.equal(thread.status, 0, thread.stderr);
    assert.ok(thread.stdout.includes(ALPHA_HIT), thread.stdout);
    const legacyThread = run(corpus, ['_', '--thread', ALPHA_HIT]);
    assert.equal(legacyThread.status, 0, legacyThread.stderr);
    assert.equal(legacyThread.stdout, thread.stdout);
  });
});

test('a value flag with no value fails in one line naming the flag', () => {
  withCorpus((corpus) => {
    const valueFlags = ['--project', '--limit', '--format', '--since', '--before', '--intent',
      '--thread', '--get', '--touch', '--call-id', '--purpose'];
    for (const flag of valueFlags) {
      // Last argument: nothing follows it.
      const atEnd = run(corpus, [TOKEN, flag]);
      assert.equal(atEnd.status, 2, `${flag} at end: ${atEnd.stdout}`);
      assert.equal(atEnd.stderr.trim(), `cartographer-search: ${flag} requires a value`);

      // Followed by another flag: the next flag must not be swallowed as the value.
      const beforeFlag = run(corpus, [flag, '--all', TOKEN]);
      assert.equal(beforeFlag.status, 2, `${flag} before --all: ${beforeFlag.stdout}`);
      assert.equal(beforeFlag.stderr.trim(), `cartographer-search: ${flag} requires a value`);
    }
    // The real incident: --project given no value used to eat the next token.
    const eaten = run(corpus, ['--project', '--since', '10d', TOKEN]);
    assert.equal(eaten.status, 2);
    assert.equal(eaten.stderr.trim(), 'cartographer-search: --project requires a value');
    assert.deepEqual(readJsonl(corpus.calls), [], 'a refused call must not look like a search');
  });
});

test('an explicit empty value is still a value', () => {
  withCorpus((corpus) => {
    // Wrappers write --project "$P" with P empty to mean "no scope".
    const { ids } = search(corpus, ['--project', '', '--format', 'jsonl', '--all', TOKEN]);
    assert.ok(ids.includes(ALPHA_HIT) && ids.includes(BETA_HIT), `unscoped expected: ${ids}`);
  });
});

test('a plain search with no query fails with the usage line', () => {
  withCorpus((corpus) => {
    for (const args of [[], [''], ['--project', 'projalpha'], ['--format', 'jsonl', '--all']]) {
      const result = run(corpus, args);
      assert.equal(result.status, 2, `args ${JSON.stringify(args)}: ${result.stdout}`);
      assert.match(result.stderr, /no query given/);
      assert.match(result.stderr, /Usage: cartographer-search\.sh "<query>"/);
      assert.equal(result.stdout, '');
    }
    assert.deepEqual(readJsonl(corpus.calls), []);
  });
});

test('--help prints the usage and exits 0 without searching', () => {
  withCorpus((corpus) => {
    const result = run(corpus, ['--help']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: cartographer-search\.sh/);
    assert.deepEqual(readJsonl(corpus.calls), []);
  });
});
