process.env.CARTOGRAPHER_SEMANTIC = '0';

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HermesSourceError, buildTurns, collect, loadConfig, makeRedactor, openReadOnly,
} from '../../scripts/hermes-source.js';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'hermes-source.js');
const CODEX_ADAPTER = path.join(ROOT, 'scripts', 'codex-transcript-to-turns.awk');
const { DatabaseSync } = await import('node:sqlite');

// Words the fixtures plant so absence can be asserted. Each one is present in
// the fixture database; a test that only checked output would pass on a
// fixture that never contained it.
const PROMPT_SENTINEL = 'PULSE-SENTINEL counted section';
const SECRET = 'Acme internal roadmap';
const TOOL_RESULT = 'TOOL-RESULT-SENTINEL';

const T0 = 1_790_000_000; // 2026-09 in epoch seconds

function tempDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function makeDb(file, sessions) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, started_at REAL NOT NULL,
      ended_at REAL, cwd TEXT, git_repo_root TEXT, parent_session_id TEXT, hidden INTEGER DEFAULT 0,
      message_count INTEGER DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      compacted INTEGER NOT NULL DEFAULT 0, _compressed_summary INTEGER NOT NULL DEFAULT 0);`);
  const insS = db.prepare('INSERT INTO sessions (id, source, title, started_at, ended_at, cwd, git_repo_root, parent_session_id) VALUES (?,?,?,?,?,?,?,?)');
  const insM = db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, compacted, _compressed_summary) VALUES (?,?,?,?,?,?,?,?)');
  for (const s of sessions) {
    insS.run(s.id, s.source, s.title ?? null, s.started_at ?? T0, s.ended_at ?? T0 + 600, s.cwd ?? null, s.git_repo_root ?? null, s.parent ?? null);
    s.messages.forEach((m, i) => insM.run(s.id, m.role, m.content ?? null, m.tool_calls ?? null,
      m.timestamp ?? (s.started_at ?? T0) + i, m.active ?? 1, m.compacted ?? 0, m.summary ?? 0));
  }
  db.close();
}

const call = (name, args = {}) => JSON.stringify([{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }]);

function fixture({ devRoot = '/nowhere/dev', exclude = [], redact = ['acme internal'], extra = [] } = {}) {
  const home = tempDir('carto-hermes-home-');
  makeDb(path.join(home, 'state.db'), [
    {
      id: 'conv-1', source: 'desktop', title: 'Design the "adapter" quillfeather',
      messages: [
        { role: 'user', content: 'Plan the Hermes adapter\nIt should mention the Acme internal roadmap here' },
        { role: 'assistant', content: 'Reading the schema', tool_calls: call('terminal', { cmd: 'ls' }) },
        { role: 'tool', content: TOOL_RESULT },
        { role: 'assistant', content: 'Sessions are rows, not files' },
        { role: 'user', content: 'Now write the turn grouper please' },
        { role: 'assistant', content: 'Grouping user to next user' },
      ],
    },
    {
      id: 'single-shot', source: 'desktop', title: 'Magazine call',
      messages: [{ role: 'user', content: 'Write a headline' }, { role: 'assistant', content: 'Headline' }],
    },
    {
      id: 'cron_aaaaaaaaaaaa_20260925_040000', source: 'cron', title: 'daily-digest · Sep 25 04:00',
      messages: [
        { role: 'user', content: `Run the digest.\n${PROMPT_SENTINEL}: 736 events` },
        { role: 'assistant', content: '', tool_calls: call('read_file') },
        { role: 'tool', content: TOOL_RESULT },
        { role: 'assistant', content: 'Digest written: three forecasts moved' },
      ],
    },
    {
      id: 'cron_bbbbbbbbbbbb_20260925_050000', source: 'cron', title: 'consolidation · Sep 25 05:00',
      messages: [
        { role: 'user', content: 'Consolidate' },
        { role: 'assistant', content: 'Consolidation reply duplicated by its artifact' },
      ],
    },
    {
      id: 'compacted-1', source: 'desktop', title: 'Long chat',
      messages: [
        { role: 'user', content: 'A first prompt long enough to count as a copy', compacted: 1, active: 0 },
        { role: 'assistant', content: 'First answer', compacted: 1, active: 0 },
        { role: 'assistant', content: '[PRIOR CONTEXT] synthetic digest', summary: 1 },
        { role: 'user', content: 'A first prompt long enough to count as a copy' },
        { role: 'user', content: 'A rewound prompt that the user abandoned', active: 0 },
        { role: 'user', content: 'Second real prompt' },
        { role: 'assistant', content: 'Second answer' },
      ],
    },
    ...extra,
  ]);
  const notes = path.join(home, 'workspace', 'notes');
  fs.mkdirSync(notes, { recursive: true });
  fs.writeFileSync(path.join(notes, 'README.md'), '# Notes\n\nHow notes work.\n');
  fs.writeFileSync(path.join(notes, '2026-09-25.md'),
    '# Daily Note — 2026-09-25\n\nWhat changed "overnight" in the zebracorn study.\n\n## Observed\nThe adapter shipped.\nNo Acme internal systems were touched.\n\n## Forecast\nMore rows tomorrow.\n');

  const configPath = path.join(home, 'hermes.json');
  fs.writeFileSync(configPath, JSON.stringify({
    hermes_home: home,
    sources: ['desktop', 'cron'],
    default_project: 'agent',
    path_projects: {},
    cron_projects: { aaaaaaaaaaaa: 'digests' },
    cron_skip_turns: ['bbbbbbbbbbbb'],
    exclude_projects: exclude,
    redact_patterns: redact,
    artifacts: [{ kind: 'note', dir: 'workspace/notes', match: '^\\d{4}-\\d{2}-\\d{2}\\.md$', salience: 0.8 }],
  }));
  return { home, configPath, devRoot };
}

async function run(fx, opts = {}) {
  const config = loadConfig(fx.configPath);
  return collect(config, { devRoot: fx.devRoot, now: T0 + 86400, resolveDir: (d) => path.basename(d), ...opts });
}

const allRecords = (units) => units.flatMap((u) => [...u.rows, ...u.docs]);
const sessionUnit = (units, id) => units.find((u) => u.kind === 'session' && u.session.id === id);

describe('hermes-source turn contract', () => {
  test('emits the provider-neutral turn shape the Claude and Codex adapters emit', async () => {
    const fx = fixture();
    const { units } = await run(fx);
    const turns = sessionUnit(units, 'conv-1').docs;

    const codexFile = path.join(tempDir('carto-hermes-codex-'), 'rollout.jsonl');
    fs.writeFileSync(codexFile, [
      { timestamp: '2026-09-25T10:00:00Z', type: 'session_meta', payload: { id: 's' } },
      { timestamp: '2026-09-25T10:00:01Z', type: 'event_msg', payload: { type: 'user_message', message: 'hi' } },
    ].map(JSON.stringify).join('\n') + '\n');
    const codexTurn = JSON.parse(execFileSync('awk', ['-f', CODEX_ADAPTER, '-v', 'sid=s', '-v', 'proj=p', '-v', `tpath=${codexFile}`, codexFile], { encoding: 'utf8' }).trim());

    // Hermes has no transcript file; it adds a salience prior. Nothing else differs.
    const expected = new Set([...Object.keys(codexTurn).filter((k) => k !== 'transcript_path'), 'salience']);
    for (const t of turns) {
      const { _rowid, ...payload } = t;
      assert.deepEqual(new Set(Object.keys(payload)), expected);
      assert.equal(payload.type, 'transcript');
      assert.equal(payload.provider, 'hermes');
      assert.match(payload.event_id, /^turn-hermes-conv-1-\d+$/);
    }
  });

  test('groups from one user prompt to the next, never per response', async () => {
    const { units } = await run(fixture());
    const turns = sessionUnit(units, 'conv-1').docs;
    assert.equal(turns.length, 2, 'two prompts, four responses: two turns');
    assert.match(turns[0].summary, /Plan the Hermes adapter.*Reading the schema.*Sessions are rows/);
    assert.match(turns[0].summary, /\[tools: terminal\]/);
    assert.match(turns[1].summary, /turn grouper.*user to next user/);
    assert.deepEqual(turns.map((t) => t.turn_idx), [1, 2]);
  });

  test('never indexes tool results', async () => {
    const fx = fixture();
    const db = new DatabaseSync(path.join(fx.home, 'state.db'), { readOnly: true });
    const { n } = db.prepare('SELECT count(*) AS n FROM messages WHERE content = ?').get(TOOL_RESULT);
    db.close();
    assert.equal(n, 2, 'fixture carries tool results');
    const { units } = await run(fx);
    assert.doesNotMatch(JSON.stringify(allRecords(units)), new RegExp(TOOL_RESULT));
  });

  test('skips synthetic digests, rewound prompts, and compaction re-inserts; keeps compacted originals', async () => {
    const { units } = await run(fixture());
    const text = JSON.stringify(sessionUnit(units, 'compacted-1').docs);
    assert.equal(text.match(/A first prompt long enough/g)?.length, 1, 'the re-inserted copy is not a second turn');
    assert.match(text, /First answer/, 'compacted original is history');
    assert.doesNotMatch(text, /synthetic digest/);
    assert.doesNotMatch(text, /abandoned/);
    assert.match(text, /Second real prompt/);
  });
});

describe('hermes-source cron runs', () => {
  test('indexes the final reply and never the prompt', async () => {
    const fx = fixture();
    const { units } = await run(fx);
    const unit = sessionUnit(units, 'cron_aaaaaaaaaaaa_20260925_040000');
    assert.equal(unit.rows[0].milestone, 'hermes_cron_run');
    assert.equal(unit.rows[0].cron_job, 'daily-digest');
    assert.equal(unit.project, 'digests', 'cron job map attributes the run');
    assert.equal(unit.docs.length, 1);
    assert.match(unit.docs[0].summary, /^daily-digest: Digest written/);
    assert.doesNotMatch(JSON.stringify(allRecords(units)), /PULSE-SENTINEL/);
  });

  test('a job whose output lives in an artifact keeps its row but gets no turn', async () => {
    const { units } = await run(fixture());
    const unit = sessionUnit(units, 'cron_bbbbbbbbbbbb_20260925_050000');
    assert.equal(unit.rows.length, 1);
    assert.equal(unit.docs.length, 0);
  });
});

describe('hermes-source privacy', () => {
  test('redacts matching lines, reports the count, and keeps the rest of the record', async () => {
    const fx = fixture();
    const { units, receipt } = await run(fx);
    const text = JSON.stringify(allRecords(units));
    assert.doesNotMatch(text, /acme internal/i);
    assert.match(text, /\[excluded\]/);
    assert.match(text, /Plan the Hermes adapter/, 'only the matching line goes');
    assert.equal(receipt.lines_redacted, 2, 'one planted line in a prompt, one in the note');

    // Prove the fixture exercises it: without the policy the secret gets through.
    const open = fixture({ redact: [] });
    const { units: leaky } = await run(open);
    assert.match(JSON.stringify(allRecords(leaky)), new RegExp(SECRET));
  });

  test('an excluded project produces no records and its name is redacted elsewhere', async () => {
    const extra = [{
      id: 'private-1', source: 'desktop', title: 'Private work', cwd: '/work/secret-proj/app',
      messages: [{ role: 'user', content: 'private prompt one' }, { role: 'user', content: 'private prompt two' }],
    }, {
      id: 'mentions-1', source: 'desktop', title: 'Report',
      messages: [{ role: 'user', content: 'Skipped secret-proj on purpose\nkept line' }, { role: 'user', content: 'again' }],
    }];
    const baseline = await run(fixture({ extra }));
    assert.ok(sessionUnit(baseline.units, 'private-1'), 'fixture session passes without the policy');

    const { units, receipt } = await run(fixture({ extra, exclude: ['secret-proj'] }));
    assert.equal(sessionUnit(units, 'private-1'), undefined);
    assert.equal(receipt.sessions_excluded, 1);
    const text = JSON.stringify(allRecords(units));
    assert.doesNotMatch(text, /private prompt/);
    assert.doesNotMatch(text, /secret-proj/i);
    assert.match(text, /kept line/);
  });

  test('refuses a Hermes home that resolves under .openclaw', () => {
    const dir = tempDir('carto-hermes-oc-');
    const home = path.join(dir, '.openclaw', 'hermes');
    fs.mkdirSync(home, { recursive: true });
    const cfg = path.join(dir, 'hermes.json');
    fs.writeFileSync(cfg, JSON.stringify({ hermes_home: home }));
    return assert.rejects(collect(loadConfig(cfg)), (err) => err instanceof HermesSourceError && /openclaw/.test(err.message));
  });

  test('refuses to run without an explicit policy file', () => {
    assert.throws(() => loadConfig('/nonexistent/hermes.json'), /refusing to ingest without an explicit policy/);
  });
});

describe('hermes-source filtering and attribution', () => {
  test('drops single-shot LLM calls routed through the agent', async () => {
    const { units, receipt } = await run(fixture());
    assert.equal(sessionUnit(units, 'single-shot'), undefined);
    assert.equal(receipt.sessions_filtered, 1);
  });

  test('cwd inside the corpus root goes through the shared resolver; tool paths resolve to a repository', async () => {
    const dev = tempDir('carto-hermes-dev-');
    fs.mkdirSync(path.join(dev, 'family', 'repo-a', 'src'), { recursive: true });
    const extra = [{
      id: 'cwd-1', source: 'desktop', cwd: path.join(dev, 'family', 'repo-a'),
      messages: [{ role: 'user', content: 'one' }, { role: 'user', content: 'two' }],
    }, {
      id: 'tools-1', source: 'desktop',
      messages: [
        { role: 'user', content: 'edit things' },
        { role: 'assistant', content: 'ok', tool_calls: call('patch', { path: `${dev}/family/repo-a/src/x.js` }) },
        { role: 'tool', content: 'patched' },
        { role: 'assistant', content: 'ok', tool_calls: call('patch', { path: `${dev}/family/repo-a/src/y.js` }) },
        { role: 'tool', content: 'patched' },
      ],
    }];
    const asked = [];
    const { units } = await run(fixture({ devRoot: dev, extra }), {
      resolveDir: (d) => { asked.push(d); return d.includes('repo-a') ? 'repo-a' : path.basename(d); },
    });
    assert.equal(sessionUnit(units, 'cwd-1').project, 'repo-a');
    assert.equal(sessionUnit(units, 'tools-1').project, 'repo-a', 'not the family directory');
    assert.ok(asked.includes(path.join(dev, 'family', 'repo-a', 'src')), 'resolved from the deepest existing directory');
    assert.equal(sessionUnit(units, 'conv-1').project, 'agent', 'no evidence → configured default');
  });
});

describe('hermes-source artifacts', () => {
  test('one row per content version with full text for BM25, sections for semantic recall', async () => {
    const fx = fixture();
    const { units } = await run(fx);
    const artifacts = units.filter((u) => u.kind === 'artifact');
    assert.equal(artifacts.length, 1, 'README is not an artifact');
    const [row] = artifacts[0].rows;
    assert.equal(row.milestone, 'hermes_note');
    assert.equal(row.transcript_path, path.join(fx.home, 'workspace', 'notes', '2026-09-25.md'));
    assert.match(row.description, /The adapter shipped.*More rows tomorrow/);
    assert.doesNotMatch(row.description, /[\n\r]/);
    assert.deepEqual(artifacts[0].docs.map((d) => d.parent_event_id), [row.event_id, row.event_id]);
    assert.match(artifacts[0].docs[0].summary, /§ Observed/);

    fs.appendFileSync(row.transcript_path, '\n## Update\nRevised.\n');
    const { units: again } = await run(fx);
    const next = again.find((u) => u.kind === 'artifact').rows[0];
    assert.notEqual(next.event_id, row.event_id, 'an edit is a new version, never a rewrite');
  });
});

describe('hermes-source read-only access', () => {
  test('never modifies the database it reads, and the handle refuses writes', async () => {
    const fx = fixture();
    const dbFile = path.join(fx.home, 'state.db');
    const digest = () => crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
    const before = digest();
    await run(fx);
    assert.equal(digest(), before);
    const db = await openReadOnly(dbFile);
    try {
      assert.throws(() => db.exec('CREATE TABLE x (a)'), /readonly|read-only|query_only/i);
    } finally {
      db.close();
    }
  });
});

describe('hermes-source --write', () => {
  function cli(fx, args, extraEnv = {}) {
    const work = fx.work || (fx.work = tempDir('carto-hermes-work-'));
    const indexLog = path.join(work, 'indexed.jsonl');
    const indexer = path.join(work, 'indexer.sh');
    if (!fs.existsSync(indexer)) {
      fs.writeFileSync(indexer, `#!/usr/bin/env bash\ninput=$(cat)\nprintf '%s\\t%s\\n' "\${PE_GATE_REJECT:-default}" "$input" >> "${indexLog}"\n[ "\${FAIL_INDEX:-}" = 1 ] && exit 75\nexit 0\n`);
      fs.chmodSync(indexer, 0o755);
    }
    const env = { ...process.env, ...OFFLINE_INDEX_ENV, CARTOGRAPHER_DEV_DIR: work, CARTOGRAPHER_INDEXER: indexer,
      CARTOGRAPHER_MILESTONES: path.join(work, 'session-milestones.jsonl'),
      CARTOGRAPHER_HERMES_STATE: path.join(work, 'state.json'), CARTOGRAPHER_HERMES_CONFIG: fx.configPath, ...extraEnv };
    for (const k of ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CARTOGRAPHER_SESSION_ID']) delete env[k];
    const result = spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: 'utf8' });
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : []);
    return { ...result, rows: read(env.CARTOGRAPHER_MILESTONES).map(JSON.parse), indexed: read(indexLog) };
  }

  test('dry run writes nothing', () => {
    const fx = fixture();
    const r = cli(fx, []);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry run/);
    assert.equal(r.rows.length, 0);
    assert.equal(r.indexed.length, 0);
  });

  test('appends once, indexes turns with the gate disabled, and a rerun is a no-op', () => {
    const fx = fixture();
    const first = cli(fx, ['--write']);
    assert.equal(first.status, 0, first.stderr);
    const ids = first.rows.map((r) => r.event_id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.includes('hermes-session-conv-1'));
    const turnLines = first.indexed.filter((l) => l.includes('"type":"transcript"'));
    assert.ok(turnLines.length >= 3);
    assert.ok(turnLines.every((l) => l.startsWith('2.0\t')), 'turn upserts must not self-reject at the novelty gate');
    const sectionLines = first.indexed.filter((l) => l.includes('"type":"hermes_artifact"'));
    assert.ok(sectionLines.length >= 2);
    assert.ok(sectionLines.every((l) => l.startsWith('0.97\t')), 'sections dedupe only near-verbatim repeats');
    const artifactRow = first.indexed.find((l) => l.includes('"milestone":"hermes_note"'));
    assert.match(artifactRow, /"type":"milestones"/, 'artifact rows ride the milestone path');

    const second = cli(fx, ['--write']);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.rows.length, first.rows.length, 'nothing appended twice');
    assert.equal(second.indexed.length, first.indexed.length, 'unchanged units are not re-indexed');
  });

  test('rows stay findable by the portable keyword engine past a double quote', () => {
    const fx = fixture();
    const note = fs.readFileSync(path.join(fx.home, 'workspace', 'notes', '2026-09-25.md'), 'utf8');
    assert.match(note, /"overnight" in the zebracorn/, 'fixture puts the term after a quote');
    const r = cli(fx, ['--write']);
    assert.equal(r.status, 0, r.stderr);
    const search = (q) => spawnSync('bash', [path.join(ROOT, 'scripts', 'cartographer-search.sh'), q, '--limit', '5'], {
      encoding: 'utf8',
      env: { ...process.env, ...OFFLINE_INDEX_ENV, CARTOGRAPHER_DEV_DIR: fx.work, CARTOGRAPHER_TURBO: '0', CARTOGRAPHER_SEMANTIC: '0',
        CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CODEX_SESSION_ID: '', CARTOGRAPHER_SESSION_ID: '' },
    }).stdout;
    // searchable() keeps quotes out of the row. bm25-search.awk cut a JSON string
    // at its first quote, escaped or not, until 2026-09-25; the reader side is
    // covered by keyword-json-escapes.test.js.
    assert.match(search('zebracorn'), /hermes-note-2026-09-25-/);
    assert.match(search('quillfeather'), /hermes-session-conv-1/);
  });

  test('--only artifacts re-indexes artifacts without touching sessions', () => {
    const fx = fixture();
    cli(fx, ['--write']);
    const before = fs.readFileSync(path.join(fx.work, 'indexed.jsonl'), 'utf8').trim().split('\n').length;
    const r = cli(fx, ['--write', '--full', '--only', 'artifacts']);
    assert.equal(r.status, 0, r.stderr);
    const fresh = r.indexed.slice(before);
    assert.ok(fresh.length > 0);
    assert.ok(fresh.every((l) => /hermes-note-/.test(l)), 'only artifact rows and their sections');
    assert.equal(cli(fx, ['--only', 'nonsense']).status, 2);
  });

  test('an indexing failure keeps the durable row, skips the checkpoint, and exits non-zero', () => {
    const fx = fixture();
    const failed = cli(fx, ['--write'], { FAIL_INDEX: '1' });
    assert.equal(failed.status, 1);
    assert.ok(failed.rows.length > 0, 'rows are written before indexing');
    const retried = cli(fx, ['--write']);
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(retried.rows.length, failed.rows.length, 'retry reuses rows by event_id');
    assert.ok(retried.indexed.length > failed.indexed.length, 'uncheckpointed units are retried');
  });

  test('a grown session re-indexes only its tail', () => {
    const fx = fixture();
    cli(fx, ['--write']);
    const before = fx.work && fs.readFileSync(path.join(fx.work, 'indexed.jsonl'), 'utf8').trim().split('\n').length;
    const db = new DatabaseSync(path.join(fx.home, 'state.db'));
    db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?,?,?,?)').run('conv-1', 'user', 'A third prompt arrives', T0 + 500);
    db.close();
    const after = cli(fx, ['--write']);
    const fresh = after.indexed.slice(before);
    assert.ok(fresh.some((l) => l.includes('A third prompt arrives')));
    assert.ok(!fresh.some((l) => l.includes('Plan the Hermes adapter')), 'turn one is not re-embedded');
    assert.ok(!fresh.some((l) => l.includes('"milestone":"hermes_session"')), 'the lifecycle row is written once');
  });
});

describe('hermes-source redactor', () => {
  test('matches whole lines case-insensitively and counts them', () => {
    const redact = makeRedactor([/\bacme\b/i]);
    const r = redact('Acme is a product\nacmes is a word\nACME again');
    assert.equal(r.text, '[excluded]\nacmes is a word\n[excluded]');
    assert.equal(r.redacted, 2);
  });

  test('buildTurns redacts before flattening, so a match cannot hide across lines', () => {
    const redact = makeRedactor([/secret/i]);
    const { turns, redacted } = buildTurns([
      { id: 1, role: 'user', content: 'ok line\nsecret line', timestamp: T0, active: true },
    ], { redact });
    assert.equal(turns[0].body, 'ok line [excluded]');
    assert.equal(redacted, 1);
  });
});
