#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Packaging must reject stale lockfiles and plugin metadata before creating an
// archive. The same check runs before tag publication and in ordinary CI.
export function checkReleaseVersion(root, requested) {
  const read = (relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  const pkg = read('package.json');
  const expected = requested ?? pkg.version;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(expected ?? '')) {
    throw new Error(`Invalid release version: ${expected}`);
  }
  const lock = read('package-lock.json');
  const declared = [
    ['package.json', pkg.version],
    ['package-lock.json', lock.version],
    ['package-lock.json packages[""]', lock.packages?.['']?.version],
    ['plugins/session-cartographer/package.json', read('plugins/session-cartographer/package.json').version],
    ['Codex plugin', read('plugins/session-cartographer/.codex-plugin/plugin.json').version],
    ['Claude plugin', read('plugins/session-cartographer/.claude-plugin/plugin.json').version],
    ['marketplace', read('.claude-plugin/marketplace.json').plugins?.find(p => p.name === 'session-cartographer')?.version],
  ];
  const mismatches = declared.filter(([, version]) => version !== expected);
  if (mismatches.length) throw new Error(`Release version ${expected} disagrees with ${mismatches.map(([source, version]) => `${source}: ${version ?? 'missing'}`).join(', ')}`);
  return expected;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    console.log(`Release metadata matches ${checkReleaseVersion(root, process.argv[2])}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
