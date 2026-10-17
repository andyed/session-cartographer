#!/usr/bin/env node
// abandonment-report.js — what happened on the recall calls that left no
// access row, and what MRR looks like once implicit use is credited.
//
// hit-rate-report.js scores a call by the first served result the agent
// fetched or marked. A call with no access row scores 0, and on 2026-10-17
// that was 365 of 548 ordered remember calls (first-access MRR 0.173; 0.519
// over the calls with any access). Some of those zeros are good abandonment:
// the agent read the one-line summary, answered from it, and never called
// get or mark_used. This probe reads each such call's transcript and sorts it:
//
//   unmarked_use      the agent followed a served result up through a channel
//                     that writes no access row: a tool call naming its
//                     event_id or transcript, or a tool call carrying
//                     distinctive tokens that first reached the agent in that
//                     result's summary
//   good_abandonment  the agent's next text after the recall repeats
//                     distinctive tokens from a served summary, beyond what
//                     the summaries of shuffled calls share with that text
//   no_need           a recall on turn one whose prompt carries no memory cue
//                     (recallCue), or a prompt-cue hook row
//   bad_abandonment   the rest: the agent asked for history and used nothing
//   empty             the call served nothing
//   unresolved        no session, no transcript, or the call is not in it
//
// The first two are implicit use, credited at the rank of the matching
// result. Precedence runs in that order, so a reflexive turn-one recall whose
// summary the agent then quoted counts as use, not no_need; the report also
// cross-tabulates implicit use by turn.
//
// The overlap test. A token counts only when it is distinctive (a sha, a
// number with three digits or a unit, a date, a file name, an identifier, or a
// word of five letters or more that is rare among the served summaries), is
// absent from the query, and is absent from everything the agent had seen
// before writing: the transcript up to the recall, and any tool results that
// arrived after it. A call's score is the most such tokens any one served
// summary shares with the output. The baseline scores the same output against
// the summaries of K other calls from other sessions, cut to the same count.
// A call fires when its score is at least --min-shared and beats the shuffled
// scores at --alpha (p = (1 + #null >= score) / (1 + K)). As an end-to-end
// check, every probed call is also classified --decoys times with a decoy
// call's results in place of its own; the decoy implicit rate is the
// detector's false-positive rate on this corpus, and is reported beside the
// real one.
//
// Read-only. The served log, access ledger and search-call log are copied to
// a temporary directory first, so the gate and the probe read one frozen
// snapshot while the live logs grow. The five event logs and the transcripts
// are read in place. Nothing is appended to served-log.jsonl or
// access-ledger.jsonl, and cartographer-search.sh is never run: its --get
// writes a result_fetched row even without --call-id. --out writes a summary
// and per-call samples that quote transcripts, so it refuses a path inside
// this repository.
//
// The gate. Before reading any transcript the probe recomputes
// hit-rate-report.js's first-access MRR (purpose remember, all time) with its
// own call table and first-access ordering, and compares it with
// hit-rate-report.js --json run on the same snapshot. A delta past 5e-4, or
// any difference in the call or ordered-call counts, aborts with exit 3 and
// writes summary.FAILED.json under --out. --skip-gate REASON bypasses it and
// records the reason.
//
// Usage:
//   node scripts/abandonment-report.js                       # last 30 days, remember + mcp + prompt-cue
//   node scripts/abandonment-report.js --days all --json
//   node scripts/abandonment-report.js --out ~/Documents/dev/.carto/reports/abandonment --hand-check 10
//   node scripts/abandonment-report.js --purpose remember --min-shared 3 --alpha 0.01

import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { isNonPromptNoise, normalizeLiteralPrompt, recallCue } from './classify-prompt-intent.js';
import { exactServedPairs, indexExactAccesses, pairKey, parseJsonl, positiveRank, recordSession, timestampMs } from './recall-join.js';
import { isResolved } from './sentinels.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DAY_MS = 24 * 60 * 60 * 1000;

export const GATE_TOLERANCE = 5e-4;
export const DEFAULTS = Object.freeze({
  days: 30,
  purposes: ['remember', 'mcp', 'prompt-cue'],
  minShared: 2,
  alpha: 0.05,
  donors: 99,
  decoys: 5,
  seed: 'abandonment-v1',
  // A word must be rarer than this among the served summaries to count;
  // shapes (shas, numbers, files, identifiers) get the looser cap. Either way
  // a token seen in two summaries or fewer always qualifies.
  wordDfCap: 0.01,
  shapeDfCap: 0.02,
  // A token new in the output of at least this share of located calls (and
  // never fewer than three) is generic.
  genericCap: 0.1,
  // Donors share the call's project (the commonest among its results) so
  // project vocabulary is in the baseline too; a project with fewer than
  // minDonorPool such calls is topped up from any session.
  donorScope: 'project',
  minDonorPool: 20,
});
export const CATEGORIES = ['unmarked_use', 'good_abandonment', 'no_need', 'bad_abandonment', 'empty', 'unresolved'];
const IMPLICIT = new Set(['unmarked_use', 'good_abandonment']);

const FIVE_LOGS = ['changelog.jsonl', 'research-log.jsonl', 'session-milestones.jsonl', 'tool-use-log.jsonl', 'prompt-history.jsonl'];
const SUMMARY_FIELDS = ['summary', 'description', 'prompt', 'url', 'query', 'event_id', 'milestone'];

// ─── Call table and first-access ordering (the gated path) ──────────────────

function nonNegative(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * Every recall call for the purposes, each served row with its rank and the
 * exact access rows joined to it. Selection follows hit-rate-report.js:
 * attributed rows only (call_id and purpose present), the first
 * (call_id, event_id) occurrence, and zero-result calls from the search-call
 * log, which stay in the denominator. `purposes` is a Set or 'all'.
 */
export function buildCallTable({ servedRows = [], accessRows = [], searchCallRows = [], purposes = 'all' } = {}) {
  const wanted = (purpose) => Boolean(purpose) && (purposes === 'all' || purposes.has(purpose));
  const { rows: served } = exactServedPairs(servedRows.filter((row) => row.event_id && wanted(row.purpose)));
  const { byPair } = indexExactAccesses(accessRows);
  const calls = new Map();

  const ensure = (row) => {
    const callId = String(row.call_id);
    if (!calls.has(callId)) {
      calls.set(callId, { call_id: callId, purpose: null, session_id: null, provider: null, query: '', timestamp: null, rows: [] });
    }
    const call = calls.get(callId);
    call.purpose ||= String(row.purpose);
    call.session_id ||= recordSession(row);
    call.provider ||= isResolved(row.provider) ? String(row.provider) : null;
    call.query ||= typeof row.query === 'string' ? row.query : '';
    const t = timestampMs(row.timestamp);
    if (t !== null) call.timestamp = call.timestamp === null ? t : Math.min(call.timestamp, t);
    return call;
  };

  for (const row of served) {
    const call = ensure(row);
    const rank = positiveRank(row.rank);
    const eventId = String(row.event_id);
    const accesses = (byPair.get(pairKey(row.call_id, row.event_id)) || []).map(({ row: access, index }) => {
      const ordinal = Number(access.access_ordinal);
      return {
        index,
        eventId,
        rank,
        source: access.source,
        timestampMs: nonNegative(access.timestamp_ms) ?? timestampMs(access.timestamp),
        batchId: typeof access.access_batch_id === 'string' && access.access_batch_id ? access.access_batch_id : null,
        ordinal: Number.isInteger(ordinal) && ordinal > 0 ? ordinal : null,
      };
    });
    call.rows.push({ event_id: eventId, rank, project: isResolved(row.project) ? String(row.project) : null, accesses });
  }
  for (const row of searchCallRows) {
    if (row.call_id && wanted(row.purpose)) ensure(row);
  }
  for (const call of calls.values()) {
    call.rows.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.event_id.localeCompare(b.event_id));
  }
  return calls;
}

/**
 * The rank of a call's first (or last) accessed result. One accessed result
 * is its own answer. Several need distinct times, or, when they share the
 * boundary instant, one access batch whose ordinals name a single result;
 * anything else is 'unknown' and leaves the ordered denominator.
 */
