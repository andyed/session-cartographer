import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const shared = path.join(root, 'explorer/shared/workmap');
const mod = path.join(root, 'mods/carto-map/hooks/workmap');

// A mod loads only its own files, so the pane carries copies of the drawing the Explorer's session map uses.
// The Explorer page and the pane are one drawing only while those copies are the same bytes.
test('the carto-map mod draws with the same code as the Explorer: its copies have not drifted', () => {
  const script = fs.readFileSync(path.join(root, 'scripts/sync-carto-map-workmap.sh'), 'utf8');
  const listed = /for name in ([^;]+);/.exec(script)[1].trim().split(/\s+/);
  assert.deepEqual(listed, ['hub.js', 'kinds.js', 'ribbon.js', 'tint.js', 'board.js', 'palette.js', 'setup.js', 'text.js']);
  for (const name of listed) {
    assert.equal(fs.readFileSync(path.join(mod, name), 'utf8'), fs.readFileSync(path.join(shared, name), 'utf8'), `${name} differs: run scripts/sync-carto-map-workmap.sh`);
  }
  // Nothing else in that folder runs: the rest are declarations for the copies.
  const others = fs.readdirSync(mod).filter(name => !listed.includes(name));
  assert.ok(others.every(name => name.endsWith('.d.ts')), others.join(' '));
  // The copies reach no file outside their folder, or the mod would load in the repository and nowhere else.
  for (const name of listed) {
    const imports = [...fs.readFileSync(path.join(mod, name), 'utf8').matchAll(/from '([^']+)'/g)].map(m => m[1]);
    assert.ok(imports.every(from => /^\.\/[\w-]+\.js$/.test(from) && listed.includes(from.slice(2))), `${name} imports ${imports.join(', ')}`);
  }
});
