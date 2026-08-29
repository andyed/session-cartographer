import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import { readAllEvents } from '../../explorer/server/jsonl.js';

function writeJsonl(filePath, rows) {
  fs.writeFileSync(filePath, `${rows.map(JSON.stringify).join('\n')}\n`);
}

test('Explorer deduplicates overlapping event logs in linear time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-jsonl-dedupe-'));
  const primary = path.join(dir, 'primary.jsonl');
  const domain = path.join(dir, 'domain.jsonl');
  const count = 12_000;
  const first = Array.from({ length: count }, (_, i) => ({
    event_id: `evt-${i}`,
    timestamp: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
    summary: 'short',
  }));
  const duplicate = first.map((row) => ({
    ...row,
    summary: `richer domain summary for ${row.event_id}`,
    project: 'cartographer',
  }));
  writeJsonl(primary, first);
  writeJsonl(domain, duplicate);

  try {
    const started = performance.now();
    const events = readAllEvents({ changelog: primary, milestones: domain });
    const durationMs = performance.now() - started;

    assert.equal(events.length, count);
    assert.equal(events[0].project, 'cartographer');
    assert.match(events[0].summary, /richer domain summary/);
    assert.equal(events[0]._source, 'milestones');
    assert.ok(durationMs < 1_500, `linear dedupe guard exceeded: ${durationMs.toFixed(1)}ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