export function accessBoundary(accesses, edge) {
  if (accesses.length === 0) return { status: 'none', rank: null };
  const resolve = (list) => {
    const rank = list.find((access) => access.rank !== null)?.rank ?? null;
    return rank === null ? { status: 'unknown', rank: null } : { status: 'resolved', rank };
  };
  const distinct = (list) => new Set(list.map((access) => access.eventId)).size;
  if (distinct(accesses) === 1) return resolve(accesses);
  if (accesses.some((access) => access.timestampMs === null)) return { status: 'unknown', rank: null };

  const times = accesses.map((access) => access.timestampMs);
  const edgeMs = edge === 'first' ? Math.min(...times) : Math.max(...times);
  const atEdge = accesses.filter((access) => access.timestampMs === edgeMs);
  if (distinct(atEdge) === 1) return resolve(atEdge);

  const batches = new Set(atEdge.map((access) => access.batchId));
  if (batches.size !== 1 || batches.has(null) || atEdge.some((access) => access.ordinal === null)) {
    return { status: 'unknown', rank: null };
  }
  const ordinals = atEdge.map((access) => access.ordinal);
  const target = edge === 'first' ? Math.min(...ordinals) : Math.max(...ordinals);
  const chosen = atEdge.filter((access) => access.ordinal === target);
  return distinct(chosen) === 1 ? resolve(chosen) : { status: 'unknown', rank: null };
}

/**
 * First-access MRR over calls. `source` limits which access rows count
 * (null = any, as in the 0.173 headline; 'result_used' = explicit use).
 * `credit` maps call_id → rank for calls with no access of that source, and
 * adds 1/rank for them; a credited call with an access never takes the credit.
 * No-use calls stay in the denominator, as in hit-rate-report.js.
 */
export function mrrOf(calls, { source = null, credit = null } = {}) {
  let ordered = 0;
  let orderUnknown = 0;
  let withAccess = 0;
  let credited = 0;
  let none = 0;
  let sum = 0;
  for (const call of calls) {
    const accesses = call.rows.flatMap((row) => row.accesses)
      .filter((access) => source === null || access.source === source);
    const first = accessBoundary(accesses, 'first');
    const last = accessBoundary(accesses, 'last');
    if (first.status === 'unknown' || last.status === 'unknown') {
      orderUnknown++;
      continue;
    }
    ordered++;
    if (first.status === 'resolved') {
      withAccess++;
      sum += 1 / first.rank;
      continue;
    }
    const rank = credit?.get(call.call_id);
    if (Number.isFinite(rank) && rank > 0) {
      credited++;
      sum += 1 / rank;
    } else {
      none++;
    }
  }
  return {
    calls: calls.length,
    ordered,
    orderUnknown,
    withAccess,
    credited,
    none,
    mrr: ordered > 0 ? sum / ordered : null,
    mrrGivenUse: withAccess + credited > 0 ? sum / (withAccess + credited) : null,
  };
}

export function hasAnyAccess(call) {
  return call.rows.some((row) => row.accesses.length > 0);
}

// ─── Tokens ──────────────────────────────────────────────────────────────────

