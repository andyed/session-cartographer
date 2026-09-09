// The projector is the only writer that mints ids for a corpus another writer
// (backfill-event-ids.js) also identifies, and the only one whose source it does
// not control. Both properties fail silently: a drifted id duplicates records,
// and a mis-read timestamp unit indexes cleanly while sorting wrong forever.
//
// Every test here runs against a fixture history file via
// CARTOGRAPHER_CLAUDE_HISTORY — nothing touches ~/.claude/history.jsonl.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(root, 'scripts', 'build-prompt-history.js');

const SESSION = '11111111-2222-3333-4444-555555555555';
const GONE = '99999999-8888-7777-6666-555555555555';

// 2026-03-01T12:00:00Z in epoch milliseconds.
const MS = Date.UTC(2026, 2, 1, 12, 0, 0);

const HISTORY = [
  { display: 'why does the fusion awk drop rows with an empty key', pastedContents: {}, timestamp: MS, project: '/Users/x/Documents/dev/session-cartographer', sessionId: SESSION },
  { display: 'first line\nsecond line\twith a tab\r\nand a return', pastedContents: {}, timestamp: MS + 1000, project: '/Users/x/Documents/dev/session-cartographer', sessionId: SESSION },
  { display: '[Pasted text #3 +412 lines]', pastedContents: {}, timestamp: MS + 2000, project: '/Users/x/Documents/dev/psychodeli-webgl-port', sessionId: GONE },
  // junk: empty, whitespace-only, and a bare slash command under 4 chars
  { display: '', pastedContents: {}, timestamp: MS + 3000, project: '/Users/x/Documents/dev', sessionId: SESSION },
  { display: '   \n  ', pastedContents: {}, timestamp: MS + 4000, project: '/Users/x/Documents/dev', sessionId: SESSION },
  { display: '/ok', pastedContents: {}, timestamp: MS + 5000, project: '/Users/x/Documents/dev', sessionId: SESSION },
  // kept: a longer bare command, and a short command that carries an argument
  { display: '/wrapup', pastedContents: {}, timestamp: MS + 6000, project: '/Users/x/Documents/dev', sessionId: SESSION },
  { display: '/go now', pastedContents: {}, timestamp: MS + 7000, project: '/Users/x/Documents/dev', sessionId: SESSION },
  // wrong unit: seconds instead of milliseconds -> 1970, must be rejected
  { display: 'this row has a seconds timestamp', pastedContents: {}, timestamp: Math.floor(MS / 1000), project: '/Users/x/Documents/dev', sessionId: SESSION },
  // wrong unit the other way: microseconds -> far future, must be rejected
  { display: 'this row has a microseconds timestamp', pastedContents: {}, timestamp: MS * 1000, project: '/Users/x/Documents/dev', sessionId: SESSION },
];

const KEPT = 4; // rows 0,1,2,7 — /wrapup now joins the dropped bare commands

