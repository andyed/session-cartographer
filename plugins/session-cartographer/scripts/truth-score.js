// truth-score.js — graded relevance against the demo/truth labels.
//
// The one definition of "is this result relevant to this truth query", shared
// by scripts/eval-search.js (per-arm precision report) and scripts/age-curve.js
// (the topical case kind, which compares ranking curves in-process).
//
// demo/truth/ is gitignored: the labels name real sessions, so they exist only
// in the maintainer's own checkout. Nothing here writes them anywhere.
//
// A result is matched in two steps:
//
// 1. Explicit event-level match against truth.events: by event_id where the
//    label has one (42 of 142 do), else by word overlap. It wins when present,
//    because a truth event can carry grade 0 — noise the query matches but the
//    intent does not want — or `relevant: false`, which the labels use for a
//    tangential hit that still earned a grade (the same word in another
//    project's feature). Either way it is judged and not relevant.
// 2. Session-level fallback. An event in a session the truth file marks
//    relevant gets a grade from the session's role (primary 3, secondary 2,
//    other 1). Commit summaries ("Commit abc123: feat: ... | files: ...") do
//    not lexically match hand-written truth summaries, so without this the
//    matcher scored P@5 0 on queries whose session recall was 100%.
//
// Word overlap needs half of the label's content words *and* at least two of
// them (all of them, for a label with fewer). Until 2026-10-17 half was enough,
// and 94 of the 142 labels have three content words or fewer. A label that is
// one file edit ("Modified:" and a file name) is two, so every `Modified:` row
// in the corpus matched it at grade 3, and a two-word label about the
// timeline's legends credited a gaze-plot prompt from another project, which
// shared only the word "timeline", to the Explorer's timeline feature. Nothing
// errored. It favoured whichever ranking put more recent one-word matches on
// the page, which is the property a decay comparison is trying to measure.
//
// A result neither step matches is unjudged. Plain precision counts it as not
// relevant, which is the convention, and is biased here in one direction: the
// labels were written in April 2026 against sessions from that time, so newer
// work on the same topic is unjudged by construction. A ranking that surfaces
// it loses plain precision for being recent. Judged precision (a condensed
// list, Sakai 2007: drop the unjudged, then take the first k) is the check on
// that bias, and both are reported.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function loadTruth(dir) {
  if (!existsSync(dir)) return null;
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
}

function words(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter((w) => w.length > 2);
}

const STOP = new Set(['the', 'and', 'for', 'this', 'that', 'with', 'from', 'was', 'are', 'not', 'but', 'has', 'had',
  'have', 'will', 'been', 'can', 'its', 'all', 'also', 'into', 'let', 'now', 'then', 'done', 'just']);

function sessionRoleGrade(role) {
  if (role === 'primary') return 3;
  if (role === 'secondary') return 2;
  return 1;
}

// Session ids may be truncated in either source, so match a 12-character
// prefix in both directions.
export function sameSession(a, b) {
  return Boolean(a && b) && (a.includes(b.slice(0, 12)) || b.includes(a.slice(0, 12)));
}

const overlapNeeded = (n) => Math.min(n, Math.max(2, Math.ceil(n / 2)));

function fromLabel(te, via) {
  const grade = Number(te.grade) || 0;
  return { grade, relevant: grade > 0 && te.relevant !== false, noise: te.noise || null, summary: te.summary || '', via };
}

/**
 * The truth label an event matches, as { grade, relevant, noise, summary, via },
 * or null when unjudged. `via` is event_id, overlap or session.
 */