const RAW_TOKEN = /[A-Za-z0-9][A-Za-z0-9_.\/:%+#@-]*/gu;
const TRAILING = /[._\/:+#@-]+$/u;

// Words of five letters or more that carry no event: English function words
// and the vocabulary every summary in this corpus shares. Rarity among the
// served summaries does most of this work; the list covers the common words a
// small corpus leaves rare.
export const STOPWORDS = new Set(`
  about above after again against almost along already also although always among another
  anyone anything around because become before being below between cannot could couldn
  didn doesn doing during either enough every everything first found further getting given
  going having hello however instead itself later least likely little maybe might never
  nothing other others otherwise ought ourselves perhaps please rather really right seems
  should shouldn since something still thanks their theirs themselves there therefore these
  thing things think those though three through today together tomorrow under unless until
  using usually wants wasn whatever where whether which while whole whose within without
  would wouldn yesterday yours yourself added adding change changed changes check checked
  checks commit commits create created error errors event events false files fixed function
  index issue issues label labels limit lines local looks model needs number object output
  query queries recall result results return script scripts search session sessions source
  state status string summary tests token tokens update updated value values works write
  written right since great agent agents claude codex memory remember
`.trim().split(/\s+/u));

/**
 * Token class from its original spelling. Only `plain` never counts; the rest
 * still pass a rarity test against the summary corpus.
 */
export function tokenClass(raw) {
  const lower = raw.toLowerCase();
  if (/^[0-9a-f]{7,40}$/u.test(lower) && /[0-9]/u.test(lower) && /[a-f]/u.test(lower)) return 'sha';
  if (/^\d{4}-\d{2}-\d{2}/u.test(lower)) return 'date';
  if (/^\d+(?:[.,]\d+)*(?:%|ms|s|x|k|kb|mb|gb|m|h|d)?$/u.test(lower)) {
    const digits = lower.replace(/\D/gu, '').length;
    if (/[.,%a-z]/u.test(lower)) return digits >= 2 || lower.endsWith('%') ? 'number' : 'plain';
    if (/^(19|20)\d{2}$/u.test(lower)) return 'plain'; // a bare year is everywhere
    return digits >= 3 ? 'number' : 'plain';
  }
  if (raw.length >= 5 && /[a-z]/iu.test(raw) && /\.[a-z][a-z0-9]{0,5}$/iu.test(raw)) return 'file';
  if (raw.length >= 5 && /[a-z]/iu.test(raw)
    && (/[_-]/u.test(raw) || /[a-z][A-Z]/u.test(raw) || /\d/u.test(raw))) return 'ident';
  if (raw.length >= 5 && /^[a-z]+$/iu.test(raw) && !STOPWORDS.has(lower)) return 'word';
  return 'plain';
}

/** Spelling-independent key: a sha to 7 hex, a date to its day, a number without commas. */
export function tokenKey(raw, cls = tokenClass(raw)) {
  const lower = raw.toLowerCase();
  if (cls === 'sha') return lower.slice(0, 7);
  if (cls === 'date') return lower.slice(0, 10);
  if (cls === 'number') return lower.replace(/,/gu, '');
  return lower;
}

const CLASS_CACHE = new Map();
function classOf(raw) {
  let cls = CLASS_CACHE.get(raw);
  if (cls === undefined) {
    cls = tokenClass(raw);
    if (CLASS_CACHE.size > 2_000_000) CLASS_CACHE.clear();
    CLASS_CACHE.set(raw, cls);
  }
  return cls;
}

function addToken(out, raw) {
  if (!raw) return;
  const cls = classOf(raw);
  const key = tokenKey(raw, cls);
  if (!out.has(key)) out.set(key, cls);
  // A file name also matches by its stem: "recall-join.js" in a summary and
  // "recall-join" in an answer are the same lead.
  if (cls === 'file') {
    const stem = raw.replace(/\.[A-Za-z][A-Za-z0-9]{0,5}$/u, '');
    if (stem !== raw && stem.length >= 4) addToken(out, stem);
  }
}

/** Map of token key → class for a text. Paths and urls also yield their segments. */
export function tokenize(text) {
  const out = new Map();
  for (const match of String(text ?? '').matchAll(RAW_TOKEN)) {
    const raw = match[0].replace(TRAILING, '');
    if (!raw) continue;
    addToken(out, raw);
    if (/[\/:]/u.test(raw) && classOf(raw) !== 'date') {
      for (const part of raw.split(/[\/:]+/u)) addToken(out, part.replace(TRAILING, ''));
    }
  }
  return out;
}

/** Keys only, for the large known-context sets. */
export function tokenKeys(text, into = new Set()) {
  for (const key of tokenize(text).keys()) into.add(key);
  return into;
}

/**
 * Document frequency over the summary corpus: a key's count is the number of
 * summaries containing it.
 */
export function summaryDf(texts) {
  const df = new Map();
  for (const text of texts) for (const key of tokenize(text).keys()) df.set(key, (df.get(key) || 0) + 1);
  return { df, docs: texts.length };
}

export function distinctiveTokens(text, { df, docs }, { wordDfCap = DEFAULTS.wordDfCap, shapeDfCap = DEFAULTS.shapeDfCap } = {}) {
  const out = new Set();
  for (const [key, cls] of tokenize(text)) {
    if (cls === 'plain') continue;
    const cap = Math.max(2, (cls === 'word' ? wordDfCap : shapeDfCap) * docs);
    if ((df.get(key) || 0) <= cap) out.add(key);
  }
  return out;
}

// ─── Overlap and the shuffled baseline ──────────────────────────────────────

/**
 * The served summary sharing the most distinctive tokens with an output, and
 * which tokens. Ties go to the better rank. `summaries` are
 * [{ rank, tokens: Set }], `excluded` the query's tokens.
 */
export function bestOverlap(summaries, outputTokens, excluded = new Set()) {
  let best = { score: 0, rank: null, shared: [] };
  for (const summary of summaries) {
    const shared = [...summary.tokens].filter((key) => outputTokens.has(key) && !excluded.has(key));
    const better = shared.length > best.score
      || (shared.length > 0 && shared.length === best.score && (summary.rank ?? Infinity) < (best.rank ?? Infinity));
    if (better) best = { score: shared.length, rank: summary.rank, shared: shared.sort() };
  }
  return best;
}

/** Fires when the score reaches minShared and beats the shuffled scores at alpha. */
export function overlapVerdict(score, nullScores, { minShared = DEFAULTS.minShared, alpha = DEFAULTS.alpha } = {}) {
  const atLeast = nullScores.filter((value) => value >= score).length;
  const p = (1 + atLeast) / (1 + nullScores.length);
  return { fires: score >= minShared && nullScores.length > 0 && p <= alpha, p };
}

/** Deterministic PRNG keyed by a string, so a rerun draws the same donors. */
export function seededRandom(key) {
  const digest = createHash('sha256').update(String(key)).digest();
  let state = digest.readUInt32LE(0) || 1;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function sampleDonors(pool, count, random) {
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

// ─── Transcripts ─────────────────────────────────────────────────────────────

/**
 * A human prompt, as opposed to tooling that arrives as a user turn. A slash
 * command counts: the user typed it. One definition of the noise lives in
 * classify-prompt-intent.js.
 */
export function isHumanPrompt(text) {
  const literal = normalizeLiteralPrompt(String(text ?? ''));
  if (!literal) return false;
  if (/^<(command-name|command-message)>/u.test(literal)) return true;
  if (/^<pasted_content\b/u.test(literal)) return true;
  if (literal.startsWith('<')) return false;
  if (/^# agents\.md instructions\b/u.test(literal)) return false;
  if (/^\[request interrupted by user/u.test(literal)) return false;
  return !isNonPromptNoise(literal);
}

/** The prompt asked for recall by name: /remember, $remember, or the plugin's skill id. */
export function asksForRecall(text) {
  const literal = String(text ?? '').toLowerCase();
  return /(^|[\s>])[\/$]remember\b/u.test(literal) || /session-cartographer:remember\b/u.test(literal)
    || /<command-name>\/?remember<\/command-name>/u.test(literal);
}

function stringsOf(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out);
  else if (value && typeof value === 'object') for (const item of Object.values(value)) stringsOf(item, out);
  return out;
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((item) => {
      if (typeof item === 'string') return item;
      if (item?.type === 'tool_result') return contentText(item.content);
      if (typeof item?.text === 'string') return item.text;
      if (item?.type === 'image' || item?.type === 'encrypted_content') return '';
      return stringsOf(item).join('\n');
    }).join('\n');
  }
  return content == null ? '' : stringsOf(content).join('\n');
}

// Codex wraps command output in JSON inside a text item, so a recall's lines
// arrive as literal "\n" sequences, sometimes escaped twice.
function unescapeLiteral(text) {
  let out = text;
  for (let pass = 0; pass < 2 && /\\[nrt"\\]/u.test(out); pass++) {
    out = out.replace(/\\r\\n|\\n|\\r/gu, '\n').replace(/\\t/gu, ' ').replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
  }
  return out;
}

function claudeEntry(row, { sidechain = false } = {}) {
  // A subagent's rows are sidechain rows in its own file; in the parent's file
  // they are someone else's turn.
  if (row.isSidechain && !sidechain) return [];
  if (row.type === 'user') {
    const content = row.message?.content;
    const blocks = Array.isArray(content) ? content : [{ type: 'text', text: String(content ?? '') }];
    const entries = [];
    const results = blocks.filter((block) => block?.type === 'tool_result');
    for (const block of results) entries.push({ kind: 'result', text: unescapeLiteral(contentText(block.content)), id: block.tool_use_id ?? null });
    const text = blocks.filter((block) => block?.type === 'text').map((block) => block.text || '').join('\n');
    if (text.trim()) {
      const human = !row.isMeta && !row.isCompactSummary && results.length === 0 && isHumanPrompt(text);
      entries.push({ kind: human ? 'prompt' : 'context', text });
    }
    return entries;
  }
  if (row.type === 'assistant') {
    const entries = [];
    for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (block?.type === 'text' && block.text?.trim()) entries.push({ kind: 'text', text: block.text });
      else if (block?.type === 'tool_use') entries.push({ kind: 'call', text: `${block.name || ''} ${stringsOf(block.input).join(' ')}`, id: block.id ?? null });
    }
    return entries;
  }
  if (row.type === 'attachment' || row.type === 'system' || row.type === 'summary') {
    const text = stringsOf(row.attachment ?? row.content ?? row.summary ?? '').join('\n');
    return text.trim() ? [{ kind: 'context', text }] : [];
  }
  return [];
}

function codexEntry(row) {
  const payload = row.payload || {};
  if (row.type === 'event_msg') {
    // Prompts come from the event stream; everything else there duplicates a
    // response_item.
    if (payload.type === 'user_message') return [{ kind: 'codexPrompt', text: contentText(payload.message) }];
    if (payload.type === 'item_completed' && payload.item?.type === 'UserMessage') {
      return [{ kind: 'codexPrompt', text: contentText(payload.item.content) }];
    }
    return [];
  }
  if (row.type === 'session_meta' || row.type === 'turn_context' || row.type === 'compacted') {
    const text = stringsOf(payload).join('\n');
    return text.trim() ? [{ kind: 'context', text }] : [];
  }
  if (row.type !== 'response_item') return [];
  switch (payload.type) {
    case 'message': {
      const text = contentText(payload.content);
      if (!text.trim()) return [];
      if (payload.role === 'assistant') return [{ kind: 'text', text }];
      if (payload.role === 'user') return [{ kind: 'codexUser', text }];
      return [{ kind: 'context', text }];
    }
    case 'function_call': return [{ kind: 'call', text: `${payload.name || ''} ${payload.arguments || ''}`, id: payload.call_id ?? null }];
    case 'custom_tool_call': return [{ kind: 'call', text: `${payload.name || ''} ${payload.input || ''}`, id: payload.call_id ?? null }];
    case 'local_shell_call': return [{ kind: 'call', text: stringsOf(payload.action).join(' '), id: payload.call_id ?? null }];
    case 'function_call_output':
    case 'custom_tool_call_output':
    case 'local_shell_call_output':
      return [{ kind: 'result', text: unescapeLiteral(contentText(payload.output)), id: payload.call_id ?? null }];
    case 'agent_message': return [{ kind: 'context', text: contentText(payload.content) }];
    default: return []; // reasoning: encrypted or summarized, never shown to the agent as text
  }
}

/**
 * One provider-neutral sequence from a transcript's rows: prompt (a human
 * turn), context (anything else the agent was shown), text (what it wrote),
 * call (a tool call's input), result (a tool's output). Repeated context
 * (Claude snapshots its system prompt on every turn) is kept once.
 */
export function normalizeTranscript(rows, { sidechain = false, readPersisted = null } = {}) {
  const codex = rows.some((row) => row?.type === 'response_item' || row?.type === 'session_meta');
  const raw = rows.flatMap((row) => {
    if (!row || typeof row !== 'object') return [];
    const ts = timestampMs(row.timestamp);
    return (codex ? codexEntry(row) : claudeEntry(row, { sidechain })).map((entry) => ({ ...entry, ts }));
  });
  // Claude moves a large tool output to a file and leaves a preview; the
  // recall's call_id and most of its results are in the file.
  if (readPersisted) {
    for (const entry of raw) {
      if (entry.kind !== 'result') continue;
      const saved = /Full output saved to:\s*(\S+)/u.exec(entry.text);
      const full = saved ? readPersisted(saved[1]) : null;
      if (full) entry.text = `${entry.text}\n${full}`;
    }
  }
  const eventPrompts = raw.some((entry) => entry.kind === 'codexPrompt');
  const seenContext = new Set();
  const entries = [];
  for (const entry of raw) {
    let { kind } = entry;
    if (kind === 'codexPrompt') kind = isHumanPrompt(entry.text) ? 'prompt' : 'context';
    if (kind === 'codexUser') kind = !eventPrompts && isHumanPrompt(entry.text) ? 'prompt' : 'context';
    if (kind === 'context') {
      const digest = createHash('sha1').update(entry.text).digest('hex');
      if (seenContext.has(digest)) continue;
      seenContext.add(digest);
    }
    if (kind === 'prompt') {
      // A prompt recorded twice (event stream and item stream) is one turn.
      let back = entries.length - 1;
      while (back >= 0 && entries[back].kind === 'context') back--;
      if (back >= 0 && entries[back].kind === 'prompt' && entries[back].text.trim() === entry.text.trim()) continue;
    }
    entries.push({ kind, text: entry.text, ts: entry.ts ?? null, id: entry.id ?? null });
  }
  return entries;
}

export function parseTranscriptText(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn line is skipped; the rest still reads */ }
  }
  return normalizeTranscript(rows);
}

function readPersistedOutput(filePath) {
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf8').slice(0, 512 * 1024) : null;
  } catch {
    return null;
  }
}

async function readTranscript(filePath, { sidechain = false } = {}) {
  const rows = [];
  const lines = readline.createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* skipped, as above */ }
  }
  return normalizeTranscript(rows, { sidechain, readPersisted: readPersistedOutput });
}

