#!/usr/bin/env node
/**
 * bootstrap-project-registry.js — derive a starter project registry from YOUR corpus.
 *
 * The registry that ships with this plugin is the maintainer's. An alias it does
 * not know falls through as a literal project name instead of erroring, so an
 * adopter who scopes a search to `devtools` gets zero results for a scope they
 * believe they set — and the shipped `frakbot` alias expands to `openclaw`,
 * which this project treats as deprecated archive material, never a source.
 *
 * This writes a user-level registry (which REPLACES the shipped one; see
 * scripts/project-registry.sh for the resolution order) built from the project
 * names actually present in your event logs.
 *
 * Inference is a STARTING POINT, not an answer. Family membership is a judgment
 * about how you think about your work, and a shared prefix is only evidence for
 * it. The script prints what it grouped and what it left alone, and expects you
 * to edit the result.
 *
 * Usage:
 *   node scripts/bootstrap-project-registry.js --dry-run
 *   node scripts/bootstrap-project-registry.js
 *   node scripts/bootstrap-project-registry.js --force        # overwrite an existing one
 *   node scripts/bootstrap-project-registry.js --out PATH --min-events 5
 */
import fs from 'node:fs';
import path from 'node:path';
import { userRegistryPath } from './project-registry.js';
import { isNonProject, nonProjectNames } from './non-projects.js';

const DEV = path.resolve(
  process.env.CARTOGRAPHER_DEV_DIR || path.join(process.env.HOME || '', 'Documents', 'dev'),
);

// The five logs the search engines actually read (CLAUDE.md: anything written
// elsewhere is write-only). A registry derived from a sixth file would name
// projects that no search can be scoped to.
const LOGS = [
  'changelog.jsonl',
  'research-log.jsonl',
  'session-milestones.jsonl',
  'tool-use-log.jsonl',
  'prompt-history.jsonl',
];

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueAfter = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const DRY_RUN = has('--dry-run');
const FORCE = has('--force');
const OUT = path.resolve(valueAfter('--out', userRegistryPath(process.env)));
const MIN_EVENTS = Math.max(1, Number.parseInt(valueAfter('--min-events', '1'), 10) || 1);

const NON_PROJECT_NAMES = nonProjectNames(process.env, DEV);

/**
 * The family stem of a project name: leading token, trailing digits stripped.
 *
 *   psychodeli-webgl-port -> psychodeli      scrutinizer2025 -> scrutinizer
 *   psychodeli-plus-tvos  -> psychodeli      scrutinizer-www -> scrutinizer
 *
 * Digits are stripped because year-suffixed repos (`interests2025`,
 * `iblipper2025`) are the same family as their unsuffixed siblings, and a
 * prefix-only rule puts them in separate groups of one. The stem is discarded
 * when stripping leaves too little to be a name.
 */
export function familyStem(name) {
  const head = String(name).toLowerCase().split(/[-_.]/)[0];
  const stripped = head.replace(/\d+$/, '');
  return stripped.length >= 3 ? stripped : head;
}

function readProjectCounts() {
  const counts = new Map();
  let logsSeen = 0;
  for (const log of LOGS) {
    const file = path.join(DEV, log);
    if (!fs.existsSync(file)) continue;
    logsSeen += 1;
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; } // torn line, not a project
      const name = typeof row?.project === 'string' ? row.project.trim() : '';
      if (!name) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  return { counts, logsSeen };
}

const { counts, logsSeen } = readProjectCounts();
if (!logsSeen) {
  console.error(`bootstrap-project-registry: no event logs under ${DEV}.`);
  console.error('Nothing to infer from. Set CARTOGRAPHER_DEV_DIR, or run Session Cartographer for a while first.');
  process.exit(2);
}

// Two filters, both load-bearing, both reusing scripts/non-projects.js rather
// than re-deriving: `project` is cwd-derived, so the workspace root and the home
// directory basename appear as the busiest "projects", and auto-named agent
// worktrees (brave-thompson-40e495) own real history until they are pruned.
const excluded = [];
const kept = new Map();
for (const [name, n] of counts) {
  if (isNonProject(name, NON_PROJECT_NAMES)) { excluded.push([name, n, 'not a project']); continue; }
  if (n < MIN_EVENTS) { excluded.push([name, n, `below --min-events ${MIN_EVENTS}`]); continue; }
  kept.set(name, n);
}

const groups = new Map();
const ungrouped = [];
for (const [name, n] of kept) {
  const stem = familyStem(name);
  // A stem too short to be a name (`my-app-decade` -> `my`) is not evidence of
  // a family. Report the project as ungrouped rather than dropping it: a name
  // that appears in neither the aliases nor the report reads as excluded, and
  // the user has no way to tell inference from omission.
  if (!stem || stem.length < 3) { ungrouped.push([name, n]); continue; }
  if (!groups.has(stem)) groups.set(stem, []);
  groups.get(stem).push([name, n]);
}

// A one-member alias is worse than no alias: it adds a name to learn and
// resolves to exactly what the literal already resolved to.
const aliases = {};
for (const [stem, members] of [...groups].sort()) {
  if (members.length < 2) { ungrouped.push(members[0]); continue; }
  aliases[stem] = members.sort((a, b) => b[1] - a[1]).map(([name]) => name);
}

const registry = {
  _comment: [
    'Derived by scripts/bootstrap-project-registry.js from this machine\'s event logs.',
    'Inference groups names by shared stem; that is a guess about your families, not an answer.',
    'Edit freely. This file REPLACES the registry shipped with the plugin — it does not merge with it.',
  ].join(' '),
  _generated: new Date().toISOString(),
  aliases,
};

// ─── Report ───
const out = [];
out.push(`Scanned ${logsSeen} log${logsSeen === 1 ? '' : 's'} under ${DEV}`);
out.push(`  ${counts.size} distinct project names, ${kept.size} kept, ${excluded.length} excluded`);
out.push('');
if (Object.keys(aliases).length) {
  out.push('Inferred aliases:');
  for (const [stem, members] of Object.entries(aliases)) {
    out.push(`  ${stem}: ${members.join(', ')}`);
  }
} else {
  out.push('Inferred aliases: none — no two project names shared a stem.');
  out.push('  That is a fine outcome; literal project names work without a registry.');
}
out.push('');
if (ungrouped.length) {
  out.push(`Left ungrouped (${ungrouped.length}, each its own project):`);
  out.push(`  ${ungrouped.sort((a, b) => b[1] - a[1]).slice(0, 20).map(([n]) => n).join(', ')}`);
  out.push('');
}
if (excluded.length) {
  out.push(`Excluded (${excluded.length}): workspace root, home directory, auto-named worktrees, generic dirs`);
  out.push(`  ${excluded.sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n, c, why]) => `${n} (${c}, ${why})`).join('; ')}`);
  out.push('');
}
console.log(out.join('\n'));

if (DRY_RUN) {
  console.log(`--dry-run: would write ${OUT}`);
  console.log(JSON.stringify(registry, null, 2));
  process.exit(0);
}

// Never clobber a hand-edited registry. The whole point of this file is that the
// grouping is a guess the user is expected to correct; silently replacing their
// corrections with a fresh guess would make the correction pointless.
if (fs.existsSync(OUT) && !FORCE) {
  console.error(`bootstrap-project-registry: ${OUT} already exists. Refusing to overwrite.`);
  console.error('Re-run with --force to replace it, or --dry-run to see what would be written.');
  process.exit(1);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`Wrote ${OUT}`);
console.log('This replaces the plugin\'s shipped registry. Edit it — the grouping above is inference.');
