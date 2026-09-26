// bm25-search.awk read a JSON string value up to its first double quote,
// escaped or not, so every token after an embedded \" was invisible to the
// portable CLI keyword engine while explorer/server/bm25.js, which parses the
// JSON, still matched it. Measured 2026-09-25: 37,711 of 135,315 changelog
// summaries and 37,074 of 109,489 tool-use summaries were cut short. Nothing
// errored; /remember with Turbo off just never returned those rows.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, scoreBM25, tokenize } from '../../explorer/server/bm25.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const SEARCH = join(ROOT, 'scripts', 'cartographer-search.sh');
const AWK = join(ROOT, 'scripts', 'bm25-search.awk');

// Each target puts its query term behind an escape the first-quote cut
// mishandled. JSON.stringify writes the escapes, so the raw lines are exactly
// what a hook writes.
const TARGETS = [
  { id: 'evt-escquote', term: 'zebracorn',
    summary: 'Ran: git commit -m "fix(search): tidy scorer" && echo zebracorn' },
  // An escaped backslash directly before an escaped quote: \\\" in raw JSON.
  { id: 'evt-escbackslashquote', term: 'ocelot',
    summary: 'Ran: cp C:\\tmp\\"odd name" into place; ocelot' },
  // A \n escape separates tokens for JSON.parse. Read raw, it glued the
  // escape's n onto the term and the scorer saw "nnarwhal".
  { id: 'evt-escnewline', term: 'narwhal',
    summary: 'Ran: first line\nnarwhal on the second' },
];

// The value ends in an escaped backslash, so the closing quote follows \\ and
// must still close it.
const TRAILING = { id: 'evt-trailingbackslash', summary: 'gibbon path ends C:\\work\\' };

function event(id, summary, i) {
  return {
    event_id: id,
    timestamp: `2026-09-${String(10 + (i % 15)).padStart(2, '0')}T12:00:00Z`,
    project: 'fixtureproject',
    type: 'tool_bash',
    summary,
    session_id: 'sid-fixture',
  };
}

// Filler keeps each term's df well under half the corpus; past that BM25's
// idf clamps to zero and every assertion below would pass on an empty result.
const EVENTS = [
  ...TARGETS.map((t, i) => event(t.id, t.summary, i)),
  event(TRAILING.id, TRAILING.summary, 3),
  ...Array.from({ length: 30 }, (_, i) =>
    event(`evt-filler-${i}`, `Ran: routine filler command number ${i} touching unrelated files`, i + 4)),
];
const LINES = EVENTS.map((e) => JSON.stringify(e));

let dir;
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), 'carto-escapes-'));
  writeFileSync(join(dir, 'changelog.jsonl'), `${LINES.join('\n')}\n`);
  for (const log of ['research-log', 'session-milestones', 'tool-use-log', 'prompt-history']) {
    writeFileSync(join(dir, `${log}.jsonl`), '');
  }
});
test.after(() => rmSync(dir, { recursive: true, force: true }));

function cliEnv() {
  const env = { ...process.env };
  for (const key of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) {
    delete env[key];
  }
  return {
    ...env,
    CARTOGRAPHER_DEV_DIR: dir,
    CARTOGRAPHER_TURBO: '0',
    CARTOGRAPHER_SEMANTIC: '0',
    // The CLI does not read CARTOGRAPHER_SEMANTIC. Its semantic leg returns
    // nothing when Qdrant is unreachable, so point it at a closed port, or a
    // live Qdrant adds corpus rows to every query here.
    CARTOGRAPHER_QDRANT_URL: 'http://127.0.0.1:1',
    CARTOGRAPHER_SERVED_LOG: join(dir, 'served-log.jsonl'),
    CARTOGRAPHER_ACCESS_LEDGER: join(dir, 'access-ledger.jsonl'),
  };
}

function cliRows(query) {
  const r = spawnSync('bash', [SEARCH, query, '--limit', '10', '--format', 'jsonl', '--all'], {
    encoding: 'utf8', env: cliEnv(),
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
}

// The keyword scorer alone, the way cartographer-search.sh runs it without the
// grep prefilter: pass 1 and pass 2 over the same file.
function awkRows(query) {
  const out = execFileSync('awk', [
    '-f', AWK, '-v', `query=${query}`, '-v', 'src=changelog', '-v', 'max_results=500',
    join(dir, 'changelog.jsonl'), join(dir, 'changelog.jsonl'),
  ], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return out.split('\n').filter(Boolean).map((line) => line.split('\t'));
}

test('the fixture hides each term from a cut at the first quote', () => {
  // Without this, the CLI test below could pass against the unfixed awk.
  for (const t of TARGETS) {
    const raw = LINES.find((l) => l.includes(`"${t.id}"`));
    const value = raw.slice(raw.indexOf('"summary":"') + '"summary":"'.length);
    const firstQuoteCut = value.slice(0, value.indexOf('"'));
    assert.ok(!firstQuoteCut.toLowerCase().split(/[^a-z0-9]+/).includes(t.term),
      `${t.id}: "${t.term}" must not be a token of the first-quote cut, or the fixture proves nothing`);
    assert.ok(tokenize(t.summary).includes(t.term), `${t.id}: JSON.parse must see "${t.term}"`);
  }
});

test('the portable CLI returns a row whose query term follows an escape', () => {
  for (const t of TARGETS) {
    const rows = cliRows(t.term);
    assert.deepEqual(rows.map((r) => r.event_id), [t.id],
      `${t.term}: expected exactly ${t.id} from the keyword ladder`);
    assert.equal(rows[0].source, 'changelog');
  }
});

test('the awk and JS engines match the same rows on the same fixture', () => {
  // Parity on token streams, not just on the targets: the fixture rows carry
  // no cwd, display or title, the fields only one engine reads.
  const index = buildIndex(EVENTS);
  for (const query of ['zebracorn', 'ocelot', 'narwhal', 'gibbon', 'tidy', 'scorer', 'place', 'second']) {
    const awk = awkRows(query).map((r) => r[2]).sort();
    const js = scoreBM25(index, query).items.map((it) => it.id).sort();
    assert.ok(js.length > 0, `${query}: the JS engine must match something for parity to mean anything`);
    assert.deepEqual(awk, js, `${query}: awk and JS disagree about which rows contain it`);
  }
});

test('a value ending in an escaped backslash stops at its own closing quote', () => {
  const row = awkRows('gibbon').find((r) => r[2] === TRAILING.id);
  assert.ok(row, 'the trailing-backslash row must score');
  // Decoded once: C:\work\ followed by the event_id get_search_text appends.
  // Stopping early leaves C:\\work\\ undecoded; running past the quote pulls
  // in the next key.
  assert.ok(row[5].includes('C:\\work\\ evt-trailingbackslash'), `summary was: ${row[5]}`);
  assert.ok(!row[5].includes('"'), `summary ran past its closing quote: ${row[5]}`);
});
