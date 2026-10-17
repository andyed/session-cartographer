#!/usr/bin/env node
// repair-torn-rows.js — split rows that concurrent appends spliced together
// back into the records they were.
//
// Before hooks/common.sh's cartographer_append, a hook appended with bash's
// builtin printf, which writes through a 1024-byte line buffer on macOS. A
// row longer than that left in 1024-byte chunks, one write(2) each, and a
// second session appending at the same moment put its own chunks between them.
// On 2026-10-16 session-milestones.jsonl held three such pairs, six lines that
// do not parse:
//
//   line n    A[0:1024] + B whole            (B's last chunk ends the line)
//   line n+1  A[1024:]                       (A's last chunk, its own line)
//
// The tear has structure, and the structure is enough to undo it. Every chunk
// but a row's last is exactly <chunk> bytes with no newline in it (a row has
// none), and a row's last chunk ends at its newline. So a run of malformed
// lines cuts into chunks one way only: from each position, a newline inside the
// next <chunk> bytes ends a final chunk there; otherwise the next <chunk> bytes
// are a middle chunk. What remains open is which row each chunk belongs to,
// and only an assignment in which every row parses as JSON is accepted.
//
// Parsing alone does not settle it. Both rows of each live pair end
// `…,"session_event_count":N,"salience":0.5}`, so either tail completes either
// head: all three pairs were ambiguous by parse. The copies of the same events
// in the other logs decide. The milestone hook writes every milestone to
// changelog.jsonl as well, with the count in its summary (`[branch, D dirty,
// N events]`), and every pair resolved against those. A candidate scores a
// point for each field a copy shares with the same value, and five for a
// summary naming its own dirty and event counts. The assignment with the
// highest score wins only if no other ties it; a run that still has no single
// answer is reported and left as it is.
//
// A recovered record whose event_id the log already holds is reported and not
// written again. Readers fold duplicates by id, but a repair should not add them.
//
// Dry run by default. --write backs the log up beside itself, then replaces it
// under the rewrite lock (scripts/jsonl-lock.js), carrying rows appended
// meanwhile.
//
//   node scripts/repair-torn-rows.js                 # every searched log, report only
//   node scripts/repair-torn-rows.js --file <log>    # one log
//   node scripts/repair-torn-rows.js --json
//   node scripts/repair-torn-rows.js --write
//   node scripts/repair-torn-rows.js --chunk 1024    # the writer's buffer size
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { replaceJsonl, snapshotJsonl } from './jsonl-lock.js';

const LOG_NAMES = ['changelog.jsonl', 'research-log.jsonl', 'session-milestones.jsonl', 'tool-use-log.jsonl', 'prompt-history.jsonl'];
// Rows in a run are tried against every assignment; past this many chunks the
// search is refused rather than run (a real tear is two rows, three or four chunks).
const MAX_CHUNKS = 12;

