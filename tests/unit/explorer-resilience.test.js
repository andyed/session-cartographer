import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  EVENT_STREAM_READY_STATE,
  eventStreamPresentation,
  initialEventStreamStatus,
  transitionEventStreamStatus,
} from '../../explorer/src/hooks/event-stream-state.js';
import { transcriptAnalysisNotice, transcriptFailure } from '../../explorer/src/components/transcript-state.js';
import { checkExplorerPreflight } from '../../scripts/explorer-preflight.js';

test('event stream lifecycle distinguishes startup, retry, recovery, and closure', () => {
  let status = initialEventStreamStatus();
  assert.equal(eventStreamPresentation(status).label, 'Connecting');

  status = transitionEventStreamStatus(status, 'error', EVENT_STREAM_READY_STATE.CONNECTING);
  assert.deepEqual(status, { state: 'reconnecting', attempts: 1 });
  assert.equal(eventStreamPresentation(status).label, 'Reconnecting');

  status = transitionEventStreamStatus(status, 'open', EVENT_STREAM_READY_STATE.OPEN);
  assert.deepEqual(status, { state: 'live', attempts: 0 });

  status = transitionEventStreamStatus(status, 'error', EVENT_STREAM_READY_STATE.CLOSED);
  assert.deepEqual(status, { state: 'offline', attempts: 1 });
  assert.match(eventStreamPresentation(status).detail, /Reload Explorer/);
  assert.equal(eventStreamPresentation(initialEventStreamStatus(true)), null);
});

test('transcript failures preserve actionable distinctions and analysis stays nonfatal', () => {
  assert.equal(transcriptFailure({ status: 404 }).title, 'Transcript unavailable');
  assert.equal(transcriptFailure({ status: 403 }).title, 'Transcript access blocked');
  assert.equal(transcriptFailure({ status: 422 }).title, 'No conversation to display');
  assert.match(transcriptFailure({ status: 503 }).message, /file permissions/);
  assert.match(transcriptFailure(new TypeError('Failed to fetch')).message, /lost contact/);
  assert.equal(transcriptFailure({ name: 'AbortError' }), null);
  assert.match(transcriptAnalysisNotice({ unavailable: { message: 'Fixture analysis failed.' } }).detail, /Conversation text is still available/);
});

function preflightFixture() {
  const root = mkdtempSync(join(tmpdir(), 'carto-explorer-preflight-'));
  const explorer = join(root, 'explorer');
  mkdirSync(explorer, { recursive: true });
  const manifest = {
    dependencies: { express: '1.0.0' },
    devDependencies: { vite: '1.0.0' },
  };
  writeFileSync(join(explorer, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(explorer, 'package-lock.json'), '{}');
  writeFileSync(join(explorer, 'index.html'), '<div id="root"></div>');
  return { root, explorer };
}

test('Explorer preflight reports every missing runtime package with the install target', t => {
  const fixture = preflightFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  const result = checkExplorerPreflight(fixture.root);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => error.includes('express, vite')));
  assert.ok(result.errors.some(error => error.includes('Vite launcher is not executable')));
  assert.equal(result.explorer, fixture.explorer);
});

test('Explorer preflight proves entry readability and installed launch dependencies', t => {
  const fixture = preflightFixture();
  t.after(() => rmSync(fixture.root, { recursive: true, force: true }));
  for (const name of ['express', 'vite']) {
    const directory = join(fixture.explorer, 'node_modules', name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), '{}');
  }
  const bin = join(fixture.explorer, 'node_modules', '.bin');
  mkdirSync(bin, { recursive: true });
  const vite = join(bin, 'vite');
  writeFileSync(vite, '#!/bin/sh\n');
  chmodSync(vite, 0o755);

  assert.deepEqual(checkExplorerPreflight(fixture.root), {
    ok: true,
    explorer: fixture.explorer,
    errors: [],
    packageCount: 2,
  });
});
