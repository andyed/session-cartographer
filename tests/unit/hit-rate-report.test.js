import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '../..');
const REPORT = path.join(ROOT, 'scripts/hit-rate-report.js');

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function runReport(served, uses, extraArgs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hit-rate-'));
  const servedPath = path.join(dir, 'served.jsonl');
  const ledgerPath = path.join(dir, 'ledger.jsonl');
  writeJsonl(servedPath, served);
  writeJsonl(ledgerPath, uses);
  const result = spawnSync(process.execPath, [REPORT, '--json', ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CARTOGRAPHER_SERVED_LOG: servedPath,
      CARTOGRAPHER_ACCESS_LEDGER: ledgerPath,
    },
  });
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('exact call attribution does not credit a later call serving the same event', () => {
  const base = { purpose: 'remember', session_id: 's1', provider: 'codex', project: 'demo', source: 'semantic' };
  const report = runReport([
    { ...base, timestamp: '2026-07-19T10:00:00Z', call_id: 'call-a', query: 'alpha', event_id: 'evt-x', rank: 5 },
    { ...base, timestamp: '2026-07-19T10:01:00Z', call_id: 'call-b', query: 'beta', event_id: 'evt-x', rank: 1 },
  ], [
    { timestamp: '2026-07-19T10:02:00Z', call_id: 'call-a', event_id: 'evt-x', source: 'result_used' },
  ]);

  assert.equal(report.overall.hit, 1);
  assert.equal(report.mrr.instances, 2);
  assert.equal(report.mrr.value, 0.1);
});

test('legacy attribution credits only the latest eligible serve', () => {
  const report = runReport([
    { timestamp: '2026-07-19T10:00:00Z', query: 'alpha', event_id: 'evt-x', rank: 5, source: 'semantic', project: 'demo' },
    { timestamp: '2026-07-19T10:01:00Z', query: 'beta', event_id: 'evt-x', rank: 1, source: 'semantic', project: 'demo' },
  ], [
    { timestamp: '2026-07-19T10:02:00Z', event_id: 'evt-x', source: 'transcript_read' },
  ], ['--purpose', 'all', '--include-legacy']);

  assert.equal(report.overall.hit, 1);
  assert.equal(report.mrr.instances, 2);
  assert.equal(report.mrr.value, 0.5);
});