function parses(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** Cut a run's bytes (its lines, each with its newline) into write chunks. */
export function chunksOf(bytes, chunk) {
  const chunks = [];
  let at = 0;
  while (at < bytes.length) {
    const window = bytes.subarray(at, Math.min(bytes.length, at + chunk));
    const newline = window.indexOf(0x0a);
    const end = newline >= 0 ? at + newline + 1 : at + window.length;
    chunks.push({ bytes: bytes.subarray(at, end), final: newline >= 0 });
    at = end;
  }
  return chunks;
}

/**
 * Every way to deal the chunks into rows: a chunk starting with "{" may open a
 * row, any chunk may continue an open one, a final chunk closes its row. Returns
 * the assignments in which every row is complete and parses.
 */
export function untangle(chunks) {
  const solutions = [];
  if (chunks.length > MAX_CHUNKS) return solutions;
  const rows = [];
  function walk(i) {
    if (i === chunks.length) {
      if (rows.every((row) => row.closed) && rows.length > 1) {
        const texts = rows.map((row) => Buffer.concat(row.parts).toString('utf8').replace(/\n$/, ''));
        if (texts.every(parses)) solutions.push(texts);
      }
      return;
    }
    const piece = chunks[i];
    if (piece.bytes[0] === 0x7b) {
      rows.push({ parts: [piece.bytes], closed: piece.final });
      walk(i + 1);
      rows.pop();
    }
    for (const row of rows) {
      if (row.closed) continue;
      row.parts.push(piece.bytes);
      row.closed = piece.final;
      walk(i + 1);
      row.closed = false;
      row.parts.pop();
    }
  }
  walk(0);
  return solutions;
}

// How well a recovered record agrees with copies of the same event elsewhere.
function agreement(record, copies) {
  let score = 0;
  for (const copy of copies) {
    for (const [key, value] of Object.entries(record)) {
      if (value !== null && typeof value !== 'object' && copy[key] === value) score += 1;
    }
    const counts = typeof copy.summary === 'string' && /\[(?:.*, )?(\d+) dirty, (\d+) events\]$/.exec(copy.summary);
    if (counts && Number(counts[1]) === record.git_dirty_files && Number(counts[2]) === record.session_event_count) score += 5;
  }
  return score;
}

/**
 * The one assignment the copies favour: highest agreement, not tied. Copies is
 * event_id → rows from the other logs. Returns null when none stands out.
 */
export function decide(solutions, copies = new Map()) {
  if (solutions.length === 1) return solutions[0];
  const scored = solutions.map((texts) => ({
    texts,
    score: texts.reduce((sum, text) => {
      const record = JSON.parse(text);
      return sum + agreement(record, copies.get(record.event_id) || []);
    }, 0),
  })).sort((a, b) => b.score - a.score);
  if (!scored.length || scored[0].score === 0 || (scored[1] && scored[1].score === scored[0].score)) return null;
  return scored[0].texts;
}

/** Event ids the candidate records of these runs carry. */
export function candidateIds(runs) {
  const ids = new Set();
  for (const run of runs) {
    for (const texts of run.solutions) {
      for (const text of texts) {
        const id = JSON.parse(text).event_id;
        if (typeof id === 'string' && id) ids.add(id);
      }
    }
  }
  return ids;
}

/** Rows in <files> whose event_id is in <ids>, grouped by id. */
export function copiesOf(ids, files) {
  const copies = new Map();
  if (!ids.size) return copies;
  for (const file of files) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      const match = /"event_id":"([^"]+)"/.exec(line);
      if (!match || !ids.has(match[1])) continue;
      try {
        const row = JSON.parse(line);
        copies.set(match[1], [...(copies.get(match[1]) || []), row]);
      } catch {}
    }
  }
  return copies;
}

/**
 * Find the runs of malformed lines in <raw> and what each splits into. `copies`
 * (event_id → rows from the other logs) settles a run that parses more than one
 * way; see decide().
 * @returns {{lines: string[], runs: object[]}}
 */
export function findTornRows(raw, { chunk = 1024, copies = null } = {}) {
  const text = raw.toString('utf8');
  const lines = text.split('\n');
  // The last element is what follows the final newline: empty, or a row still
  // being written, which is not torn.
  const complete = lines.length - 1;
  const ids = new Set();
  const bad = [];
  for (let i = 0; i < complete; i += 1) {
    if (!lines[i].trim()) continue;
    if (parses(lines[i])) {
      const id = JSON.parse(lines[i]).event_id;
      if (typeof id === 'string' && id) ids.add(id);
    } else {
      bad.push(i);
    }
  }

  const runs = [];
  for (let k = 0; k < bad.length;) {
    const start = bad[k];
    let end = start;
    while (k + 1 < bad.length && bad[k + 1] === end + 1) { k += 1; end += 1; }
    k += 1;
    const span = lines.slice(start, end + 1);
    const chunks = chunksOf(Buffer.from(span.map((line) => `${line}\n`).join(''), 'utf8'), chunk);
    const solutions = untangle(chunks);
    const chosen = solutions.length && copies ? decide(solutions, copies) : (solutions.length === 1 ? solutions[0] : null);
    const run = {
      first_line: start + 1,
      last_line: end + 1,
      bytes: chunks.reduce((sum, piece) => sum + piece.bytes.length, 0),
      chunks: chunks.map((piece) => piece.bytes.length),
      parses: solutions.length,
      status: chosen ? 'recoverable' : solutions.length === 0 ? 'unrecoverable' : 'ambiguous',
      solutions,
      records: [],
    };
    if (chosen) {
      run.records = chosen.map((row) => {
        const record = JSON.parse(row);
        return {
          event_id: record.event_id ?? null,
          timestamp: record.timestamp ?? null,
          kind: record.milestone || record.type || null,
          session_id: record.session_id || record.session || null,
          duplicate: typeof record.event_id === 'string' && ids.has(record.event_id),
          row,
        };
      });
    }
    runs.push(run);
  }
  return { lines, runs };
}

