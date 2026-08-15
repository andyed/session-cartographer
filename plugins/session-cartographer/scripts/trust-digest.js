#!/usr/bin/env node
/**
 * Derive the infrastructure your work actually touches, for auto mode's
 * `autoMode.environment` block.
 *
 * Claude Code's own setup wizard answers the same question by re-scanning the
 * machine at the moment you accept it: it walks transcripts under a byte cap,
 * reads the leading word of each shell-history line, and enumerates git repos
 * under $HOME, flagging those as "CANDIDATES, not vetted context." Cartographer
 * already extracted that corpus — incrementally, across providers, with the
 * owner and non-project filters that a raw filesystem walk gets wrong. So this
 * derives the same entities from the event logs instead, which buys three
 * things the one-shot scan cannot:
 *
 *   1. Usage weighting. A repo under $HOME is a candidate; a repo you pushed to
 *      forty times is infrastructure. Frequency separates them.
 *   2. Codex and backfilled git history, which the Claude-only scan never sees.
 *   3. Re-runnability. Every proposal is diffed against the `autoMode.environment`
 *      already in your settings, so an update proposes only what is new.
 *
 * What this deliberately does NOT emit: command arguments, URLs with query
 * strings, file contents, or anything from a transcript body. Commands reduce
 * to their leading word and URLs to their host, matching the wizard's
 * "command words only" discipline — the output of this script is meant to be
 * pasteable into a settings file without a secret review.
 *
 * Usage:
 *   node scripts/trust-digest.js
 *   node scripts/trust-digest.js --json          # for /trustmap to consume
 *   node scripts/trust-digest.js --window 365d
 *   node scripts/trust-digest.js --no-git        # skip on-disk remote probing
 */
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

const HOME = process.env.HOME || '';
const DEV = process.env.CARTOGRAPHER_DEV_DIR || path.join(HOME, 'Documents/dev');
const LOGS = {
  changelog: process.env.CARTOGRAPHER_CHANGELOG || path.join(DEV, 'changelog.jsonl'),
  research: process.env.CARTOGRAPHER_RESEARCH_LOG || path.join(DEV, 'research-log.jsonl'),
  toolUse: process.env.CARTOGRAPHER_TOOL_USE_LOG || path.join(DEV, 'tool-use-log.jsonl'),
  milestones: process.env.CARTOGRAPHER_MILESTONES || path.join(DEV, 'session-milestones.jsonl'),
};
const SETTINGS = process.env.CARTOGRAPHER_SETTINGS || path.join(HOME, '.claude/settings.json');

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};
const AS_JSON = args.includes('--json');
const NO_GIT = args.includes('--no-git');
const TEMPLATE_ONLY = args.includes('--template');
const MIN_HITS = Math.max(1, Number.parseInt(valueAfter('--min', '3'), 10) || 3);
const REPO_PROBE_CAP = Math.max(1, Number.parseInt(valueAfter('--cap', '40'), 10) || 40);

const WINDOW_DAYS = (() => {
  const m = /^(\d+)\s*([dwmy])?$/.exec(String(valueAfter('--window', '365d')).trim());
  if (!m) return 365;
  const n = Number(m[1]);
  return { d: n, w: n * 7, m: n * 30, y: n * 365 }[m[2] || 'd'];
})();

// ─── Shared filters, same definitions build-profile.js uses ───
function gitUserName() {
  try {
    return execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim();
  } catch { return ''; }
}
const OWNERS = new Set(
  (process.env.CARTOGRAPHER_PROFILE_AUTHORS || gitUserName())
    .split(',').map((s) => s.trim()).filter(Boolean)
    .concat(['Claude', 'claude'])
);
// `project` is cwd-derived, so sessions started in $HOME or the workspace root
// produce "projects" named after those directories. They are not repos and must
// never reach a trust entry — "trust everything under ~" is the opposite of the
// boundary this file exists to draw.
const NON_PROJECTS = new Set(
  (process.env.CARTOGRAPHER_PROFILE_EXCLUDE || '')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .concat([path.basename(HOME), path.basename(DEV), '/', '?', '', 'unknown', 'tmp', 'Documents'])
);