function scratch() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-prompts-'));
  const dev = path.join(dir, 'dev');
  const transcripts = path.join(dir, 'projects');
  fs.mkdirSync(dev);
  // Only SESSION has a surviving transcript; GONE is an expired one, which is
  // the population this log exists to preserve.
  const projectDir = path.join(transcripts, '-Users-x-Documents-dev-session-cartographer');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${SESSION}.jsonl`), '{}\n');
  const source = path.join(dir, 'history.jsonl');
  fs.writeFileSync(source, HISTORY.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, dev, transcripts, source, out: path.join(dev, 'prompt-history.jsonl') };
}

const run = (s, args = []) =>
  execFileSync('node', [script, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CARTOGRAPHER_DEV_DIR: s.dev,
      CARTOGRAPHER_CLAUDE_HISTORY: s.source,
      CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: s.transcripts,
      // Delta serving is real; a harness that inherits a live session id loses
      // repeat results and fails passing tests.
      CARTOGRAPHER_SESSION_ID: '',
      CLAUDE_SESSION_ID: '',
      CLAUDE_CODE_SESSION_ID: '',
      CODEX_SESSION_ID: '',
    },
  });

const rows = (s) =>
  fs.readFileSync(s.out, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('a dry run writes nothing', () => {
  const s = scratch();
  run(s);
  assert.equal(fs.existsSync(s.out), false, 'the dry run must not create the log');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('the record contract holds for every projected row', () => {
  const s = scratch();
  run(s, ['--write']);
  const out = rows(s);
  assert.equal(out.length, KEPT);
  for (const r of out) {
    assert.match(r.event_id, /^evt-[0-9a-f]{12}$/, 'ids are evt- plus 12 lowercase hex');
    assert.match(r.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    assert.equal(r.type, 'prompt');
    assert.equal(r.provider, 'claude');
    assert.equal(r.salience, 0.6);
    assert.ok(typeof r.summary === 'string' && r.summary !== '');
    assert.equal(r.project, path.basename(r.cwd), 'project is the cwd basename');
    // Absence is an omitted key, never the truthy sentinel "unknown".
    for (const key of ['project', 'cwd', 'session_id', 'transcript_path']) {
      if (key in r) assert.notEqual(r[key], 'unknown');
    }
  }
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('summaries are single-line — the TSV pipeline splits on a newline', () => {
  const s = scratch();
  run(s, ['--write']);
  const out = rows(s);
  for (const r of out) {
    assert.ok(!/[\r\n\t]/.test(r.summary), `summary must not contain \\r \\n or \\t: ${JSON.stringify(r.summary)}`);
  }
  const flattened = out.find((r) => r.summary.startsWith('first line'));
  assert.equal(flattened.summary, 'first line second line with a tab and a return');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('epoch milliseconds convert to the right instant, and wrong units are refused', () => {
  const s = scratch();
  run(s, ['--write']);
  const out = rows(s);
  const first = out.find((r) => r.summary.startsWith('why does the fusion'));
  assert.equal(first.timestamp, '2026-03-01T12:00:00Z');
  assert.ok(out.every((r) => Number(r.timestamp.slice(0, 4)) === 2026));
  assert.ok(!out.some((r) => r.summary.includes('seconds timestamp')), 'a seconds timestamp lands in 1970 and must be skipped');
  assert.ok(!out.some((r) => r.summary.includes('microseconds timestamp')), 'a microseconds timestamp lands in the far future and must be skipped');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('junk is skipped and real stubs are kept', () => {
  const s = scratch();
  const out = run(s, ['--write']);
  const summaries = rows(s).map((r) => r.summary);
  assert.ok(!summaries.includes(''), 'empty prompts are dropped');
  // The test is arguments, not length. A bare command records that a control
  // was operated; a command with arguments records what the user wanted. In the
  // real corpus a length floor pruned nothing — the shortest bare command is
  // /help at 5 characters — while 568 rows are bare /clear, /exit, /compact,
  // /login. /wrapup goes with them: the synthesis it produces is already in the
  // log as a milestone at salience 0.9, far richer than the string that invoked it.
  assert.ok(!summaries.includes('/ok'), 'a bare slash command is dropped');
  assert.ok(!summaries.includes('/wrapup'), 'length does not rescue a bare command');
  assert.ok(summaries.includes('/go now'), 'a command with an argument is a real record');
  assert.ok(summaries.some((t) => t.startsWith('[Pasted text #3')), 'paste stubs are real records');
  assert.match(out, /empty\s+2/);
  assert.match(out, /slash-command\s+2/);
  assert.match(out, /bad-timestamp\s+2/);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('transcript_path is present when the transcript survives and omitted when it does not', () => {
  const s = scratch();
  run(s, ['--write']);
  const out = rows(s);
  const live = out.find((r) => r.session_id === SESSION);
  assert.ok(live.transcript_path.endsWith(`${SESSION}.jsonl`));
  assert.equal(fs.existsSync(live.transcript_path), true);
  const expired = out.find((r) => r.session_id === GONE);
  assert.ok(!('transcript_path' in expired), 'an expired transcript omits the key rather than pointing at nothing');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('ids are deterministic across independent corpora', () => {
  const a = scratch();
  const b = scratch();
  run(a, ['--write']);
  run(b, ['--write']);
  assert.deepEqual(rows(a).map((r) => r.event_id), rows(b).map((r) => r.event_id));
  assert.equal(new Set(rows(a).map((r) => r.event_id)).size, KEPT, 'ids must be unique');
  fs.rmSync(a.dir, { recursive: true, force: true });
  fs.rmSync(b.dir, { recursive: true, force: true });
});

test('an id does not move when the transcript later expires', () => {
  // transcript_path is a fact about the filesystem today, not about the prompt.
  // If it fed the digest, every record would be re-minted and re-appended the
  // month its transcript aged out.
  const s = scratch();
  run(s, ['--write']);
  const before = rows(s).map((r) => r.event_id);
  fs.rmSync(s.transcripts, { recursive: true, force: true });
  const out = run(s, ['--write']);
  assert.deepEqual(rows(s).map((r) => r.event_id), before, 'no row may be re-minted');
  assert.match(out, /projected:\s+0/);
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('a second run adds nothing; a grown source adds only the new rows', () => {
  const s = scratch();
  run(s, ['--write']);
  const first = rows(s);
  const second = run(s, ['--write']);
  assert.match(second, /projected:\s+0/);
  assert.deepEqual(rows(s), first, 'a re-run must be byte-identical');

  fs.appendFileSync(s.source, JSON.stringify({
    display: 'a brand new prompt', pastedContents: {}, timestamp: MS + 60000,
    project: '/Users/x/Documents/dev/session-cartographer', sessionId: SESSION,
  }) + '\n');
  run(s, ['--write']);
  const grown = rows(s);
  assert.equal(grown.length, first.length + 1);
  assert.deepEqual(grown.slice(0, first.length), first, 'existing rows are untouched');
  assert.equal(grown[grown.length - 1].summary, 'a brand new prompt');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('an output file with no trailing newline is appended to, not welded onto', () => {
  const s = scratch();
  fs.writeFileSync(s.out, JSON.stringify({ event_id: 'evt-preexisting1', timestamp: '2026-01-01T00:00:00Z', summary: 'no trailing newline' }));
  run(s, ['--write']);
  const out = rows(s);
  assert.equal(out.length, KEPT + 1);
  assert.equal(out[0].event_id, 'evt-preexisting1');
  fs.rmSync(s.dir, { recursive: true, force: true });
});

test('the projector and the id backfill mint the same id for the same record', () => {
  // If these two ever diverge, the projector re-adds rows the backfill already
  // identified and the corpus grows a duplicate of every prompt.
  const s = scratch();
  run(s, ['--write']);
  const projected = rows(s)[0];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-agree-'));
  const { event_id: _drop, transcript_path: _path, salience: _s, provider: _p, ...identity } = projected;
  fs.writeFileSync(path.join(dir, 'research-log.jsonl'), JSON.stringify(identity) + '\n');
  for (const other of ['changelog.jsonl', 'session-milestones.jsonl', 'tool-use-log.jsonl']) {
    fs.writeFileSync(path.join(dir, other), '');
  }
  execFileSync('node', [path.join(root, 'scripts', 'backfill-event-ids.js'), '--write'],
    { encoding: 'utf8', env: { ...process.env, CARTOGRAPHER_DEV_DIR: dir } });
  const backfilled = JSON.parse(fs.readFileSync(path.join(dir, 'research-log.jsonl'), 'utf8').split('\n')[0]);
  assert.equal(backfilled.event_id, projected.event_id);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(s.dir, { recursive: true, force: true });
});