/** The log with each recoverable run replaced by its records, one per line. */
export function repairedText(lines, runs) {
  const byStart = new Map(runs.filter((run) => run.status === 'recoverable').map((run) => [run.first_line - 1, run]));
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const run = byStart.get(i);
    if (!run) { out.push(lines[i]); continue; }
    for (const record of run.records) if (!record.duplicate) out.push(record.row);
    i = run.last_line - 1;
  }
  return out.join('\n');
}

function main(argv) {
  const valueAfter = (flag, fallback) => {
    const at = argv.indexOf(flag);
    return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback;
  };
  const write = argv.includes('--write');
  const asJson = argv.includes('--json');
  const chunk = Number.parseInt(valueAfter('--chunk', '1024'), 10);
  if (!Number.isInteger(chunk) || chunk < 64) {
    console.error('repair-torn-rows: --chunk must be an integer of at least 64');
    return 2;
  }
  const dev = process.env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev');
  const files = argv.includes('--file') ? [valueAfter('--file', '')] : LOG_NAMES.map((name) => path.join(dev, name));

  const report = [];
  for (const file of files) {
    if (!file || !fs.existsSync(file)) continue;
    const raw = snapshotJsonl(file);
    // First pass for the candidates; then the copies of their events in the
    // other logs, which settle a run that parses more than one way.
    const others = LOG_NAMES.map((name) => path.join(dev, name)).filter((other) => path.resolve(other) !== path.resolve(file));
    const copies = copiesOf(candidateIds(findTornRows(raw, { chunk }).runs), others);
    const { lines, runs } = findTornRows(raw, { chunk, copies });
    const entry = { file, runs: runs.map(({ records, solutions, ...run }) => ({ ...run, records: records.map(({ row, ...r }) => r) })) };
    report.push(entry);
    const fixable = runs.filter((run) => run.status === 'recoverable');
    if (write && fixable.length) {
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      entry.backup = `${file}.bak-torn-${stamp}`;
      fs.writeFileSync(entry.backup, raw);
      entry.result = replaceJsonl(file, { original: raw, body: repairedText(lines, runs) });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ wrote: write, chunk, files: report }, null, 2));
    return 0;
  }
  let recoverable = 0;
  for (const entry of report) {
    if (!entry.runs.length) continue;
    console.log(entry.file);
    for (const run of entry.runs) {
      const where = run.first_line === run.last_line ? `line ${run.first_line}` : `lines ${run.first_line}-${run.last_line}`;
      const settled = run.parses > 1 && run.status === 'recoverable' ? ` (parses ${run.parses} ways; settled by the copies in the other logs)` : '';
      console.log(`  ${where}: ${run.bytes} bytes in chunks [${run.chunks.join(', ')}] — ${run.status}${settled}`);
      for (const record of run.records) {
        const note = record.duplicate ? '  (already in the log; not written again)' : '';
        console.log(`    ${record.event_id}  ${record.timestamp}  ${record.kind}  session ${record.session_id}${note}`);
      }
      if (run.status === 'recoverable') recoverable += 1;
    }
    if (entry.result) console.log(`  wrote ${entry.file} (backup ${entry.backup}; ${entry.result.carried_rows} appended row(s) carried)`);
  }
  if (!report.some((entry) => entry.runs.length)) console.log('No torn rows.');
  else if (!write) console.log(`\nDry run — nothing written. ${recoverable} run(s) recoverable; pass --write to split them.`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