const warnings = [];
const warn = (m) => { warnings.push(m); console.error(`warning: ${m}`); };

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn line */ }
  }
  return out;
}

const now = Date.now();
const windowStart = now - WINDOW_DAYS * 86400000;
const inWindow = (e) => {
  const ms = Date.parse(e.timestamp || '');
  return Number.isFinite(ms) && ms >= windowStart && ms <= now + 86400000;
};
// Backfilled git history carries other authors' commits. Unfiltered, the repo
// list describes everyone whose repo you ever cloned — and hands the classifier
// their orgs as trusted.
const isOwn = (e) => e.type !== 'git_commit' || Boolean(e.session_id) || OWNERS.has(e.author || '');

const changelog = readJsonl(LOGS.changelog);
if (!changelog.length) {
  console.error(`No events in ${LOGS.changelog}. Nothing to derive.`);
  process.exit(2);
}
const events = [...changelog, ...readJsonl(LOGS.toolUse)].filter(isOwn).filter(inWindow);
const research = readJsonl(LOGS.research).filter(inWindow);

const bump = (map, key, by = 1) => { if (key) map.set(key, (map.get(key) || 0) + by); };
const sortDesc = (map) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const atLeast = (rows, n = MIN_HITS) => rows.filter(([, c]) => c >= n);

// ─── Commands: leading word only ───
// Shell text reaches the log as a truncated `summary` ("Ran: …"), so argument
// mining is unreliable past the truncation point anyway. The leading word is
// intact for every row, and it is the only part safe to print unreviewed.
const COREUTILS = new Set([
  'ls', 'cd', 'cat', 'echo', 'sed', 'awk', 'grep', 'rg', 'find', 'nl', 'head', 'tail', 'sort',
  'uniq', 'wc', 'cp', 'mv', 'rm', 'mkdir', 'touch', 'chmod', 'test', 'true', 'false', 'for',
  'while', 'if', 'printf', 'tr', 'cut', 'xargs', 'which', 'basename', 'dirname', 'realpath',
  'diff', 'tee', 'date', 'sleep', 'export', 'source', 'read', 'set', 'pwd', 'ln', 'du', 'df',
  'open', 'stat', 'file', 'less', 'more', 'kill', 'ps', 'env', 'time', 'shasum', 'md5', 'jq',
  'type', 'cmp', 'mktemp', 'seq', 'yes', 'nc', 'tar', 'gzip', 'unzip', 'zip', 'awk',
  'git', 'node', 'python', 'python3', 'bash', 'sh', 'zsh',
  // Splitting compound lines on `;` and `|` also splits the *inside* of inline
  // `node -e` and `python -c` payloads, so language keywords surface as if they
  // were executables. Left in, `const` and `then` outrank `adb` and `xcodebuild`
  // and the list stops describing tooling at all.
  'do', 'done', 'then', 'else', 'elif', 'fi', 'esac', 'case', 'in', 'function', 'return',
  'const', 'let', 'var', 'async', 'await', 'import', 'from', 'class', 'new', 'this',
  'console', 'length', 'print', 'command', 'exit', 'break', 'continue', 'typeof', 'require',
  'JSON', 'Math', 'Object', 'Array', 'String', 'Number', 'Promise', 'process',
]);
// A stoplist is whack-a-mole: every new inline `python -c` or `jq` filter in the
// corpus contributes another language token that reads like a binary. Resolving
// against PATH replaces the guess with a fact — if it isn't executable on this
// machine, it isn't a CLI worth naming to the classifier. One directory scan,
// no subprocesses.
const PATH_EXECUTABLES = (() => {
  const set = new Set();
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { for (const name of fs.readdirSync(dir)) set.add(name); } catch { /* unreadable */ }
  }
  return set;
})();
if (PATH_EXECUTABLES.size === 0) {
  warn('PATH yielded no executables — command list falls back to the keyword stoplist alone');
}

