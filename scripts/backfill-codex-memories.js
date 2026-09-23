#!/usr/bin/env node
// Import Codex's curated memory as versioned, append-only Cartographer events.
// The source files remain authoritative. A derived stale-id list keeps replaced
// or removed versions out of normal CLI/API recall without rewriting history.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const indexRequested = args.has('--index');
const projectArg = process.argv.indexOf('--project');
const projectFilter = projectArg >= 0 ? process.argv[projectArg + 1] : '';
const root = process.env.CARTOGRAPHER_CODEX_MEMORIES_DIR || join(homedir(), '.codex', 'memories');
const dev = process.env.CARTOGRAPHER_DEV_DIR || join(homedir(), 'Documents', 'dev');
const logPath = join(dev, 'changelog.jsonl');
const stalePath = join(dev, '.carto', 'codex-memory-stale-ids.txt');

const hash = (value) => createHash('sha256').update(value).digest('hex');
const flat = (value) => value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
const lines = (value) => value.split(/\r?\n/);
const title = (value) => lines(value).find((line) => /^# /.test(line))?.replace(/^# /, '') || '';
const projectFrom = (value) => {
  const cwd = value.match(/\bcwd=(\/[^\s;)]+)/)?.[1] || value.match(/^cwd:\s*(\/\S+)/m)?.[1];
  if (!cwd) return 'global';
  const name = basename(cwd.replace(/\/$/, ''));
  return name === 'dev' ? 'global' : name;
};
const selectedSections = (value, names) => {
  const out = [];
  let keep = false;
  for (const line of lines(value)) {
    if (/^#{2,3} /.test(line)) keep = names.some((name) => line.toLowerCase().includes(name));
    if (keep && line.trim() && !/^#{2,3} /.test(line)) out.push(line);
  }
  return out.join(' ');
};
const rolloutKnowledge = (value) => {
  const out = [];
  let keep = false;
  for (const line of lines(value)) {
    if (/^## /.test(line)) keep = false;
    else if (/^[A-Z][A-Za-z /-]+:\s*$/.test(line)) {
      keep = /^(Reusable knowledge|Preference signals|Outcome):/.test(line);
    }
    if (keep && line.trim() && !/^[A-Z][A-Za-z /-]+:\s*$/.test(line)) out.push(line);
  }
  return out.join(' ');
};

function entry(file, section, content, kind, line = 1) {
  const key = `codex:${relative(root, file)}${section ? `#${section}` : ''}`;
  const project = projectFrom(content);
  let useful = '';
  if (kind === 'registry') useful = selectedSections(content, ['user preferences', 'reusable knowledge', 'failures and how']);
  else if (kind === 'rollout') useful = rolloutKnowledge(content);
  else useful = content.replace(/^##[^\n]*\n?/, '');
  const heading = section || title(content) || basename(file, '.md');
  const summary = flat(`Codex memory: ${heading}. ${content.match(/^scope:\s*(.+)$/m)?.[1] || ''} ${useful}`).slice(0, 1600);
  const timestamp = statSync(file).mtime.toISOString();
  // A summary-format correction should refresh only the affected overview
  // entries; the source content hash alone would leave their old event intact.
  return { key, hash: hash(kind === 'overview' ? `v2\0${content}` : content), file, line, kind, project, summary, timestamp };
}

function collect() {
  const entries = [];
  const registry = join(root, 'MEMORY.md');
  if (existsSync(registry)) {
    const text = readFileSync(registry, 'utf8');
    const matches = [...text.matchAll(/^# Task Group:\s*(.+)$/gm)];
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const start = match.index;
      const end = matches[i + 1]?.index ?? text.length;
      entries.push(entry(registry, match[1], text.slice(start, end), 'registry', text.slice(0, start).split('\n').length));
    }
  }
  const overview = join(root, 'memory_summary.md');
  if (existsSync(overview)) {
    const text = readFileSync(overview, 'utf8');
    for (const section of ['User Profile', 'User preferences', 'General Tips']) {
      const match = new RegExp(`^## ${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'mi').exec(text);
      if (!match) continue;
      const end = text.indexOf('\n## ', match.index + match[0].length);
      entries.push(entry(overview, section, text.slice(match.index, end < 0 ? text.length : end), 'overview', text.slice(0, match.index).split('\n').length));
    }
  }
  const rollouts = join(root, 'rollout_summaries');
  if (existsSync(rollouts)) {
    for (const name of readdirSync(rollouts).filter((name) => name.endsWith('.md')).sort()) {
      const file = join(rollouts, name);
      entries.push(entry(file, '', readFileSync(file, 'utf8'), 'rollout'));
    }
  }
  return entries;
}

function readHistory() {
  const history = new Map();
  if (!existsSync(logPath)) return history;
  for (const line of lines(readFileSync(logPath, 'utf8'))) {
    if (!line.includes('"memory_key"')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!event.memory_key?.startsWith('codex:') || !event.event_id) continue;
    if (!history.has(event.memory_key)) history.set(event.memory_key, []);
    history.get(event.memory_key).push(event);
  }
  return history;
}

function atomicWrite(file, content) {
  mkdirSync(join(dev, '.carto'), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, file);
}

if (!existsSync(root)) {
  console.error(`Codex memory directory missing: ${root}`);
  process.exit(2);
}
const current = collect().filter((item) => !projectFilter || item.project.toLowerCase().includes(projectFilter.toLowerCase()));
const history = readHistory();
const scopedHistory = [...history.values()].filter((versions) =>
  !projectFilter || versions.at(-1)?.project?.toLowerCase().includes(projectFilter.toLowerCase()));
if (current.length === 0 && scopedHistory.length > 0 && !args.has('--allow-empty')) {
  console.error('No Codex memory entries were readable; refusing to retire the imported corpus. Pass --allow-empty only for an intentional removal.');
  process.exit(2);
}
const seen = new Set();
const additions = [];
for (const item of current) {
  seen.add(item.key);
  const previous = history.get(item.key)?.at(-1);
  if (previous?.memory_hash === item.hash && previous.type !== 'memory_codex_deleted') continue;
  const eventId = `memory-codex-${hash(item.key).slice(0, 12)}-${hash(`${item.hash}:${previous?.event_id || ''}`).slice(0, 12)}`;
  additions.push({
    event_id: eventId, timestamp: item.timestamp, type: `memory_codex_${item.kind}`,
    provider: 'codex', project: item.project, summary: item.summary,
    memory_key: item.key, memory_hash: item.hash, memory_path: item.file,
    memory_line: item.line, memory_type: item.kind,
    ...(previous ? { supersedes: previous.event_id } : {}),
  });
}
for (const [key, versions] of history) {
  if (seen.has(key) || versions.at(-1)?.type === 'memory_codex_deleted') continue;
  if (projectFilter && !versions.at(-1)?.project?.toLowerCase().includes(projectFilter.toLowerCase())) continue;
  const previous = versions.at(-1);
  additions.push({
    event_id: `memory-codex-deleted-${hash(`${key}:${previous.event_id}`).slice(0, 20)}`,
    timestamp: new Date().toISOString(), type: 'memory_codex_deleted',
    provider: 'codex', project: previous.project, summary: `Codex memory removed: ${key}`,
    memory_key: key, memory_hash: null, memory_path: previous.memory_path,
    supersedes: previous.event_id,
  });
}
if (dryRun) {
  console.log(`Codex memory: ${current.length} current entries, ${additions.length} changes (dry run)`);
  for (const event of additions.slice(0, 20)) console.log(`  ${event.type} ${event.project}: ${event.memory_key}`);
  process.exit(0);
}
if (additions.length) {
  mkdirSync(dev, { recursive: true });
  const { appendFileSync } = await import('node:fs');
  appendFileSync(logPath, additions.map((event) => JSON.stringify(event)).join('\n') + '\n');
  for (const event of additions) {
    if (!history.has(event.memory_key)) history.set(event.memory_key, []);
    history.get(event.memory_key).push(event);
  }
}
const stale = [];
for (const versions of history.values()) {
  for (const event of versions.slice(0, -1)) stale.push(event.event_id);
  if (versions.at(-1)?.type === 'memory_codex_deleted') stale.push(versions.at(-1).event_id);
}
atomicWrite(stalePath, [...new Set(stale)].sort().join('\n') + (stale.length ? '\n' : ''));
console.log(`Codex memory: ${current.length} current entries, ${additions.length} changes, ${stale.length} stale versions`);
if (indexRequested) {
  const indexer = join(import.meta.dirname, 'index-event.sh');
  let failures = 0;
  let indexed = 0;
  for (const versions of history.values()) {
    const event = versions.at(-1);
    if (!event || event.type === 'memory_codex_deleted') continue;
    if (projectFilter && !event.project?.toLowerCase().includes(projectFilter.toLowerCase())) continue;
    const result = spawnSync('bash', [indexer], {
      input: JSON.stringify(event), encoding: 'utf8',
      env: { ...process.env, PE_GATE_REJECT: '1.1' },
    });
    if (result.status === 0) indexed++;
    else failures++;
  }
  console.log(`Codex semantic memory: ${indexed} indexed, ${failures} failed`);
  if (failures) process.exitCode = 1;
} else if (additions.some((event) => event.type !== 'memory_codex_deleted')) {
  console.log('Keyword recall is ready. Use --index to also refresh Qdrant when its services are available.');
}
