/**
 * standup-silence.js — what /standup cannot see, made visible.
 *
 * Standup reads the event log, so a session whose hooks never fire is not in it at all: not
 * idle, ABSENT. On 2026-10-04 a Codex session edited a file in psychodeli-webgl-port for an
 * hour while standup reported every session idle and the file uncontested. The cause was a
 * week old: 0.8.1 pointed Codex at hooks/codex-hooks.json, Codex records hook trust per hook
 * file and definition hash, and every stored trust record named hooks/hooks.json. Codex
 * skips untrusted hooks without a word, so Codex events went from ~1,500 a day to 8 on
 * 2026-09-28 and to none after — about half the corpus — and nothing in Claude's sessions
 * said so.
 *
 * Three read-only checks, each answering "what happened that the log did not record":
 *   - codexRollouts + the caller's session map: a Codex transcript written in the window
 *     with zero logged events is a session the hooks missed. Activity without events, not
 *     a drop in event rate — a rate rule would cry wolf whenever Codex simply wasn't used.
 *   - codexHookTrust: whether config.toml holds trust records for the hook file the
 *     installed Codex manifest declares. It compares file and event names only; Codex
 *     hashes each definition by a scheme this does not reproduce, so an edited hook under
 *     an unchanged name still reads as trusted here.
 *   - unclaimedChanges + transcriptMentions: tracked files changed in the window that no
 *     logged session edited, and which transcripts written in the window name them. A
 *     mention is evidence, not authorship; the output says "mentioned by", never "edited by".
 */
