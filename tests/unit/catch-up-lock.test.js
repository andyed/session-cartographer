import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CATCH_UP = join(ROOT, 'scripts', 'catch-up-transcripts.sh');

// catch-up-transcripts.sh runs retro-index.sh from its own directory, so run a
// copy beside a stub that only records that it was called.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'cartographer-catchup-'));
  const scripts = join(dir, 'scripts');
  const dev = join(dir, 'dev');
  mkdirSync(scripts);
  mkdirSync(join(dev, '.carto'), { recursive: true });
  copyFileSync(CATCH_UP, join(scripts, 'catch-up-transcripts.sh'));
  writeFileSync(join(scripts, 'retro-index.sh'), 'echo ran >> "$CARTOGRAPHER_DEV_DIR/ran"\necho "Retro-indexing complete!"\n');
  writeFileSync(join(scripts, 'hermes-source.js'), '');
  const lock = join(dev, '.carto', 'transcript-catch-up.lock');
  const run = () => {
    execFileSync('bash', [join(scripts, 'catch-up-transcripts.sh'), '--force'], {
      env: { ...process.env, ...OFFLINE_INDEX_ENV, CARTOGRAPHER_DEV_DIR: dev },
    });
    return existsSync(join(dev, 'ran'));
  };
  return { lock, run };
}

describe('transcript catch-up lock', () => {
  test('a live run\'s lock makes the next run step aside', () => {
    const { lock, run } = sandbox();
    mkdirSync(lock);
    assert.equal(run(), false);
    assert.equal(existsSync(lock), true);
  });

  test('a lock left by a killed run is reclaimed', () => {
    const { lock, run } = sandbox();
    mkdirSync(lock);
    const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000);
    utimesSync(lock, sevenHoursAgo, sevenHoursAgo);
    assert.equal(run(), true);
    assert.equal(existsSync(lock), false);
  });
});
