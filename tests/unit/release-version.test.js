import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkReleaseVersion } from '../../scripts/check-release-version.js';

const version = '0.7.6';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-version-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const documents = {
    'package.json': { version },
    'package-lock.json': { version, packages: { '': { version } } },
    'plugins/session-cartographer/package.json': { version },
    'plugins/session-cartographer/.codex-plugin/plugin.json': { version },
    'plugins/session-cartographer/.claude-plugin/plugin.json': { version },
    '.claude-plugin/marketplace.json': { plugins: [{ name: 'session-cartographer', version }] },
  };
  const write = (relative, value) => {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), JSON.stringify(value));
  };
  for (const [relative, value] of Object.entries(documents)) write(relative, value);
  return { root, documents, write };
}

test('all release metadata agrees with the candidate and requested tag version', t => {
  const { root } = fixture(t);
  assert.equal(checkReleaseVersion(root), version);
  assert.equal(checkReleaseVersion(root, version), version);
  assert.throws(() => checkReleaseVersion(root, '0.7.5'), /disagrees/);
  assert.throws(() => checkReleaseVersion(root, '../0.7.6'), /Invalid release version/);
});

for (const [relative, mutate] of [
  ['package.json', doc => { doc.version = '0.7.5'; }],
  ['package-lock.json', doc => { doc.version = '0.4.1'; }],
  ['package-lock.json', doc => { doc.packages[''].version = '0.4.1'; }],
  ['plugins/session-cartographer/package.json', doc => { doc.version = '0.7.5'; }],
  ['plugins/session-cartographer/.codex-plugin/plugin.json', doc => { doc.version = '0.7.5'; }],
  ['plugins/session-cartographer/.claude-plugin/plugin.json', doc => { doc.version = '0.7.5'; }],
  ['.claude-plugin/marketplace.json', doc => { doc.plugins = []; }],
]) {
  test(`rejects stale or missing metadata in ${relative}: ${mutate}`, t => {
    const { root, documents, write } = fixture(t);
    mutate(documents[relative]);
    write(relative, documents[relative]);
    assert.throws(() => checkReleaseVersion(root, version), /disagrees/);
  });
}