export function matchTruth(event, truth) {
  const labels = truth.events || [];
  if (event.event_id) {
    const exact = labels.find((te) => te.event_id && te.event_id === event.event_id);
    if (exact) return fromLabel(exact, 'event_id');
  }
  const eTokens = new Set(words(event.summary).filter((w) => !STOP.has(w)));
  if (eTokens.size > 0) {
    let best = null;
    let bestScore = 0;
    for (const te of labels) {
      const tTokens = [...new Set(words(te.summary).filter((w) => !STOP.has(w)))];
      if (tTokens.length === 0) continue;
      const shared = tTokens.filter((w) => eTokens.has(w)).length;
      const score = shared / tTokens.length;
      if (shared >= overlapNeeded(tTokens.length) && score > bestScore) { bestScore = score; best = te; }
    }
    if (best) return fromLabel(best, 'overlap');
  }
  for (const [sid, info] of Object.entries(truth.sessions || {})) {
    if (info.relevant && sameSession(sid, event.session || '')) {
      return { grade: sessionRoleGrade(info.role), relevant: true, noise: null,
        summary: `[session:${sid.slice(0, 8)} ${info.role || 'relevant'}]`, via: 'session' };
    }
  }
  return null;
}

/**
 * Score one ranked list of events ({ summary, session, sources?, timestamp? })
 * against one truth query. Precision is over the first k results with unjudged
 * counted as not relevant; judgedP10 is precision over the first 10 *judged*
 * results; gain10 is the mean grade of the top 10 over the top grade (3), so a
 * primary-session hit counts more than a context one.
 */
export function scoreTruth(truth, events, { depth = 20, details = false } = {}) {
  const relevantSessionIds = Object.entries(truth.sessions || {}).filter(([, v]) => v.relevant).map(([k]) => k);
  const sessions = new Set(events.map((e) => e.session).filter(Boolean));
  const sessionRecall = relevantSessionIds.length
    ? relevantSessionIds.filter((sid) => [...sessions].some((s) => sameSession(sid, s))).length / relevantSessionIds.length
    : 0;

  const at = { 5: 0, 10: 0, 20: 0 };
  let gain = 0;
  let unjudged10 = 0;
  const noiseBreakdown = {};
  const rows = [];
  const judged = [];
  events.forEach((event, i) => {
    const truthHit = matchTruth(event, truth);
    if (truthHit) judged.push(truthHit.relevant);
    if (i >= depth) return;
    const isRelevant = truthHit ? truthHit.relevant : false;
    for (const k of [5, 10, 20]) if (i < k && isRelevant) at[k]++;
    if (i < 10) {
      if (isRelevant) gain += truthHit.grade / 3;
      if (!truthHit) unjudged10++;
    }
    const noise = truthHit?.noise || (isRelevant ? null : truthHit ? 'judged_not_relevant' : 'unlabeled');
    if (noise) noiseBreakdown[noise] = (noiseBreakdown[noise] || 0) + 1;
    if (details) {
      rows.push({ rank: i + 1, relevant: isRelevant, grade: truthHit?.grade ?? '?', noise,
        summary: String(event.summary || '').slice(0, 60), sources: event.sources || '' });
    }
  });
  const kOf = (k) => Math.min(k, events.length);
  const condensed = judged.slice(0, 10);
  return {
    precision5: kOf(5) ? at[5] / kOf(5) : 0,
    precision10: kOf(10) ? at[10] / kOf(10) : 0,
    precision20: kOf(20) ? at[20] / kOf(20) : 0,
    judgedP10: condensed.length ? condensed.filter(Boolean).length / condensed.length : 0,
    judged: judged.length,
    gain10: kOf(10) ? gain / kOf(10) : 0,
    unjudged10,
    sessionRecall,
    sessionsFound: sessions.size,
    relevantSessions: relevantSessionIds.length,
    noiseBreakdown,
    details: rows,
  };
}

/** A hybridSearch item as the event shape scoreTruth reads. */
export function eventFromItem(item) {
  return {
    timestamp: item.timestamp || '',
    sources: item._sources || '',
    event_id: item.event_id || '',
    summary: String(item.summary || item.description || item.prompt || '').split('\n')[0],
    session: item.session_id || item.session || '',
    project: item.project || '',
  };
}

/** A `--format jsonl` CLI row as the same shape; the session rides in `extras` (key:value|...). */
export function eventFromCliRow(row) {
  const extras = String(row.extras || '');
  const session = /(?:^|\|)session:([^|]+)/.exec(extras)?.[1] || '';
  return { timestamp: row.timestamp || '', sources: row.source || '', event_id: row.event_id || '',
    summary: String(row.summary || ''), session, project: row.project || '' };
}