const stripPrefix = (s) => s.replace(
  /^(?:sudo\s+|timeout\s+\d+[smh]?\s+|env\s+|nohup\s+|[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/,
  ''
);

const commands = new Map();
const buckets = new Map();
const namespaces = new Map();
const curlHosts = new Map();
const registryFlags = new Map();
let bashSeen = 0;
let droppedCommands = 0;

const BUCKET_RE = /\b(?:s3|gs|gcs|az|abfss?|r2|b2|wasbs?):\/\/([A-Za-z0-9][A-Za-z0-9._-]{1,62})/g;
const NS_RE = /\b(?:kubectl|helm|k9s|kubens|oc)\b[^|;&]*?\s-n\s+([a-z][a-z0-9-]{2,})/g;
const URL_RE = /\bhttps?:\/\/([A-Za-z0-9._-]+(?::\d+)?)/g;
const REGISTRY_RE = /--(?:registry|index-url|extra-index-url|repo)[= ]("?)(\S+?)\1(?:\s|$)/g;

for (const e of events) {
  const summary = String(e.summary || '');
  if (!summary) continue;

  if (e.type === 'tool_bash' || e.type === 'git_push' || e.type === 'git_commit') {
    const body = summary.replace(/^(?:Ran|Pushed|Committed):\s*/, '');
    if (e.type === 'tool_bash') {
      bashSeen++;
      // A compound line is many commands. Splitting on the shell's own
      // separators is the difference between seeing `adb` 397 times and seeing
      // it only when it happened to lead the line.
      for (const part of body.split(/(?:\|\||&&|[|;])/)) {
        const word = stripPrefix(part.trim()).split(/\s+/)[0] || '';
        const base = word.replace(/.*\//, '').replace(/[^A-Za-z0-9._-]/g, '');
        if (!base || /^[-.]/.test(base) || /^\d/.test(base)) continue;
        if (COREUTILS.has(base)) continue;
        if (PATH_EXECUTABLES.size && !PATH_EXECUTABLES.has(base)) { droppedCommands++; continue; }
        bump(commands, base);
      }
    }
    for (const m of body.matchAll(BUCKET_RE)) bump(buckets, `${m[0].split('://')[0]}://${m[1]}`);
    for (const m of body.matchAll(NS_RE)) bump(namespaces, m[1]);
    for (const m of body.matchAll(REGISTRY_RE)) {
      try { bump(registryFlags, new URL(m[2]).host); } catch { /* not a URL */ }
    }
    if (/^(?:curl|wget|http|https|xh)\b/.test(stripPrefix(body))) {
      for (const m of body.matchAll(URL_RE)) bump(curlHosts, m[1]);
    }
  }
}

// ─── Hosts: research fetches carry a clean `url` field ───
const fetchHosts = new Map();
for (const r of research) {
  if (!r.url) continue;
  try { bump(fetchHosts, new URL(r.url).host); } catch { /* malformed */ }
}
const allHosts = new Map(fetchHosts);
for (const [h, n] of curlHosts) bump(allHosts, h, n);

// Three classes, not two. Loopback is the one that matters least and appears
// most: a dev server on 127.0.0.1:5173 is inside the working directory's own
// trust boundary already, so listing sixty of them as "trusted domains" adds
// no permission and buries the handful of LAN hosts that do need naming.
// Collapse loopback to one line, keep LAN and .internal/.local separate, and
// leave public hosts out of the proposals entirely.
// Shell text arrives truncated at ~200 chars, so a URL near the end of a long
// command is cut mid-host. Those fragments ("huggingfa", "static-user-manual-h5",
// a bare "127") look like single-label internal hostnames and were the entire
// content of this section before the shape check — proposing nonsense as trusted
// infrastructure, which is worse than proposing nothing.
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const isWellFormed = (bare) => IPV4.test(bare)
  || (/^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(bare));

const hostClass = (host) => {
  const bare = host.replace(/:\d+$/, '');
  if (/^127\./.test(bare) || bare === '::1' || bare === '0.0.0.0' || /^localhost$/i.test(bare)) return 'loopback';
  if (!isWellFormed(bare)) return 'malformed';
  if (/^(?:10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/.test(bare)) return 'lan';
  if (/\.(?:local|internal|lan|corp|home|localdomain)$/i.test(bare)) return 'lan';
  if (IPV4.test(bare)) return 'lan'; // a bare public IP is still worth naming
  return 'public';
};
const byClass = (cls) => sortDesc(allHosts).filter(([h]) => hostClass(h) === cls);
const loopbackHosts = byClass('loopback');
const internalHosts = byClass('lan');
const externalHosts = byClass('public');
const malformedHosts = byClass('malformed');
const loopbackPorts = [...new Set(
  loopbackHosts.map(([h]) => (/:(\d+)$/.exec(h) || [])[1]).filter(Boolean)
)].sort((a, b) => Number(a) - Number(b));
if (malformedHosts.length) {
  warn(`${malformedHosts.length} host fragment(s) dropped as truncation artifacts (summaries are clipped at ~200 chars)`);
}

// ─── Repos: corpus-weighted, then remotes read from disk ───
const projects = new Map();
for (const e of events) {
  const name = e.project;
  if (!name || NON_PROJECTS.has(name)) continue;
  if (!projects.has(name)) projects.set(name, { name, events: 0, commits: 0, pushes: 0, cwd: '', last: 0 });
  const p = projects.get(name);
  p.events++;
  if (e.type === 'git_commit') p.commits++;
  if (e.type === 'git_push') p.pushes++;
  const ms = Date.parse(e.timestamp || '');
  if (Number.isFinite(ms) && ms > p.last) {
    p.last = ms;
    if (e.cwd) p.cwd = e.cwd;
  }
}

// Rank by write activity, not chatter. A repo read once during a search is not
// somewhere Claude needs standing permission to push.
const ranked = [...projects.values()]
  .sort((a, b) => (b.commits + b.pushes) - (a.commits + a.pushes) || b.events - a.events);

const repoRoot = (dir) => {
  try {
    return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
  } catch { return ''; }
};
const remotesOf = (dir) => {
  try {
    return execFileSync('git', ['-C', dir, 'remote', '-v'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 })
      .split('\n').map((l) => l.split(/\s+/)[1]).filter(Boolean);
  } catch { return []; }
};
// Normalize scp-style (git@host:org/repo) and URL remotes to host + org/repo,
// and drop any embedded credential before it can reach the output.
const parseRemote = (url) => {
  const scp = /^(?:[^@]+@)?([^/:]+):(.+?)(?:\.git)?$/.exec(url);
  const m = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
  const [host, repoPath] = m ? [m[1], m[2]] : scp ? [scp[1], scp[2]] : [];
  if (!host) return null;
  return { host: host.replace(/:\d+$/, ''), org: (repoPath || '').split('/')[0] || '', path: repoPath || '' };
};

const repos = [];
const orgs = new Map();
let probed = 0;
let pastCap = 0;
let cwdGone = 0;
if (!NO_GIT) {
  for (const p of ranked) {
    if (probed >= REPO_PROBE_CAP) { pastCap++; continue; }
    if (!p.cwd || !fs.existsSync(p.cwd)) { cwdGone++; continue; }
    probed++;
    const root = repoRoot(p.cwd);
    if (!root) continue;
    const parsed = remotesOf(root).map(parseRemote).filter(Boolean);
    const seen = new Map();
    for (const r of parsed) if (!seen.has(r.path)) seen.set(r.path, r);
    const list = [...seen.values()];
    for (const r of list) bump(orgs, `${r.host}/${r.org}`);
    repos.push({ ...p, root, remotes: list });
  }
  // Two different causes, and conflating them sends you hunting the wrong one:
  // a cap that needs raising, or a directory that moved. Say which.
  if (pastCap) warn(`${pastCap} project(s) ranked below the ${REPO_PROBE_CAP}-repo probe cap — raise it with --cap if an org is missing`);
  if (cwdGone) warn(`${cwdGone} project(s) skipped: their last recorded cwd no longer exists on disk`);
}

// ─── Sensitive locations cartographer can assert on its own authority ───
// The classifier's built-in rules name "real LLM/agent-session transcripts and
// conversation logs" as sensitive data that belongs in no repo. Those are
// exactly the files this tool writes and reads, so it is the component best
// placed to tell the classifier where they live — and least excusable for
// leaving them unnamed.
const sensitivePaths = [
  ...Object.values(LOGS),
  path.join(DEV, '.carto'),
  path.join(HOME, '.claude/projects'),
  path.join(HOME, '.codex/sessions'),
].filter((p) => fs.existsSync(p));

// ─── Existing config, so a re-run proposes only the delta ───
let existing = [];
let settingsReadable = true;
try {
  existing = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'))?.autoMode?.environment || [];
} catch (err) {
  if (err.code !== 'ENOENT') { settingsReadable = false; warn(`could not read ${SETTINGS}: ${err.message}`); }
}
const existingText = existing.join('\n').toLowerCase();
const covered = (needle) => Boolean(needle) && existingText.includes(String(needle).toLowerCase());

// ─── Provenance ───
// The environment block has more than one author: Claude Code's setup wizard
// writes it, this writes it, and you edit it by hand. Wholesale assignment means
// whoever ran last wins and silently discards the others; pure appending never
// discards anything but can never correct its own stale entry either, so the
// block grows monotonically and eventually contradicts itself.
//
// A dated marker in the prose fixes both. Entries are free-form natural
// language, so a trailing tag is legal and the classifier reads straight past
// it — but it lets a re-run rewrite only what it wrote, leave every foreign
// entry untouched, and retire its own entries when the evidence disappears.
const STAMP = `[trustmap ${new Date(now).toISOString().slice(0, 10)}]`;
const OWNED_RE = /\[trustmap(?:\s+(\d{4}-\d{2}-\d{2}))?\]\s*$/;
const isDefaults = (e) => String(e).trim() === '$defaults';

const ownedEntries = existing.filter((e) => !isDefaults(e) && OWNED_RE.test(String(e)));
const foreignEntries = existing.filter((e) => !isDefaults(e) && !OWNED_RE.test(String(e)));
const hasDefaults = existing.some(isDefaults);

// ─── Data stores the corpus shows you working in ───
// Session transcripts are the sensitive store this tool knows about a priori.
// They are rarely the *most* sensitive one on the machine: a research corpus of
// per-participant gaze and pupil traces outranks them, and hardcoding only
// cartographer's own logs would name the lesser store and imply the greater one
// was considered. Derive these from the corpus instead — a directory you have
// touched hundreds of times is where the data actually is.
const DATA_DIR_RE = new RegExp(
  String.raw`(?:${HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|~)` +
  String.raw`(?:/[A-Za-z0-9_.-]+)*?/(?:data|datasets?|raw|corpus|participants?|subjects?|gaze|pupil|recordings?|exports?)(?:/[A-Za-z0-9_.-]+)*`,
  'g'
);
// Build products and sandboxes match the same words and are not data stores.
const DATA_NOISE = /(?:node_modules|CoreSimulator|Library\/(?:Developer|Caches|WebKit)|\/dist\/|\/build\/|\.venv|site-packages|\.cache|DerivedData)/;

const dataHits = new Map();
for (const e of events) {
  const summary = String(e.summary || '');
  if (!summary) continue;
  for (const m of summary.matchAll(DATA_DIR_RE)) {
    let p = m[0].replace(/^~/, HOME);
    if (DATA_NOISE.test(p)) continue;
    // Collapse to the data directory itself, not the file inside it — one entry
    // per store, not one per trial file.
    const cut = p.search(/\/(?:data|datasets?|raw|corpus|participants?|subjects?|gaze|pupil|recordings?|exports?)(?:\/|$)/);
    if (cut < 0) continue;
    const rest = p.slice(cut + 1);
    const seg = rest.split('/');
    p = `${p.slice(0, cut)}/${seg[0]}${seg[1] && !/\.[A-Za-z0-9]{1,6}$/.test(seg[1]) ? `/${seg[1]}` : ''}`;
    bump(dataHits, p);
  }
}

// A data store that git already ignores is contained; one that isn't is the
// finding. Report the state rather than assuming either way.
const ignoreState = (dir) => {
  try {
    const root = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    if (!root) return 'not in a repo';
    execFileSync('git', ['-C', root, 'check-ignore', '-q', dir],
      { stdio: 'ignore', timeout: 3000 });
    return 'gitignored';
  } catch (err) {
    // check-ignore exits 1 for "not ignored"; rev-parse fails outside a repo.
    return err.status === 1 ? 'TRACKABLE' : 'not in a repo';
  }
};

const dataStores = atLeast(sortDesc(dataHits), 2)
  .filter(([p]) => !NO_GIT || true)
  .slice(0, 15)
  .map(([p, n]) => ({
    value: p,
    hits: n,
    exists: fs.existsSync(p),
    state: fs.existsSync(p) && !NO_GIT ? ignoreState(p) : 'unchecked',
    covered: covered(p),
  }));

const proposals = {
  source_control: atLeast(sortDesc(orgs), 1).map(([o, n]) => ({ value: o, hits: n, covered: covered(o) })),
  internal_domains: internalHosts.map(([h, n]) => ({ value: h, hits: n, covered: covered(h.replace(/:\d+$/, '')) })),
  cloud_buckets: sortDesc(buckets).map(([b, n]) => ({ value: b, hits: n, covered: covered(b) })),
  namespaces: atLeast(sortDesc(namespaces), 1).map(([k, n]) => ({ value: k, hits: n, covered: covered(k) })),
  clis: atLeast(sortDesc(commands)).slice(0, 25).map(([c, n]) => ({ value: c, hits: n, covered: covered(c) })),
  registries: sortDesc(registryFlags).map(([r, n]) => ({ value: r, hits: n, covered: covered(r) })),
  sensitive: sensitivePaths.map((p) => ({ value: p, hits: 0, covered: covered(p) })),
  data_stores: dataStores,
};

// ─── Retirement ───
// Nothing in this pipeline has ever removed an entry, so a host you stopped
// using last year keeps granting trust forever. An entry this tool wrote is
// stale when none of the identifiers it names still appear anywhere in the
// current corpus.
//
// Context entries ("Organization: …", "Cloud provider(s): none") name no
// identifiers at all, and would read as stale under a naive check every single
// run. They are never retired automatically — absence of an identifier is not
// evidence against a description.
const universe = Object.values(proposals).flat()
  .map((p) => String(p.value).toLowerCase())
  .filter((v) => v.length >= 3);

const stale = ownedEntries.map((entry) => {
  const text = String(entry).toLowerCase();
  const named = universe.filter((id) => text.includes(id));
  return { entry: String(entry), names: named.length, stale: named.length === 0 };
}).filter((r) => r.stale);

// Distinguishing "carries no identifiers, so unjudgeable" from "carried
// identifiers that are now gone" needs the entry's own shape, which prose does
// not reliably give. Report rather than act: the skill asks before retiring.
const retirable = stale.filter((r) => /:\s*\S/.test(r.entry) && /[/.]|\bs3:|\bgs:/.test(r.entry));
const newCount = Object.values(proposals).flat().filter((p) => !p.covered).length;

// ─── Render ───
// ─── Cold start ───
// Deriving from the corpus is only better than rescanning the machine once the
// corpus exists. On a fresh install it is strictly worse, and that is exactly
// when someone needs the environment config most. Detect the case and hand over
// a template to answer directly rather than serving a confident-looking panel
// built from forty events.
const COLD_START = {
  shell: bashSeen < 200,
  repos: repos.filter((r) => r.remotes.length).length < 2,
  span: events.length < 500,
};
const isColdStart = Object.values(COLD_START).filter(Boolean).length >= 2;

const TEMPLATE = `# autoMode.environment — fill this in

Answer what applies and delete the rest. Entries are prose, not patterns: the
classifier reads them as natural language, so write them the way you would
describe your infrastructure to a new engineer. Keep "$defaults" first — without
it the built-in entries are replaced rather than extended.

  "$defaults",
  "Organization: <company or 'independent'>. Primary use of Claude Code: <software development | infrastructure automation | data engineering | research>",
  "Repository visibility: <which repos are public, which are private, and whether any hold material under embargo>",
  "Source control: <every GitHub/GitLab/Bitbucket org you push to, e.g. github.com/acme and all repos under it>",
  "Cloud provider(s): <AWS | GCP | Azure | none>",
  "Trusted cloud buckets: <s3://... , gs://... — the ones Claude should read and write>",
  "Trusted internal domains: <*.internal.example.com, api.example.com, LAN hosts and what each one is>",
  "Key internal services: <CI, artifact registry, incident tooling, and where each lives>",
  "Internal package registry: <the private npm/PyPI installs should route through, or 'none — public registries'>",
  "Org-specific CLIs: <non-standard tools and what each one drives>",
  "Sensitive data locations & audiences: <buckets, paths, and databases holding personal, customer, regulated, or entrusted data — and who each may be shared with>",
  "Sensitive remote targets: <the hosts, namespaces, or containers that count as production>",
  "Protected IaC scopes: <infrastructure whose apply/destroy should always need you to name the change>",
  "Additional context: <regulated industry, multi-tenant infra, compliance constraints>"

Two shortcuts, in preference order:

  1. Claude Code's own setup wizard scans this machine directly and needs no
     corpus. It offers to run when auto mode has been active for a few startups;
     "Set it up" in that dialog is the fastest path on a fresh install.
  2. Answer the lines above in conversation and have them written for you.

Re-run /trustmap once you have a few weeks of sessions logged. It will diff
whatever you set today against what your work actually touches, and propose
only the difference.`;

if (TEMPLATE_ONLY) { console.log(TEMPLATE); process.exit(0); }

const bar = (s) => `━━ ${s} ${'━'.repeat(Math.max(0, 78 - s.length))}`;
const clipEntry = (s) => {
  const flat = String(s).replace(/\s+/g, ' ').trim();
  return flat.length > 68 ? `${flat.slice(0, 67)}…` : flat;
};
const fmt = (rows, n = 12) => {
  const shown = rows.slice(0, n);
  const lines = shown.map((r) => {
    const mark = r.covered ? ' ' : '+';
    const hits = r.hits ? String(r.hits).padStart(5) : '     ';
    return `    ${mark} ${hits}  ${r.value}`;
  });
  if (rows.length > n) lines.push(`      ${String(rows.length - n).padStart(4)}  more not shown`);
  return lines.length ? lines : ['             (none found)'];
};

if (AS_JSON) {
  console.log(JSON.stringify({
    generated: new Date(now).toISOString(),
    window_days: WINDOW_DAYS,
    corpus: {
      events: events.length, bash: bashSeen, fetches: research.length,
      repos_probed: probed, repos_past_cap: pastCap, repos_cwd_gone: cwdGone,
    },
    loopback: { hosts: loopbackHosts.length, ports: loopbackPorts },
    settings_path: SETTINGS,
    settings_readable: settingsReadable,
    cold_start: isColdStart,
    cold_start_signals: COLD_START,
    existing_environment: existing,
    provenance: {
      stamp: STAMP,
      has_defaults: hasDefaults,
      owned: ownedEntries,
      foreign: foreignEntries,
      stale: stale.map((r) => r.entry),
      retirable: retirable.map((r) => r.entry),
    },
    new_count: newCount,
    repos: repos.map((r) => ({
      project: r.name, root: r.root, commits: r.commits, pushes: r.pushes, events: r.events,
      remotes: r.remotes.map((x) => `${x.host}/${x.path}`),
    })),
    proposals,
    external_hosts: externalHosts.slice(0, 20).map(([h, n]) => ({ host: h, hits: n })),
    warnings,
  }, null, 2));
} else {
  const out = [];
  out.push('', bar('trust map · what your work actually touches'), '');
  out.push(`  corpus    ${events.length.toLocaleString()} own events · ${bashSeen.toLocaleString()} shell · ${research.length.toLocaleString()} fetches · last ${WINDOW_DAYS}d`);
  out.push(`  settings  ${SETTINGS} · ${existing.length} existing environment ${existing.length === 1 ? 'entry' : 'entries'}`);
  if (existing.length) {
    out.push(`  authored  ${ownedEntries.length} by /trustmap · ${foreignEntries.length} by others (preserved verbatim)`
      + `${hasDefaults ? ' · $defaults present' : ' · ⚠ NO $defaults'}`);
  }
  out.push(`  proposed  ${newCount} not yet covered  (${'+'} = new, blank = already covered)`, '');

  if (isColdStart) {
    const why = [
      COLD_START.shell && `only ${bashSeen} shell events`,
      COLD_START.repos && 'fewer than 2 repos with remotes',
      COLD_START.span && `only ${events.length} events total`,
    ].filter(Boolean).join(' · ');
    out.push('  ⚠ COLD START — this corpus is too thin to derive a trust boundary from.');
    out.push(`    ${why}.`);
    out.push('    Anything below is drawn from a handful of events and will miss most of');
    out.push('    what you touch. Prefer Claude Code\'s built-in setup wizard, which scans');
    out.push('    this machine directly and needs no history, or fill in the template:');
    out.push('        node scripts/trust-digest.js --template');
    out.push('    Then re-run /trustmap in a few weeks for the delta.', '');
  }

  out.push('  Source control orgs (from remotes of repos you commit to)');
  out.push(...fmt(proposals.source_control, 10), '');
  out.push('  Internal / LAN hosts contacted');
  out.push(...fmt(proposals.internal_domains, 10), '');
  if (loopbackHosts.length) {
    out.push(`  Local dev servers: ${loopbackHosts.length} loopback endpoints on ${loopbackPorts.length} ports`);
    out.push(`      ${loopbackPorts.slice(0, 18).join(' ')}${loopbackPorts.length > 18 ? ' …' : ''}`);
    out.push('  (loopback is already inside the working directory\'s boundary — no entry needed)', '');
  }
  if (proposals.cloud_buckets.length) {
    out.push('  Cloud buckets'); out.push(...fmt(proposals.cloud_buckets, 10), '');
  }
  if (proposals.namespaces.length) {
    out.push('  k8s namespaces'); out.push(...fmt(proposals.namespaces, 8), '');
  }
  if (proposals.registries.length) {
    out.push('  Package registries (from --registry / --index-url)'); out.push(...fmt(proposals.registries, 6), '');
  }
  out.push('  Non-standard CLIs by frequency');
  out.push(...fmt(proposals.clis, 15), '');
  out.push('  Sensitive data locations (session transcripts and event logs)');
  out.push(...fmt(proposals.sensitive, 8), '');
  if (dataStores.length) {
    out.push('  Data stores you work in (derived — review before naming)');
    for (const d of dataStores) {
      const mark = d.covered ? ' ' : '+';
      // A path the corpus references but that is gone from disk is history, not
      // infrastructure. Naming it would grant trust to a directory that could be
      // recreated later by anything.
      const flag = !d.exists ? '  (no longer on disk — do not name)'
        : d.state === 'TRACKABLE' ? '  ← not gitignored'
        : d.state === 'gitignored' ? '  (gitignored)' : '';
      out.push(`    ${mark} ${String(d.hits).padStart(5)}  ${d.value.replace(HOME, '~')}${flag}`);
    }
    out.push('');
  }

  if (retirable.length) {
    out.push('  Stale — written by /trustmap, no longer supported by the corpus');
    for (const r of retirable) out.push(`    −        ${clipEntry(r.entry)}`);
    out.push('  (ask before retiring: absence from a 365d window is not proof it is gone)', '');
  }

  if (repos.length) {
    out.push('  Top repos by write activity');
    for (const r of repos.slice(0, 8)) {
      const remote = r.remotes[0] ? `${r.remotes[0].host}/${r.remotes[0].path}` : '(no remote)';
      out.push(`      ${String(r.commits + r.pushes).padStart(5)}  ${r.name.padEnd(28).slice(0, 28)}  ${remote}`);
    }
    out.push('');
  }
  if (externalHosts.length) {
    out.push(`  Public hosts fetched: ${externalHosts.slice(0, 6).map(([h, n]) => `${h} ${n}`).join(' · ')}`);
    out.push('  (listed for context only — public documentation sites need no environment entry)', '');
  }
  out.push(bar(''), '');
  console.log(out.join('\n'));
}
