/**
 * tests/unit/turbo-memory-plan.test.js
 *
 * Turbo holds the corpus resident, so /carto turns it on by default only where
 * that is cheap: 16 GB+ of RAM and an estimate within 8% of it. Smaller
 * machines are asked, and a service they run exits when idle. Physical RAM is
 * faked with CARTOGRAPHER_TURBO_TOTAL_MEM_BYTES so no test needs a real 8 GB Mac.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  TURBO_BYTES_PER_LOG_ROW,
  countCorpusRows,
  processIsAlive,
  turboMemoryPlan,
} from '../../scripts/turbo-common.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CONTROL = path.join(ROOT, 'scripts/cartographer-turbo.js');
const GB = 1024 ** 3;

function workspace(rows = 3) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-turbo-plan-'));
  const dev = path.join(root, 'dev');
  fs.mkdirSync(dev, { recursive: true });
  const lines = Array.from({ length: rows }, (_, i) => JSON.stringify({
    event_id: `evt-plan-${i}`, timestamp: '2026-09-23T12:00:00Z', project: 'widget', summary: `row ${i}`,
  }));
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'), `${lines.join('\n')}\n`);
  const env = {
    ...process.env,
    HOME: root,
    CARTOGRAPHER_CONFIG: path.join(root, 'config.json'),
    CARTOGRAPHER_DEV_DIR: dev,
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(root, 'state'),
    CARTOGRAPHER_TURBO_SPOOL_ONLY: '1',
    // Never the default 2526: a live Turbo there would be reused, not spawned.
    CARTOGRAPHER_TURBO_URL: 'http://127.0.0.1:45993',
  };
  delete env.CARTOGRAPHER_TURBO_IDLE_MINUTES;
  const control = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [CONTROL, ...args], { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', timeout: 20000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    return JSON.parse(r.stdout);
  };
  const config = () => JSON.parse(fs.readFileSync(env.CARTOGRAPHER_CONFIG, 'utf8'));
  return { root, dev, env, control, config };
}

test('16 GB+ with a corpus inside 8% of RAM is recommended; everything else asks', () => {
  const fits = turboMemoryPlan({ totalMemBytes: 16 * GB, logRows: 250_000 });
  assert.equal(fits.recommend, true);
  assert.equal(fits.reason, 'fits');
  assert.equal(fits.default_idle_minutes, 0);

  const small = turboMemoryPlan({ totalMemBytes: 8 * GB, logRows: 20_000 });
  assert.equal(small.recommend, false, 'an 8 GB machine is never a silent default');
  assert.equal(small.reason, 'under_16gb_ram');
  assert.equal(small.default_idle_minutes, 30);

  // Just over 8% of 16 GB.
  const overRows = Math.ceil((16 * GB * 0.08) / TURBO_BYTES_PER_LOG_ROW) + 1;
  const heavy = turboMemoryPlan({ totalMemBytes: 16 * GB, logRows: overRows });
  assert.equal(heavy.recommend, false);
  assert.equal(heavy.reason, 'corpus_over_8pct_of_ram');
  assert.equal(heavy.default_idle_minutes, 0, 'a large machine keeps Turbo warm once the user opts in');
});

test('row count covers the logs Turbo loads', () => {
  const { dev, env } = workspace(5);
  fs.writeFileSync(path.join(dev, 'research-log.jsonl'), '{"a":1}\n{"a":2}\n');
  fs.writeFileSync(path.join(dev, 'unrelated.jsonl'), '{"a":1}\n'.repeat(50));
  assert.equal(countCorpusRows(env), 7);
});

test('/carto enables Turbo only when the plan recommends it', () => {
  const small = workspace();
  const asked = small.control(['enable', '--if-recommended', '--no-start'], { CARTOGRAPHER_TURBO_TOTAL_MEM_BYTES: String(8 * GB) });
  assert.equal(asked.action, 'ask');
  assert.equal(asked.plan.reason, 'under_16gb_ram');
  assert.equal(fs.existsSync(small.env.CARTOGRAPHER_CONFIG), false, 'asking changes nothing');

  const large = workspace();
  const enabled = large.control(['enable', '--if-recommended', '--no-start'], { CARTOGRAPHER_TURBO_TOTAL_MEM_BYTES: String(16 * GB) });
  assert.equal(enabled.action, 'enabled');
  assert.equal(large.config().turbo.enabled, true);
  const again = large.control(['enable', '--if-recommended', '--no-start'], { CARTOGRAPHER_TURBO_TOTAL_MEM_BYTES: String(16 * GB) });
  assert.equal(again.action, 'already_enabled');
});

test('idle timeout: machine default under 16 GB, explicit setting wins', () => {
  const w = workspace();
  const small = { CARTOGRAPHER_TURBO_TOTAL_MEM_BYTES: String(8 * GB) };
  w.control(['enable', '--no-start'], small);
  assert.equal(w.control(['status'], small).idle_minutes, 30);
  assert.equal(w.control(['status'], { CARTOGRAPHER_TURBO_TOTAL_MEM_BYTES: String(32 * GB) }).idle_minutes, 0);

  w.control(['enable', '--no-start', '--idle-minutes', '0'], small);
  assert.equal(w.config().turbo.idle_minutes, 0);
  assert.equal(w.control(['status'], small).idle_minutes, 0, 'an explicit 0 keeps it warm even on a small machine');
});

test('an idle service exits and frees its memory', async (t) => {
  const w = workspace();
  // 0.02 minutes = 1.2 s; the check runs every quarter window.
  const started = w.control(['start'], { CARTOGRAPHER_TURBO_IDLE_MINUTES: '0.02' });
  const pid = started.pid;
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  assert.ok(processIsAlive(pid), 'service started');

  const deadline = Date.now() + 10000;
  while (processIsAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  assert.equal(processIsAlive(pid), false, 'idle service did not exit');
  assert.equal(w.control(['status']).service.running, false);
});
