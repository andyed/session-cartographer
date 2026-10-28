/**
 * tests/unit/jsonl-append-concurrency.test.js
 *
 * Concurrent sessions append to the same logs, and a row that leaves in more
 * than one write(2) can have another session's row land in the middle of it.
 * The hooks appended with bash's builtin printf, which writes through a
 * 1024-byte line buffer on macOS (8 KB on glibc): on 2026-10-16
 * session-milestones.jsonl held six lines spliced at byte 1025, and a repro of
 * 8 writers x 400 rows of 2 KB tore 2,460 of 3,200. Linux CI could not see it,
 * since 2 KB fits glibc's buffer.
 *
 * cartographer_append (hooks/common.sh) keeps the builtin for a row that fits
 * 1024 bytes with its newline and sends a longer one through one cat. These
 * tests run 8 writers at once through it and require every row back whole:
 * 2 KB rows (the shape that tore), rows at 1023 and 1024 bytes on either side
 * of the switch, and 12 KB rows, past glibc's buffer too. The control repeats
 * the harness with the old printf and 12 KB rows and must see tears, or the
 * harness is not producing concurrent writes and the clean result means
 * nothing. Run under every bash on the machine: macOS hooks run /bin/bash 3.2,
 * whose here-strings are temp files, and bash 5's are pipes.
 *
 * Run with: node --test tests/unit/jsonl-append-concurrency.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const COMMON = path.join(ROOT, 'plugins', 'session-cartographer', 'hooks', 'common.sh');
const LOCK = path.join(ROOT, 'scripts', 'jsonl-lock.js');
const WRITERS = 'abcdefgh';

// Rows of exact, known sizes from 8 writers at once; see the script.
const WRITER = path.join(ROOT, 'tests', 'fixtures', 'append-race', 'writer.sh');

function shells() {
  const found = [];
  for (const candidate of ['/bin/bash', spawnSync('bash', ['-c', 'type -P bash'], { encoding: 'utf8' }).stdout.trim()]) {
    if (!candidate || found.some((s) => fs.realpathSync(s) === fs.realpathSync(candidate))) continue;
    if (fs.existsSync(candidate)) found.push(candidate);
  }
  return found;
}

function waitFor(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${stderr}`))));
  });
}

async function race({ shell, mode, sizes, count, nodeWriters = 0 }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-append-'));
  const file = path.join(dir, 'log.jsonl');
  const children = [...WRITERS].map((c) => spawn(shell, [WRITER, COMMON, c, String(count), file, mode, ...sizes.map(String)],
    { stdio: ['ignore', 'ignore', 'pipe'] }));
  // appendJsonl, the scripts' side of the same contract, in the same race.
  for (let k = 0; k < nodeWriters; k += 1) {
    const c = String.fromCharCode(0x70 + k);
    const code = `
      import fs from 'node:fs';
      const { appendJsonl } = await import(${JSON.stringify(pathToFileURL(LOCK).href)});
      const [file, c, count, ...sizes] = process.argv.slice(1);
      while (!fs.existsSync(file + '.go')) {}
      for (let i = 0; i < Number(count); i += 1) {
        const size = Number(sizes[i % sizes.length]);
        const head = '{"w":"' + c + '","i":' + i + ',"pad":"';
        appendJsonl(file, head + c.repeat(size - head.length - 2) + '"}');
      }`;
    children.push(spawn(process.execPath, ['--input-type=module', '-e', code, file, c, String(count), ...sizes.map(String)],
      { stdio: ['ignore', 'ignore', 'pipe'] }));
  }
  fs.writeFileSync(`${file}.go`, '');
  await Promise.all(children.map(waitFor));
  const text = fs.readFileSync(file, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return text;
}

/** Every line, judged: parsed and whole, or malformed. */
function audit(text, sizes) {
  const lines = text.split('\n');
  assert.equal(lines.pop(), '', 'the log must end with a newline');
  const seen = new Map();
  let malformed = 0;
  for (const line of lines) {
    let row;
    try { row = JSON.parse(line); } catch { malformed += 1; continue; }
    const size = sizes[row.i % sizes.length];
    const whole = Buffer.byteLength(line) === size && row.pad === row.w.repeat(row.pad.length);
    if (!whole) { malformed += 1; continue; }
    const key = `${row.w}:${row.i}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  return { lines: lines.length, malformed, seen };
}

for (const shell of shells()) {
  test(`8 writers through cartographer_append under ${shell}: every row whole, once`, { timeout: 120000 }, async () => {
    const sizes = [2048, 1023, 1024, 2048, 12000];
    const count = 150;
    const text = await race({ shell, mode: 'helper', sizes, count });
    const { lines, malformed, seen } = audit(text, sizes);
    assert.equal(malformed, 0, `${malformed} malformed of ${lines} lines`);
    assert.equal(lines, WRITERS.length * count);
    for (const c of WRITERS) {
      for (let i = 0; i < count; i += 1) assert.equal(seen.get(`${c}:${i}`), 1, `row ${c}:${i}`);
    }
  });
}

test('bash and node appenders racing on one log: every row whole, once', { timeout: 120000 }, async () => {
  const sizes = [2048, 1023, 5000];
  const count = 100;
  const text = await race({ shell: shells()[0], mode: 'helper', sizes, count, nodeWriters: 2 });
  const { lines, malformed, seen } = audit(text, sizes);
  assert.equal(malformed, 0, `${malformed} malformed of ${lines} lines`);
  assert.equal(lines, (WRITERS.length + 2) * count);
  assert.equal(seen.size, (WRITERS.length + 2) * count);
});

test('control: the old printf append tears rows this harness writes concurrently', { timeout: 180000 }, async () => {
  // 12 KB is past every buffer the hooks meet (1 KB macOS, 8 KB glibc). Up to
  // three rounds, because whether two writers overlap is up to the scheduler.
  const sizes = [12000];
  let torn = 0;
  for (let round = 0; round < 3 && torn === 0; round += 1) {
    torn = audit(await race({ shell: shells()[0], mode: 'printf', sizes, count: 100 }), sizes).malformed;
  }
  assert.ok(torn > 0, 'the old append never tore: the writers are not overlapping, so the clean results above prove nothing');
});