import { readdirSync, statSync, readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const DAY = 86400e3;
const pad = (n) => String(n).padStart(2, '0');

/**
 * Codex rollout transcripts written since `sinceMs`. Codex files a rollout under the LOCAL
 * date its session started (sessions/YYYY/MM/DD), and a long session keeps writing there, so
 * the walk covers the last `days` dated directories and filters on mtime.
 * @returns {{id: string, provider: 'codex', path: string, mtimeMs: number}[]}
 */
export function codexRollouts({ codexHome, sinceMs, now = Date.now(), days = 8 }) {
  const root = join(codexHome, 'sessions');
  const out = [];
  if (!existsSync(root)) return out;
  for (let d = 0; d < days; d++) {
    const day = new Date(now - d * DAY);
    const dir = join(root, String(day.getFullYear()), pad(day.getMonth() + 1), pad(day.getDate()));
    let names;
    try { names = readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const m = name.match(UUID_RE);
      if (!m) continue;
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs >= sinceMs) out.push({ id: m[1].toLowerCase(), provider: 'codex', path, mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Claude Code transcripts written since `sinceMs` (projects/<dir>/<session-id>.jsonl).
 * @returns {{id: string, provider: 'claude', path: string, mtimeMs: number}[]}
 */
export function claudeTranscripts({ claudeHome, sinceMs }) {
  const root = join(claudeHome, 'projects');
  const out = [];
  let dirs;
  try { dirs = readdirSync(root); } catch { return out; }
  for (const d of dirs) {
    let names;
    try { names = readdirSync(join(root, d)); } catch { continue; }
    for (const name of names) {
      const m = name.match(UUID_RE);
      if (!m) continue;
      const path = join(root, d, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.mtimeMs >= sinceMs) out.push({ id: m[1].toLowerCase(), provider: 'claude', path, mtimeMs: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** PostToolUse → post_tool_use: Codex's trust keys spell events in snake case. */
const snake = (event) => event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

/**
 * Does Codex trust the hook file its installed copy of this plugin declares?
 * @returns {{status: 'trusted'|'partial'|'untrusted'|'not-installed'|'unknown',
 *   hookFile?: string, version?: string, trustedFiles?: string[], missingEvents?: string[], reason?: string}}
 */
export function codexHookTrust({ codexHome, pluginId = 'session-cartographer@session-cartographer' }) {
  const [name, marketplace] = pluginId.split('@');
  const cache = join(codexHome, 'plugins', 'cache', marketplace || name, name);
  let versions;
  try { versions = readdirSync(cache); } catch { return { status: 'not-installed' }; }
  // The newest installed copy is the one Codex loads; mtime orders them without parsing semver.
  const installed = versions
    .map((v) => ({ v, manifest: join(cache, v, '.codex-plugin', 'plugin.json') }))
    .filter((x) => existsSync(x.manifest))
    .sort((a, b) => statSync(b.manifest).mtimeMs - statSync(a.manifest).mtimeMs)[0];
  if (!installed) return { status: 'not-installed' };
  let manifest;
  try { manifest = JSON.parse(readFileSync(installed.manifest, 'utf-8')); } catch { return { status: 'unknown', reason: 'unreadable manifest' }; }
  const hookFile = String(manifest.hooks || './hooks/hooks.json').replace(/^\.\//, '');
  let events = [];
  try {
    const defs = JSON.parse(readFileSync(join(cache, installed.v, hookFile), 'utf-8'));
    events = Object.keys(defs.hooks || defs).map(snake);
  } catch { /* trust can still be judged by file name */ }

  let config;
  try { config = readFileSync(join(codexHome, 'config.toml'), 'utf-8'); } catch { return { status: 'unknown', hookFile, version: installed.v, reason: 'no config.toml' }; }
  const escaped = pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const key = new RegExp(`^\\[hooks\\.state\\."${escaped}:([^:"]+):([a-z_]+):\\d+:\\d+"\\]`, 'gm');
  const trusted = new Map();
  for (const m of config.matchAll(key)) {
    if (!trusted.has(m[1])) trusted.set(m[1], new Set());
    trusted.get(m[1]).add(m[2]);
  }
  const base = { hookFile, version: installed.v, trustedFiles: [...trusted.keys()] };
  if (!trusted.has(hookFile)) return { status: 'untrusted', ...base };
  const missingEvents = events.filter((e) => !trusted.get(hookFile).has(e));
  return missingEvents.length ? { status: 'partial', ...base, missingEvents } : { status: 'trusted', ...base };
}

/**
 * Tracked files in `repo` changed since `sinceMs` that no logged session edited. Untracked
 * files are left out (build output and scratch would bury the signal); a file older than the
 * window is someone's standing work, not news.
 * @param {(abs: string) => string} keyOf the caller's canonical-path function (contentionKey)
 * @returns {{rel: string, abs: string, mtimeMs: number}[]}
 */
export function unclaimedChanges({ repo, sinceMs, claimed, keyOf = (p) => p }) {
  let raw;
  try {
    raw = execFileSync('git', ['-C', repo, 'status', '--porcelain=v1', '-z', '--untracked-files=no'],
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; }
  const parts = raw.split('\0').filter(Boolean);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const rel = parts[i].slice(3);
    if (/[RC]/.test(code)) i++;            // -z puts a rename's ORIGINAL path in the next field
    const abs = join(repo, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }   // deleted: no mtime to judge the window by
    if (st.mtimeMs < sinceMs) continue;
    if (claimed.has(keyOf(abs))) continue;
    out.push({ rel, abs, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Logged events that name the file shortly before it changed — the strongest evidence an
 * unclaimed change has. The edit hook recognises Edit/Write and simple shell forms; a change
 * made through `sed -i` or a Python heredoc logs only a `Ran: …` summary, which still names
 * the path (summaries are truncated near 200 characters, and the path usually comes early).
 * A command up to `beforeMs` before the change (or a few seconds after: hook timestamps are
 * written when the tool returns) counts; the closest wins.
 * @returns {{id, provider, t, summary}[]} nearest first
 */
export function commandEvidence({ events, rel, abs, mtimeMs, beforeMs = 10 * 60e3, afterMs = 5e3 }) {
  const hits = [];
  for (const e of events) {
    const t = Date.parse(e.timestamp);
    if (!Number.isFinite(t) || t < mtimeMs - beforeMs || t > mtimeMs + afterMs) continue;
    const s = e.summary || '';
    if (!s.includes(rel) && !s.includes(abs)) continue;
    hits.push({ id: String(e.session_id || ''), provider: e.provider || '?', t, summary: s });
  }
  return hits.sort((a, b) => Math.abs(a.t - mtimeMs) - Math.abs(b.t - mtimeMs));
}

/**
 * How often each transcript names each path, via one fixed-string grep per transcript
 * (Claude transcripts run to 100 MB+; reading them in Node would dominate standup's runtime).
 * @returns {Map<string, {id, provider, mtimeMs, count}[]>} needle → transcripts, most mentions first
 */
export function transcriptMentions({ transcripts, needles }) {
  const result = new Map(needles.map((n) => [n, []]));
  if (!needles.length || !transcripts.length) return result;
  const dir = mkdtempSync(join(tmpdir(), 'standup-needles-'));
  const patterns = join(dir, 'patterns');
  writeFileSync(patterns, needles.join('\n') + '\n');
  try {
    for (const t of transcripts) {
      let raw = '';
      try {
        raw = execFileSync('grep', ['-o', '-F', '-f', patterns, t.path],
          { encoding: 'utf-8', timeout: 15000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch (e) { raw = e.stdout || ''; }        // grep exits 1 on no match
      const counts = new Map();
      for (const hit of raw.split('\n')) if (hit) counts.set(hit, (counts.get(hit) || 0) + 1);
      for (const [needle, count] of counts) {
        if (result.has(needle)) result.get(needle).push({ id: t.id, provider: t.provider, mtimeMs: t.mtimeMs, count });
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  for (const list of result.values()) list.sort((a, b) => b.count - a.count || b.mtimeMs - a.mtimeMs);
  return result;
}