/** A Claude session's subagent transcripts: <dir>/<session>/subagents/*.jsonl beside the resolved file. */
function subagentTranscripts(transcript) {
  const dir = path.join(path.dirname(transcript), path.basename(transcript, '.jsonl'), 'subagents');
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.jsonl')).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

export const LOCATE_WINDOW_MS = 3 * 60 * 1000;

/**
 * Index of the recall's own output. Since mid-September every output prints
 * its call_id, so the first tool result (or injected context) naming it is the
 * call. Older CLI output printed only `=== Searching for: "<query>" ===`; for
 * those the match is that exact header on a result within LOCATE_WINDOW_MS of
 * the served rows, nearest first, that names no other call and that no other
 * call has claimed (`taken`, a Set of indexes the caller shares across calls).
 */
export function locateRecall(entries, callId, { query = null, timestampMs: at = null, taken = null } = {}) {
  const exact = entries.findIndex((entry) => (entry.kind === 'result' || entry.kind === 'context') && entry.text.includes(callId));
  if (exact >= 0 || !query || at === null) return exact >= 0 ? { index: exact, by: 'call_id' } : { index: -1, by: null };
  const header = `Searching for: "${query}"`;
  const namesAnotherCall = (text) => /\bcall-\d{8}T\d{6}-[\w-]+/u.test(text);
  let best = -1;
  let bestGap = Infinity;
  entries.forEach((entry, index) => {
    if (entry.kind !== 'result' || entry.ts === null || taken?.has(index)) return;
    if (!entry.text.includes(header) || namesAnotherCall(entry.text)) return;
    const gap = Math.abs(entry.ts - at);
    if (gap <= LOCATE_WINDOW_MS && gap < bestGap) { best = index; bestGap = gap; }
  });
  if (best >= 0) return { index: best, by: 'query_time' };

  // An agent that piped the search through grep or head kept neither the
  // header nor the call_id. The call that ran it still carries the query: take
  // that call's own result, matched by tool-use id.
  entries.forEach((entry, index) => {
    if (entry.kind !== 'call' || entry.ts === null || !entry.text.includes(query)) return;
    if (!/cartographer-search|remember-search|recall/u.test(entry.text)) return;
    const gap = Math.abs(entry.ts - at);
    if (gap > LOCATE_WINDOW_MS || gap >= bestGap) return;
    const result = entries.findIndex((other, j) => j > index && other.kind === 'result'
      && (entry.id ? other.id === entry.id : true));
    if (result < 0 || taken?.has(result) || namesAnotherCall(entries[result].text)) return;
    best = result;
    bestGap = gap;
  });
  return best >= 0 ? { index: best, by: 'query_call' } : { index: -1, by: null };
}

/**
 * The served results as the agent saw them: for each event_id named in the
 * recall output, its line and the indented lines that follow it, up to the
 * next result.
 */
export function displayedExcerpts(resultText, eventIds) {
  const lines = String(resultText ?? '').split('\n');
  const patterns = eventIds.map((id) => [id, new RegExp(`(^|[^A-Za-z0-9_-])${id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}($|[^A-Za-z0-9_-])`, 'u')]);
  const excerpts = new Map();
  const startsItem = (line) => /^\s*\d+\.\s/u.test(line) || /^\[\d{4}-\d{2}-\d{2}/u.test(line);
  for (let i = 0; i < lines.length; i++) {
    // A line naming several results is a structured dump (the MCP result's
    // JSON), not one result's summary.
    if (patterns.filter(([, re]) => re.test(lines[i])).length > 1) continue;
    for (const [id, re] of patterns) {
      if (excerpts.has(id) || !re.test(lines[i])) continue;
      const block = [lines[i]];
      for (let j = i + 1; j < lines.length && block.length < 8; j++) {
        const next = lines[j];
        if (!next.trim() || startsItem(next) || patterns.some(([, other]) => other.test(next))) break;
        block.push(next);
      }
      excerpts.set(id, block.join('\n').slice(0, 2000));
    }
  }
  return excerpts;
}

// Another search, as opposed to a fetch of one of this call's results.
const RECALL_CALL = /cartographer-search\.sh|remember-search\.sh|mcp__[\w-]*cartographer[\w-]*__recall\b/u;

/**
 * What the agent produced after the recall, minus what it had already seen.
 * known = every token before the recall output; tool results and context that
 * arrive after it join known as they arrive, so a token the agent could have
 * read elsewhere first is never credited to the summary.
 *
 * Three output sets, all up to the next human prompt:
 *   nextText  the first assistant text (the spec's channel)
 *   followUp  tool calls issued before that text: the agent's response to the
 *             recall. Later calls in a long turn have other sources, and a
 *             file name forty calls on is not a lead taken from a summary.
 *   calls     every tool call in the turn; only searched for handles
 */
export function readWindow(entries, at) {
  let end = entries.findIndex((entry, index) => index > at && entry.kind === 'prompt');
  if (end < 0) end = entries.length;
  const prompts = entries.slice(0, at).filter((entry) => entry.kind === 'prompt');
  const known = new Set();
  for (let index = 0; index < at; index++) tokenKeys(entries[index].text, known);
  const arrived = new Set();
  const isKnown = (key) => known.has(key) || arrived.has(key);
  const nextText = new Set();
  const turnText = new Set();
  const followUp = new Set();
  const calls = new Set();
  let nextTextRaw = null;
  let callsBeforeText = 0;
  let recallsBeforeText = 0;
  const callTexts = [];
  for (let index = at + 1; index < end; index++) {
    const entry = entries[index];
    if (entry.kind === 'result' || entry.kind === 'context') {
      tokenKeys(entry.text, arrived);
      continue;
    }
    const fresh = [...tokenize(entry.text).keys()].filter((key) => !isKnown(key));
    if (entry.kind === 'text') {
      for (const key of fresh) turnText.add(key);
      if (nextTextRaw === null) {
        nextTextRaw = entry.text;
        for (const key of fresh) nextText.add(key);
      }
    } else if (entry.kind === 'call') {
      for (const key of fresh) calls.add(key);
      if (nextTextRaw === null) {
        for (const key of fresh) followUp.add(key);
        callsBeforeText++;
        if (RECALL_CALL.test(entry.text) && !/--(get|touch|thread)\b/u.test(entry.text)) recallsBeforeText++;
      }
      callTexts.push(entry.text);
    }
  }
  return {
    at,
    end,
    promptsBefore: prompts.length,
    prompt: prompts.at(-1)?.text ?? '',
    recallText: entries[at].text,
    nextText,
    nextTextRaw,
    turnText,
    followUp,
    calls,
    callsBeforeText,
    recallsBeforeText,
    callTexts,
  };
}

/** Handles that name a served result outright: its event_id, and its transcript's stem and session. */
export function resultHandles(eventId, transcriptPaths = [], ownSession = null) {
  const handles = new Set([eventId.toLowerCase()]);
  const turn = /^turn-(?:codex-)?(.+)-\d+$/u.exec(eventId);
  if (turn) handles.add(turn[1].toLowerCase());
  for (const transcript of transcriptPaths) {
    if (!transcript) continue;
    handles.add(path.basename(transcript).replace(/\.jsonl$/u, '').toLowerCase());
  }
  if (ownSession) {
    // The agent's own session is not a lead to a served result.
    for (const handle of [...handles]) if (handle.includes(ownSession.toLowerCase())) handles.delete(handle);
  }
  return handles;
}

// ─── Classification ─────────────────────────────────────────────────────────

/**
 * Score one call's output against a set of served results. Used for the real
 * results and, unchanged, for a decoy call's results in the end-to-end check.
 */
export function scoreAgainst(window, results, excluded) {
  let handle = null;
  for (const result of results) {
    for (const key of result.handles) {
      if (window.calls.has(key) && (handle === null || (result.rank ?? Infinity) < (handle.rank ?? Infinity))) {
        handle = { rank: result.rank, handle: key, event_id: result.event_id };
      }
    }
  }
  return {
    handle,
    text: bestOverlap(results, window.nextText, excluded),
    turn: bestOverlap(results, window.turnText, excluded),
    tool: bestOverlap(results, window.followUp, excluded),
  };
}

/**
 * Category for a located call. The overlap channels must each beat their own
 * shuffled scores; a handle needs none, because an event_id cannot appear in a
 * tool call by chance.
 */
export function classifyLocated({ window, scores, nulls, cue, askedForRecall, options = {} }) {
  const textVerdict = overlapVerdict(scores.text.score, nulls.text, options);
  const toolVerdict = overlapVerdict(scores.tool.score, nulls.tool, options);
  const turnVerdict = overlapVerdict(scores.turn.score, nulls.turn, options);
  const turnOne = window.promptsBefore <= 1;
  // A subagent's first prompt is its parent's brief, not a user who did not
  // ask; its recalls are part of delegated work.
  const needless = turnOne && !cue && !askedForRecall && !window.subagent;
  let category;
  let rank = null;
  let via = null;
  if (scores.handle) {
    category = 'unmarked_use'; rank = scores.handle.rank; via = 'handle';
  } else if (toolVerdict.fires) {
    category = 'unmarked_use'; rank = scores.tool.rank; via = 'tool_tokens';
  } else if (textVerdict.fires) {
    category = 'good_abandonment'; rank = scores.text.rank; via = 'next_text';
  } else if (needless) {
    category = 'no_need';
  } else {
    category = 'bad_abandonment';
  }
  return {
    category, rank, via, turnOne, needless,
    p: { text: textVerdict.p, tool: toolVerdict.p, turn: turnVerdict.p },
    turnTextFires: turnVerdict.fires,
  };
}

/**
 * A located call's served results as the agent saw them: the displayed lines
 * from the recall output where they can be found, the logged summary
 * otherwise, and the handles that name each result outright.
 */
export function servedResults(call, window, records = new Map()) {
  const shown = displayedExcerpts(window.recallText, call.rows.map((row) => row.event_id));
  return call.rows.map((row) => {
    const record = records.get(row.event_id);
    const displayed = shown.get(row.event_id);
    const transcripts = [record?.transcript_path, ...(displayed ? [...displayed.matchAll(/transcript:\s*(\S+\.jsonl)/gu)].map((m) => m[1]) : [])];
    return {
      event_id: row.event_id,
      rank: row.rank,
      text: displayed || record?.summary || '',
      text_source: displayed ? 'displayed' : record ? 'log' : 'none',
      handles: resultHandles(row.event_id, transcripts, call.session_id),
    };
  });
}

/**
 * Score every located call against its own results and against shuffled
 * donors, then classify it, and classify it again with decoy results.
 * Each entry is { call, window, results } and gains tokens, excluded, cue,
 * scores, nulls, verdict and decoys. Donors come only from `located`, so the
 * baseline is drawn from the same population and summary corpus.
 */
export function judgeLocated(located, options) {
  options = { ...DEFAULTS, ...options };
  // Rarity is judged against everything served on the probed calls.
  const corpus = summaryDf(located.flatMap((entry) => entry.results.map((result) => result.text)));
  // Tokens agents produce unprompted: new to the conversation in the output of
  // many different calls (package.json, TODO.md, readme). Coming from no
  // particular summary, they are no evidence that one was used.
  const outputDf = new Map();
  for (const entry of located) {
    for (const key of new Set([...entry.window.nextText, ...entry.window.followUp, ...entry.window.turnText])) {
      outputDf.set(key, (outputDf.get(key) || 0) + 1);
    }
  }
  const genericCap = Math.max(3, options.genericCap * located.length);
  const generic = new Set([...outputDf].filter(([, count]) => count >= genericCap).map(([key]) => key));
  for (const entry of located) {
    for (const result of entry.results) {
      result.tokens = distinctiveTokens(result.text, corpus, options);
      for (const key of generic) result.tokens.delete(key);
      // The event_id is distinctive by construction, and citing it is quoting the result.
      result.tokens.add(result.event_id.toLowerCase());
    }
    // The query, and the call's own id, which the agent quotes when it checks telemetry.
    entry.excluded = tokenKeys(entry.call.query);
    entry.excluded.add(entry.call.call_id.toLowerCase());
    const cue = recallCue(entry.window.prompt);
    entry.cue = cue ? cue.cue : null;
    entry.askedForRecall = asksForRecall(entry.window.prompt);
  }

  const topicOf = (call) => {
    const counts = new Map();
    for (const row of call.rows) if (row.project) counts.set(row.project, (counts.get(row.project) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  };
  for (const entry of located) entry.topic = topicOf(entry.call);
  const donorsFor = (entry, salt, count) => {
    const random = seededRandom(`${options.seed}:${salt}:${entry.call.call_id}`);
    const pool = located.filter((other) => other.call.session_id !== entry.call.session_id && other.results.length > 0);
    if (options.donorScope !== 'project' || !entry.topic) return sampleDonors(pool, count, random);
    const same = pool.filter((other) => other.topic === entry.topic);
    const picked = sampleDonors(same, count, random);
    if (same.length >= options.minDonorPool || picked.length >= count) return picked;
    const rest = sampleDonors(pool.filter((other) => other.topic !== entry.topic), count - picked.length, random);
    return [...picked, ...rest];
  };
  const asServed = (donor, size) => [...donor.results]
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
    .slice(0, size);

  for (const entry of located) {
    const size = entry.results.length;
    const nulls = { text: [], tool: [], turn: [] };
    for (const donor of donorsFor(entry, 'null', options.donors)) {
      const shuffled = scoreAgainst(entry.window, asServed(donor, size), entry.excluded);
      nulls.text.push(shuffled.text.score);
      nulls.tool.push(shuffled.tool.score);
      nulls.turn.push(shuffled.turn.score);
    }
    entry.nulls = nulls;
    entry.scores = scoreAgainst(entry.window, entry.results, entry.excluded);
    entry.verdict = classifyLocated({ ...entry, options });

    // The end-to-end check: the same classifier, a decoy call's results.
    entry.decoys = [];
    for (let rep = 0; rep < options.decoys; rep++) {
      const [decoy] = donorsFor(entry, `decoy-${rep}`, 1);
      if (!decoy) continue;
      const decoyResults = asServed(decoy, size);
      const decoyScores = scoreAgainst(entry.window, decoyResults, entry.excluded);
      const decoyVerdict = classifyLocated({ ...entry, scores: decoyScores, options });
      entry.decoys.push({
        decoy_call_id: decoy.call.call_id,
        category: decoyVerdict.category,
        rank: decoyVerdict.rank,
        turn_text_fires: decoyVerdict.turnTextFires,
      });
    }
  }

  return { corpus, generic };
}

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** Copy the three telemetry logs so the gate and the probe read one frozen snapshot. */
export function snapshotTelemetry(paths, dir) {
  const snapshot = {};
  for (const [name, source] of Object.entries(paths)) {
    const target = path.join(dir, path.basename(source));
    if (existsSync(source)) copyFileSync(source, target);
    else writeFileSync(target, '');
    snapshot[name] = target;
  }
  return snapshot;
}

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

/** Summary and transcript path for each wanted event_id, from the five logs, read in place. */
async function loadEventRecords(devDir, wanted) {
  const records = new Map();
  for (const name of FIVE_LOGS) {
    const file = path.join(devDir, name);
    if (!existsSync(file)) continue;
    const lines = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of lines) {
      const at = line.indexOf('"event_id"');
      if (at < 0) continue;
      const match = /"event_id"\s*:\s*"([^"]+)"/u.exec(line.slice(at, at + 200));
      if (!match || !wanted.has(match[1]) || records.has(match[1])) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      const summary = SUMMARY_FIELDS.map((field) => row[field]).find((value) => typeof value === 'string' && value.trim()) || '';
      records.set(match[1], { summary, transcript_path: typeof row.transcript_path === 'string' ? row.transcript_path : null, log: name });
    }
  }
  return records;
}

const execFileAsync = promisify(execFile);

async function resolveTranscripts(sessionIds, { concurrency = 8 } = {}) {
  const resolver = path.join(SCRIPT_DIR, 'resolve-transcript.sh');
  const resolved = new Map();
  const queue = [...sessionIds];
  async function worker() {
    while (queue.length) {
      const sessionId = queue.shift();
      try {
        const { stdout } = await execFileAsync('bash', [resolver, sessionId], { timeout: 60_000 });
        const found = stdout.trim().split('\n')[0];
        resolved.set(sessionId, found && existsSync(found) ? found : null);
      } catch {
        resolved.set(sessionId, null);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return resolved;
}

// ─── The gate ────────────────────────────────────────────────────────────────

export function runGate(snapshot, rows, { hitRateReport = path.join(SCRIPT_DIR, 'hit-rate-report.js') } = {}) {
  const stdout = execFileSync(process.execPath, [hitRateReport, '--json'], {
    env: {
      ...process.env,
      CARTOGRAPHER_SERVED_LOG: snapshot.served,
      CARTOGRAPHER_ACCESS_LEDGER: snapshot.access,
      CARTOGRAPHER_SEARCH_CALL_LOG: snapshot.searchCalls,
    },
    maxBuffer: 512 * 1024 * 1024,
    encoding: 'utf8',
  });
  const shippedReport = JSON.parse(stdout);
  const shipped = shippedReport.utility;
  const calls = [...buildCallTable({ ...rows, purposes: new Set(['remember']) }).values()];
  const mine = mrrOf(calls);
  const check = (name, shippedValue, reproducedValue, tolerance, sourcePath) => ({
    name,
    shipped: shippedValue,
    reproduced: reproducedValue,
    delta: reproducedValue - shippedValue,
    tolerance,
    pool: 'purpose remember, all time, attributed rows',
    source: 'hit-rate-report.json',
    source_path: sourcePath,
    pass: Number.isFinite(reproducedValue - shippedValue) && Math.abs(reproducedValue - shippedValue) <= tolerance,
  });
  const checks = [
    check('hit-rate-report first-access MRR', shipped.firstAccessMrr, mine.mrr, GATE_TOLERANCE, 'utility.firstAccessMrr'),
    check('hit-rate-report ordered calls', shipped.orderedCalls, mine.ordered, 0, 'utility.orderedCalls'),
    check('hit-rate-report calls', shipped.calls, mine.calls, 0, 'utility.calls'),
  ];
  return {
    gate: {
      status: checks.every((entry) => entry.pass) ? 'ok' : 'FAILED',
      name: 'first-access MRR from this probe\'s own call table equals hit-rate-report.js on the same snapshot',
      n_records: mine.ordered,
      checks: checks.map(({ pass: _pass, ...rest }) => rest),
    },
    shippedReport,
    reproduced: mine,
  };
}

// ─── The probe ───────────────────────────────────────────────────────────────

function excerpt(text, max) {
  const flat = String(text ?? '').replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export async function probe(options) {
  const { devDir, cutoffMs, purposes, rows } = options;
  const table = buildCallTable({ ...rows, purposes });
  const windowCalls = [...table.values()].filter((call) => cutoffMs === null || (call.timestamp !== null && call.timestamp >= cutoffMs));
  const noUse = windowCalls.filter((call) => !hasAnyAccess(call));

  const outcomes = new Map();
  const settle = (call, category, extra = {}) => outcomes.set(call.call_id, { call, category, ...extra });

  const pending = [];
  for (const call of noUse) {
    if (call.purpose === 'prompt-cue') settle(call, 'no_need', { reason: 'prompt_cue_hook' });
    else if (call.rows.length === 0) settle(call, 'empty');
    else if (!isResolved(call.session_id)) settle(call, 'unresolved', { reason: 'no_session' });
    else pending.push(call);
  }

  const sessions = [...new Set(pending.map((call) => call.session_id))];
  const transcriptOf = await resolveTranscripts(sessions);
  const wanted = new Set(pending.flatMap((call) => call.rows.map((row) => row.event_id)));
  const records = await loadEventRecords(devDir, wanted);

  // Locate each call in its transcript and read what the agent did next.
  const located = [];
  for (const sessionId of sessions) {
    const sessionCalls = pending.filter((call) => call.session_id === sessionId);
    const transcript = transcriptOf.get(sessionId);
    if (!transcript) {
      for (const call of sessionCalls) settle(call, 'unresolved', { reason: 'no_transcript' });
      continue;
    }
    let entries;
    try {
      entries = await readTranscript(transcript);
    } catch (error) {
      for (const call of sessionCalls) settle(call, 'unresolved', { reason: 'unreadable_transcript', detail: String(error?.message || error) });
      continue;
    }
    // A subagent recalls under its parent's session id, so its output lives
    // in the parent's subagents/ directory. Read those files only when a call
    // is missing from the main transcript.
    let subagents = null;
    const taken = new Map();
    const claim = (file) => {
      if (!taken.has(file)) taken.set(file, new Set());
      return taken.get(file);
    };
    // Earliest first, so two calls with one query each claim their own output.
    for (const call of [...sessionCalls].sort((a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0))) {
      const hints = { query: call.query, timestampMs: call.timestamp };
      let source = { file: transcript, entries, subagent: false };
      let found = locateRecall(entries, call.call_id, { ...hints, taken: claim(transcript) });
      if (found.index < 0) {
        subagents ??= await Promise.all(subagentTranscripts(transcript).map(async (file) => ({
          file, entries: await readTranscript(file, { sidechain: true }).catch(() => []), subagent: true,
        })));
        for (const candidate of subagents) {
          const hit = locateRecall(candidate.entries, call.call_id, { ...hints, taken: claim(candidate.file) });
          if (hit.index >= 0) { source = candidate; found = hit; break; }
        }
      }
      const at = found.index;
      if (at >= 0) claim(source.file).add(at);
      if (at < 0) {
        settle(call, 'unresolved', { reason: 'call_not_in_transcript', transcript });
        continue;
      }
      const window = readWindow(source.entries, at);
      window.subagent = source.subagent;
      window.locatedBy = found.by;
      const results = servedResults(call, window, records);
      located.push({ call, transcript: source.file, window, results });
    }
  }

  const { corpus, generic } = judgeLocated(located, options);
  for (const entry of located) settle(entry.call, entry.verdict.category, { verdict: entry.verdict, entry });

  return { table, windowCalls, noUse, outcomes, located, corpus, generic };
}

// ─── Reporting ───────────────────────────────────────────────────────────────

function tally(outcomes, filter = () => true) {
  const counts = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  for (const outcome of outcomes) if (filter(outcome)) counts[outcome.category]++;
  return counts;
}

function creditMap(outcomes, categories) {
  const credit = new Map();
  for (const outcome of outcomes) {
    if (categories.has(outcome.category) && Number.isFinite(outcome.verdict?.rank)) credit.set(outcome.call.call_id, outcome.verdict.rank);
  }
  return credit;
}

function mrrTable(calls, outcomes, located, decoys) {
  const good = creditMap(outcomes, new Set(['good_abandonment']));
  const unmarked = creditMap(outcomes, new Set(['unmarked_use']));
  const implicit = creditMap(outcomes, IMPLICIT);
  const decoyRuns = [];
  for (let rep = 0; rep < decoys; rep++) {
    const credit = new Map();
    for (const entry of located) {
      const decoy = entry.decoys[rep];
      if (decoy && IMPLICIT.has(decoy.category) && Number.isFinite(decoy.rank)) credit.set(entry.call.call_id, decoy.rank);
    }
    decoyRuns.push(mrrOf(calls, { credit }));
  }
  const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
  const firstAccess = mrrOf(calls);
  return {
    firstAccess,
    plusGoodAbandonment: mrrOf(calls, { credit: good }),
    plusUnmarkedUse: mrrOf(calls, { credit: unmarked }),
    plusImplicit: mrrOf(calls, { credit: implicit }),
    plusDecoyImplicit: {
      reps: decoyRuns.length,
      meanCredited: mean(decoyRuns.map((run) => run.credited)),
      meanMrr: mean(decoyRuns.map((run) => run.mrr)),
      meanMrrGivenUse: mean(decoyRuns.map((run) => run.mrrGivenUse)),
    },
    explicitUse: mrrOf(calls, { source: 'result_used' }),
    explicitPlusImplicit: mrrOf(calls, { source: 'result_used', credit: implicit }),
  };
}

export function buildReport(result, options) {
  const outcomes = [...result.outcomes.values()];
  const byPurpose = {};
  for (const purpose of [...new Set(outcomes.map((outcome) => outcome.call.purpose))].sort()) {
    byPurpose[purpose] = tally(outcomes, (outcome) => outcome.call.purpose === purpose);
  }
  const located = result.located;
  const implicitLocated = located.filter((entry) => IMPLICIT.has(result.outcomes.get(entry.call.call_id).category));
  const decoyImplicit = located.length
    ? located.reduce((sum, entry) => sum + entry.decoys.filter((decoy) => IMPLICIT.has(decoy.category)).length, 0) / Math.max(1, options.decoys)
    : 0;
  const reasons = {};
  for (const outcome of outcomes) if (outcome.category === 'unresolved') reasons[outcome.reason] = (reasons[outcome.reason] || 0) + 1;
  const textSources = {};
  for (const entry of located) for (const r of entry.results) textSources[r.text_source] = (textSources[r.text_source] || 0) + 1;

  const crossTab = {};
  for (const entry of located) {
    const outcome = result.outcomes.get(entry.call.call_id);
    const key = `${outcome.verdict.turnOne ? 'turn_one' : 'later_turn'}/${entry.cue || entry.askedForRecall ? 'cue' : 'no_cue'}`;
    crossTab[key] ||= Object.fromEntries(CATEGORIES.slice(0, 4).map((category) => [category, 0]));
    crossTab[key][outcome.category]++;
  }

  const turnTextFires = located.filter((entry) => result.outcomes.get(entry.call.call_id).verdict.turnTextFires).length;
  const turnTextDecoy = located.reduce((sum, entry) => sum + entry.decoys.filter((decoy) => decoy.turn_text_fires).length, 0)
    / Math.max(1, options.decoys);

  const sets = {};
  const purposeSets = [['remember'], ['remember', 'mcp']];
  for (const set of purposeSets) {
    const calls = result.windowCalls.filter((call) => set.includes(call.purpose));
    const keep = new Set(calls.map((call) => call.call_id));
    sets[set.join('+')] = mrrTable(calls, outcomes.filter((outcome) => keep.has(outcome.call.call_id)),
      located.filter((entry) => keep.has(entry.call.call_id)), options.decoys);
  }

  return {
    generated_at: new Date().toISOString(),
    window: { days: options.days, cutoff: options.cutoffMs === null ? null : new Date(options.cutoffMs).toISOString() },
    purposes: options.purposes === 'all' ? ['all'] : [...options.purposes],
    detector: {
      min_shared: options.minShared,
      alpha: options.alpha,
      donors: options.donors,
      decoys: options.decoys,
      seed: options.seed,
      donor_scope: options.donorScope,
      min_donor_pool: options.minDonorPool,
      summary_docs: result.corpus.docs,
      generic_tokens: result.generic.size,
      result_text_sources: textSources,
    },
    population: {
      calls_in_window: result.windowCalls.length,
      no_access_calls: result.noUse.length,
      located: located.length,
      located_in_subagent: located.filter((entry) => entry.window.subagent).length,
      located_by: Object.fromEntries(['call_id', 'query_time', 'query_call'].map((by) => [by, located.filter((entry) => entry.window.locatedBy === by).length])),
      // How the agent responded before it next wrote: answering straight from
      // the summary line needs no tool call first.
      calls_before_next_text: {
        none: located.filter((entry) => entry.window.nextTextRaw !== null && entry.window.callsBeforeText === 0).length,
        one_to_three: located.filter((entry) => entry.window.nextTextRaw !== null && entry.window.callsBeforeText >= 1 && entry.window.callsBeforeText <= 3).length,
        four_or_more: located.filter((entry) => entry.window.nextTextRaw !== null && entry.window.callsBeforeText >= 4).length,
        no_text_in_turn: located.filter((entry) => entry.window.nextTextRaw === null).length,
      },
      // Bad abandonment the agent answered by searching again before it wrote:
      // the results did not satisfy, and a reformulation followed.
      bad_abandonment_requeried: located.filter((entry) => entry.verdict.category === 'bad_abandonment' && entry.window.recallsBeforeText > 0).length,
      unresolved_reasons: reasons,
    },
    splits: { total: tally(outcomes), by_purpose: byPurpose, by_turn_and_cue: crossTab },
    false_positive_check: {
      implicit_actual: implicitLocated.length,
      implicit_decoy_mean: decoyImplicit,
      located: located.length,
    },
    // The spec's channel is the agent's next text. Every assistant text up to
    // the next human prompt is the wider reading; it classifies nothing.
    turn_text_sensitivity: { fires: turnTextFires, decoy_mean: turnTextDecoy },
    mrr: sets,
  };
}

/** One probed call as a hand-check record. Quotes the transcript: never write it inside the repository. */
export function sampleRecord(outcome) {
  const { call, entry, verdict } = outcome;
  return {
    call_id: call.call_id,
    purpose: call.purpose,
    provider: call.provider,
    session_id: call.session_id,
    timestamp: call.timestamp === null ? null : new Date(call.timestamp).toISOString(),
    query: call.query,
    category: outcome.category,
    via: verdict?.via ?? outcome.reason ?? null,
    rank: verdict?.rank ?? null,
    turn_one: verdict?.turnOne ?? null,
    subagent: entry?.window.subagent ?? null,
    located_by: entry?.window.locatedBy ?? null,
    calls_before_next_text: entry?.window.callsBeforeText ?? null,
    recalls_before_next_text: entry?.window.recallsBeforeText ?? null,
    cue: entry?.cue ?? null,
    asked_for_recall: entry?.askedForRecall ?? null,
    p: verdict?.p ?? null,
    scores: entry ? {
      handle: entry.scores.handle,
      text: entry.scores.text,
      tool: entry.scores.tool,
      turn: entry.scores.turn,
      null_text_max: Math.max(0, ...entry.nulls.text),
      null_tool_max: Math.max(0, ...entry.nulls.tool),
    } : null,
    prompt: entry ? excerpt(entry.window.prompt, 600) : null,
    results: entry ? entry.results.map((result) => ({ rank: result.rank, event_id: result.event_id, source: result.text_source, text: excerpt(result.text, 400) })) : null,
    next_text: entry ? excerpt(entry.window.nextTextRaw, 1200) : null,
    tool_calls: entry ? entry.window.callTexts.slice(0, 6).map((text) => excerpt(text, 300)) : null,
    transcript: entry?.transcript ?? outcome.transcript ?? null,
  };
}

// ─── Command line ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = {
    days: DEFAULTS.days, purposes: new Set(DEFAULTS.purposes), minShared: DEFAULTS.minShared, alpha: DEFAULTS.alpha,
    donors: DEFAULTS.donors, decoys: DEFAULTS.decoys, seed: DEFAULTS.seed, wordDfCap: DEFAULTS.wordDfCap,
    shapeDfCap: DEFAULTS.shapeDfCap, genericCap: DEFAULTS.genericCap, donorScope: DEFAULTS.donorScope,
    minDonorPool: DEFAULTS.minDonorPool, json: false, out: null, handCheck: 0, skipGate: null,
    devDir: process.env.CARTOGRAPHER_DEV_DIR || path.join(os.homedir(), 'Documents', 'dev'),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    const number = (min) => {
      const parsed = Number(value());
      if (!Number.isFinite(parsed) || parsed < min) throw new Error(`${arg} must be a number >= ${min}`);
      return parsed;
    };
    if (arg === '--days') { const v = value(); options.days = v === 'all' ? 'all' : Number(v); if (v !== 'all' && !(options.days > 0)) throw new Error('--days must be a positive number or "all"'); }
    else if (arg === '--purpose') options.purposes = value() === 'all' ? 'all' : new Set(argv[i].split(',').map((p) => p.trim()).filter(Boolean));
    else if (arg === '--min-shared') options.minShared = number(1);
    else if (arg === '--alpha') options.alpha = number(0);
    else if (arg === '--donors') options.donors = Math.floor(number(1));
    else if (arg === '--decoys') options.decoys = Math.floor(number(0));
    else if (arg === '--seed') options.seed = value();
    else if (arg === '--donor-scope') { options.donorScope = value(); if (!['project', 'any'].includes(options.donorScope)) throw new Error('--donor-scope must be project or any'); }
    else if (arg === '--json') options.json = true;
    else if (arg === '--out') options.out = path.resolve(value());
    else if (arg === '--hand-check') options.handCheck = Math.floor(number(0));
    else if (arg === '--skip-gate') options.skipGate = value();
    else if (arg === '--dev-dir') options.devDir = path.resolve(value());
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function insideRepo(target) {
  const relative = path.relative(REPO_ROOT, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function gitHead() {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const fmt = (value, digits = 3) => (value === null || value === undefined ? '—' : Number(value).toFixed(digits));
const pct = (n, d) => (d ? `${((n / d) * 100).toFixed(1)}%` : '—');

function renderText(report, gate) {
  const lines = [];
  lines.push('Session Cartographer — recall calls with no recorded access');
  lines.push('='.repeat(62));
  if (gate.status === 'skipped') lines.push(`Gate SKIPPED: ${gate.reason}`);
  else {
    const [mrr, ordered, calls] = gate.checks;
    lines.push(`Gate ${gate.status}: first-access MRR ${fmt(mrr.reproduced, 4)} vs hit-rate-report ${fmt(mrr.shipped, 4)} `
      + `(Δ ${mrr.delta.toExponential(1)}); ordered ${ordered.reproduced}/${ordered.shipped}; calls ${calls.reproduced}/${calls.shipped}`);
  }
  lines.push(`Window: ${report.window.days === 'all' ? 'all time' : `last ${report.window.days} days`}; purposes ${report.purposes.join(', ')}`);
  lines.push(`Calls in window ${report.population.calls_in_window}; no access ${report.population.no_access_calls}; located in a transcript ${report.population.located} (${report.population.located_in_subagent} in a subagent's; by ${Object.entries(report.population.located_by).map(([by, n]) => `${by} ${n}`).join(', ')})`);
  const gap = report.population.calls_before_next_text;
  lines.push(`Tool calls between the recall and the agent's next text: none ${gap.none} · 1-3 ${gap.one_to_three} · 4+ ${gap.four_or_more} · no text before the next prompt ${gap.no_text_in_turn}`);
  lines.push(`Bad abandonment followed by another search before the next text: ${report.population.bad_abandonment_requeried} of ${report.splits.total.bad_abandonment}`);
  const total = report.splits.total;
  const noAccess = report.population.no_access_calls;
  lines.push('\nNo-access calls:');
  for (const category of CATEGORIES) lines.push(`  ${category.padEnd(17)} ${String(total[category]).padStart(4)}  ${pct(total[category], noAccess)}`);
  if (Object.keys(report.population.unresolved_reasons).length) {
    lines.push(`  unresolved by reason: ${Object.entries(report.population.unresolved_reasons).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  }
  lines.push('\nBy purpose:');
  for (const [purpose, counts] of Object.entries(report.splits.by_purpose)) {
    lines.push(`  ${purpose.padEnd(11)} ${CATEGORIES.map((category) => `${category} ${counts[category]}`).join(' · ')}`);
  }
  lines.push('\nLocated calls by turn and cue:');
  for (const [key, counts] of Object.entries(report.splits.by_turn_and_cue).sort()) {
    lines.push(`  ${key.padEnd(20)} ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  }
  const fp = report.false_positive_check;
  lines.push(`\nFalse-positive check: implicit use on ${fp.implicit_actual}/${fp.located} located calls with their own results; `
    + `${fmt(fp.implicit_decoy_mean, 1)} on average with a decoy call's results (${report.detector.decoys} decoys each)`);
  lines.push(`Turn-text sensitivity: ${report.turn_text_sensitivity.fires} fire on all assistant text in the turn (decoy ${fmt(report.turn_text_sensitivity.decoy_mean, 1)})`);
  for (const [set, table] of Object.entries(report.mrr)) {
    lines.push(`\nMRR — ${set} (${table.firstAccess.calls} calls, ${table.firstAccess.ordered} ordered)`);
    const row = (label, value) => lines.push(`  ${label.padEnd(36)} ${fmt(value.mrr)}   given use ${fmt(value.mrrGivenUse)}   credited ${value.credited ?? 0}`);
    row('first access (any access row)', table.firstAccess);
    row('+ good abandonment', table.plusGoodAbandonment);
    row('+ unmarked use', table.plusUnmarkedUse);
    row('+ both (implicit use)', table.plusImplicit);
    lines.push(`  ${'+ decoy implicit (null, mean)'.padEnd(36)} ${fmt(table.plusDecoyImplicit.meanMrr)}   given use ${fmt(table.plusDecoyImplicit.meanMrrGivenUse)}   credited ${fmt(table.plusDecoyImplicit.meanCredited, 1)}`);
    row('explicit use (result_used)', table.explicitUse);
    row('explicit use + implicit use', table.explicitPlusImplicit);
  }
  return lines.join('\n');
}

function handCheckMarkdown(samples) {
  const lines = ['# Abandonment probe — hand check', '',
    'Corpus text. Lives outside the repository. For each call: does the label hold?', ''];
  for (const sample of samples) {
    lines.push(`## ${sample.category} · ${sample.call_id}`);
    lines.push(`- purpose ${sample.purpose} · provider ${sample.provider} · ${sample.timestamp} · via ${sample.via} · rank ${sample.rank} · turn one ${sample.turn_one} · cue ${sample.cue ?? '—'}${sample.asked_for_recall ? ' · asked for recall' : ''}`);
    lines.push(`- p text ${fmt(sample.p?.text)} · p tool ${fmt(sample.p?.tool)} · text shared [${(sample.scores?.text.shared || []).join(', ')}] · tool shared [${(sample.scores?.tool.shared || []).join(', ')}]${sample.scores?.handle ? ` · handle ${sample.scores.handle.handle}` : ''}`);
    lines.push(`- tool calls before the next text: ${sample.calls_before_next_text} · located by ${sample.located_by}${sample.subagent ? ' (subagent)' : ''}`);
    lines.push(`- query: ${sample.query}`);
    lines.push(`- prompt: ${excerpt(sample.prompt, 300)}`);
    lines.push('- results (the credited one in full, the top three otherwise):');
    for (const result of sample.results || []) {
      const credited = result.rank === sample.rank && sample.rank !== null;
      if (!credited && result.rank > 3) continue;
      lines.push(`  - ${credited ? '**' : ''}${result.rank}.${credited ? '**' : ''} [${result.source}] ${excerpt(result.text, credited ? 400 : 160)}`);
    }
    lines.push(`- next text: ${sample.next_text ? excerpt(sample.next_text, 600) : '(none before the next prompt)'}`);
    if (sample.tool_calls?.length) lines.push(`- tool calls: ${sample.tool_calls.slice(0, 3).map((text) => `\`${excerpt(text, 160).replace(/`/gu, "'")}\``).join(' · ')}`);
    lines.push('');
  }
  return lines.join('\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    const lines = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1);
    process.stdout.write(`${lines.slice(0, lines.findIndex((line) => !line.startsWith('//'))).map((line) => line.slice(3)).join('\n')}\n`);
    return 0;
  }
  if (options.out && insideRepo(options.out)) {
    throw new Error(`--out ${options.out} is inside the repository; samples quote transcripts and must not be committed`);
  }
  options.cutoffMs = options.days === 'all' ? null : Date.now() - options.days * DAY_MS;

  const live = {
    served: process.env.CARTOGRAPHER_SERVED_LOG || path.join(options.devDir, 'served-log.jsonl'),
    access: process.env.CARTOGRAPHER_ACCESS_LEDGER || path.join(options.devDir, 'access-ledger.jsonl'),
    searchCalls: process.env.CARTOGRAPHER_SEARCH_CALL_LOG || path.join(options.devDir, '.carto', 'search-calls.jsonl'),
  };
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'carto-abandonment-'));
  try {
    const snapshot = snapshotTelemetry(live, scratch);
    const rows = {
      servedRows: parseJsonl(snapshot.served).rows,
      accessRows: parseJsonl(snapshot.access).rows,
      searchCallRows: parseJsonl(snapshot.searchCalls).rows,
    };
    const provenance = {
      commit: gitHead(),
      snapshot_sha256: Object.fromEntries(Object.entries(snapshot).map(([name, file]) => [name, sha256File(file)])),
      live_paths: live,
    };

    let gate;
    if (options.skipGate) {
      gate = { status: 'skipped', reason: options.skipGate, checks: [] };
    } else {
      const ran = runGate(snapshot, rows);
      gate = ran.gate;
      if (options.out) {
        mkdirSync(options.out, { recursive: true });
        writeFileSync(path.join(options.out, 'hit-rate-report.json'), `${JSON.stringify(ran.shippedReport, null, 2)}\n`);
      }
      if (gate.status !== 'ok') {
        const failed = { gate, provenance, note: 'the probe could not reproduce hit-rate-report.js; no new number is reported' };
        if (options.out) writeFileSync(path.join(options.out, 'summary.FAILED.json'), `${JSON.stringify(failed, null, 2)}\n`);
        process.stderr.write(`${JSON.stringify(gate, null, 2)}\nabandonment-report: gate FAILED; nothing reported\n`);
        return 3;
      }
    }

    const result = await probe({ ...options, rows });
    const report = { gate, provenance, ...buildReport(result, options) };

    if (options.out) {
      mkdirSync(options.out, { recursive: true });
      writeFileSync(path.join(options.out, 'summary.json'), `${JSON.stringify(report, null, 2)}\n`);
      const outcomes = [...result.outcomes.values()];
      writeFileSync(path.join(options.out, 'calls.jsonl'), outcomes.map((outcome) => JSON.stringify(sampleRecord(outcome))).join('\n') + (outcomes.length ? '\n' : ''));
      if (options.handCheck > 0) {
        const random = seededRandom(`${options.seed}:hand-check`);
        const implicit = sampleDonors(outcomes.filter((outcome) => IMPLICIT.has(outcome.category)), options.handCheck, random);
        const abandoned = sampleDonors(outcomes.filter((outcome) => outcome.category === 'bad_abandonment' || outcome.category === 'no_need'), options.handCheck, random);
        writeFileSync(path.join(options.out, 'hand-check.md'), handCheckMarkdown([...implicit, ...abandoned].map(sampleRecord)));
      }
    }
    process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${renderText(report, gate)}\n`);
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`abandonment-report: ${error?.stack || error}\n`);
    process.exitCode = 2;
  });
}
