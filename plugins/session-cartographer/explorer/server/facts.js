import { performance } from 'node:perf_hooks';
import { CORPUS_ROOT, LOG_FILES, logPositions, readAppended } from './jsonl.js';
import { parseTimeArg } from './search.js';
import { eventEpochMs, utcDay } from './event-time.js';
import { projectMatcher, resolveProjectValues } from './project-filter.js';
import { isResolved, firstResolved } from '../../scripts/sentinels.js';
import {
  FACTS_CONTRACT_VERSION,
  FactsContractError,
  decodeCursor,
  encodeCursor,
  normalizeFactsRequest,
} from './facts-contract.js';

/**
 * ---------------------------------------------------------------------------
 * Why there is no index here.
 * ---------------------------------------------------------------------------
 *
 * The obvious design for "make aggregate questions cheap" is to precompute
 * aggregates. Measured on this corpus, that would have been wasted work: the
 * expensive step is reading 127k events off disk (881 ms), which the warm
 * service already pays once and holds. Once the events are resident, a full
 * linear fold over every one of them costs 12-22 ms — a census, a session
 * rollup, and a project x day tempo series each use under 2% of Turbo's
 * 1500 ms request budget.
 *
 * So these are folds, not indexes. Nothing is precomputed, nothing has to be
 * invalidated, nothing can go stale against the array it reads, and adding a
 * new fact is adding a function rather than a data structure plus its
 * maintenance path. The one measured exception is extraction-derived facts —
 * pulling file paths out of free-text summaries with a regex costs 368 ms — and
 * that is precisely where an index would earn its keep, and equally where the
 * extraction heuristic can be confidently wrong (`trust-digest.js` got its
 * command and hostname extraction wrong twice before evidence corrected it).
 * Those verbs are deliberately not in this slice.
 */

/** Attach a bounded sample of the ids behind a count. */
function bucketList(counts, samples, { top, sample }) {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([name, count]) => {
      const row = { name, count };
      if (sample > 0) row.event_ids = (samples.get(name) || []).slice(0, sample);
      return row;
    });
}

function tally(counts, samples, key, eventId, sampleMax) {
  counts.set(key, (counts.get(key) || 0) + 1);
  // Only a real id belongs in the sample. An unattributed row still counts
  // toward the bucket — it happened — but it cannot be checked, and letting it
  // occupy a sample slot spends the bucket's whole audit budget on entries the
  // caller cannot fetch. A bucket whose first rows lacked ids would hand back
  // [null, null] while perfectly checkable ids sat further down the same
  // bucket, which turns the one field that makes a count verifiable into a
  // field that reads as "nothing here is verifiable". The unattributed rows are
  // already reported by count; the sample's job is to be usable with --get.
  if (sampleMax > 0 && isResolved(eventId)) {
    let list = samples.get(key);
    if (!list) { list = []; samples.set(key, list); }
    if (list.length < sampleMax) list.push(eventId);
  }
}

function parseBound(value, field) {
  if (!value) return null;
  const parsed = parseTimeArg(value);
  if (parsed === null) throw new FactsContractError(`cannot parse ${field} value '${value}'`);
  return parsed;
}

/**
 * The event's type, under whichever field its writer used.
 *
 * The five logs do not agree on a name: changelog and tool-use write `type`,
 * milestones write `event` and `milestone`. The extraction fallback chain is a
 * documented invariant of this pipeline — hardcoding one field would make whole
 * sources vanish from a breakdown while the totals still looked plausible.
 */
function eventType(event) {
  return firstResolved([event.type, event.event, event.milestone], null);
}

function eventSession(event) {
  return firstResolved([event.session_id, event.session], null);
}

/**
 * census — what is in this window, counted.
 *
 * Every dimension reports its unattributed rows as their own number rather than
 * folding them into a bucket. `scripts/sentinels.js` exists because `"unknown"`
 * is truthy and equal to itself, so grouping on it silently manufactures one
 * phantom entity that looks like a real, very busy project or session; during
 * the 0.5.0 repair that phantom overstated a recovery rate by 54%. An honest
 * census says "22 sessions, plus 31 rows I cannot attribute", never "23".
 */
export function census(events, request) {
  const sinceMs = parseBound(request.since, 'since');
  const beforeMs = parseBound(request.before, 'before');
  const matchesProject = projectMatcher(request.project);
  const { top, sample } = request;

  const byProject = new Map(); const projectIds = new Map();
  const byType = new Map(); const typeIds = new Map();
  const bySource = new Map(); const sourceIds = new Map();
  const byProvider = new Map(); const providerIds = new Map();
  const sessions = new Set();
  const commits = [];

  let total = 0;
  let windowedOut = 0;
  let undatedDropped = 0;
  let undated = 0;
  // Every dimension gets a counter, including `_source`. In practice
  // readAllEvents always stamps it, so this is normally zero — but a dimension
  // that can silently drop a row is a dimension whose buckets no longer sum to
  // the total, and the whole argument for a census over a ranked sample is that
  // its numbers reconcile.
  const unattributed = { project: 0, session: 0, provider: 0, type: 0, source: 0, event_id: 0 };
  let oldest = null;
  let newest = null;

  for (const event of events) {
    const ts = eventEpochMs(event);
    const windowActive = sinceMs !== null || beforeMs !== null;
    if (ts === null) {
      // A row with no readable timestamp cannot honestly be placed inside or
      // outside a window. Drop it and report the count, exactly as the portable
      // fusion does — never default it to now, which would file every
      // malformed row into the most recent window.
      //
      // Undated rows are counted whether or not a window is active, and the
      // drop is counted separately. Folding both into one field made an
      // unwindowed census report zero undated rows while they sat in its own
      // totals: the same field name meaning "how many exist" in one call and
      // "how many I excluded" in the next.
      undated += 1;
      if (windowActive) { undatedDropped += 1; continue; }
    } else if (windowActive) {
      if (sinceMs !== null && ts < sinceMs) { windowedOut += 1; continue; }
      if (beforeMs !== null && ts > beforeMs) { windowedOut += 1; continue; }
    }
    if (!matchesProject(event.project)) continue;

    total += 1;
    const id = isResolved(event.event_id) ? event.event_id : null;
    if (!id) unattributed.event_id += 1;

    if (ts !== null) {
      if (oldest === null || ts < oldest) oldest = ts;
      if (newest === null || ts > newest) newest = ts;
    }

    if (isResolved(event.project)) tally(byProject, projectIds, event.project, id, sample);
    else unattributed.project += 1;

    const type = eventType(event);
    if (type) tally(byType, typeIds, type, id, sample);
    else unattributed.type += 1;

    if (isResolved(event._source)) tally(bySource, sourceIds, event._source, id, sample);
    else unattributed.source += 1;

    if (isResolved(event.provider)) tally(byProvider, providerIds, event.provider, id, sample);
    else unattributed.provider += 1;

    const session = eventSession(event);
    if (session) sessions.add(session);
    else unattributed.session += 1;

    // Commits and pushes are the highest-confidence deterministic facts in the
    // corpus: they are not inferred from prose, they happened. They are the
    // rows a daily pulse most needs and the rows relevance ranking is least
    // able to surface, since a commit summary shares no vocabulary with a
    // question like "what happened yesterday".
    if (type && /^git_/.test(type) && commits.length < 200) {
      commits.push({
        event_id: id,
        project: isResolved(event.project) ? event.project : null,
        type,
        timestamp: event.timestamp || null,
        summary: String(event.summary || event.description || '').slice(0, 300),
      });
    }
  }

  return {
    events: total,
    windowed_out: windowedOut,
    undated,
    undated_dropped: undatedDropped,
    unattributed,
    sessions: { resolved: sessions.size },
    span: {
      oldest: oldest === null ? null : new Date(oldest).toISOString(),
      newest: newest === null ? null : new Date(newest).toISOString(),
    },
    by_project: bucketList(byProject, projectIds, { top, sample }),
    by_type: bucketList(byType, typeIds, { top, sample }),
    by_source: bucketList(bySource, sourceIds, { top, sample }),
    by_provider: bucketList(byProvider, providerIds, { top, sample }),
    commits,
  };
}

/**
 * tempo — the project x day series, plus how unusual the window is.
 *
 * This exists so "is 407 events a lot for this project" stops being a judgment
 * call made by reading a list. The caller gets the trailing baseline and a
 * z-score; deciding what to do about an unusual day is the part worth spending
 * a language model on.
 *
 * The baseline deliberately excludes the scored day. Including it drags the
 * mean toward the value being tested, which is how a genuinely anomalous day
 * scores as ordinary — the more extreme the day, the more it corrupts its own
 * comparison.
 */
export function tempo(events, request) {
  const sinceMs = parseBound(request.since, 'since');
  const beforeMs = parseBound(request.before, 'before');
  const matchesProject = projectMatcher(request.project);

  const perProject = new Map();
  // Per-project ids for the day each project is actually scored on, so a
  // z-score is checkable rather than merely asserted. Sampling the whole window
  // would prove nothing about the one number the caller acts on.
  const perProjectDayIds = new Map();
  let undatedDropped = 0;
  // census reports what it excluded; tempo must too, or a caller comparing a
  // census total against a tempo total finds a discrepancy with nothing in
  // either response to explain it.
  let windowedOut = 0;
  let unattributedProject = 0;

  for (const event of events) {
    const ts = eventEpochMs(event);
    if (ts === null) { undatedDropped += 1; continue; }
    if (sinceMs !== null && ts < sinceMs) { windowedOut += 1; continue; }
    if (beforeMs !== null && ts > beforeMs) { windowedOut += 1; continue; }
    if (!matchesProject(event.project)) continue;
    if (!isResolved(event.project)) { unattributedProject += 1; continue; }

    let days = perProject.get(event.project);
    if (!days) { days = new Map(); perProject.set(event.project, days); }
    const day = utcDay(ts);
    days.set(day, (days.get(day) || 0) + 1);

    if (request.sample > 0 && isResolved(event.event_id)) {
      let byDay = perProjectDayIds.get(event.project);
      if (!byDay) { byDay = new Map(); perProjectDayIds.set(event.project, byDay); }
      let ids = byDay.get(day);
      if (!ids) { ids = []; byDay.set(day, ids); }
      if (ids.length < request.sample) ids.push(event.event_id);
    }
  }

  // The current UTC day is still being written. Scoring it against complete
  // days is not a small bias, it is a guaranteed one: a day two hours old is
  // compared to twenty-four-hour days and always reads as a collapse in
  // activity. On the first run of this verb every project scored negative for
  // exactly that reason. So the partial day is reported and never scored, and
  // the score describes the last day that actually finished.
  const today = utcDay(Date.now());

  const series = [];
  for (const [project, days] of perProject) {
    const observed = [...days.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    // A day with no events is a zero, not a missing observation. Counting only
    // active days means a project touched on 3 days out of 14 gets a baseline
    // that is the mean of its 3 busy days, so every quiet stretch inflates the
    // comparison and pushes the score negative. Inactivity is the signal here,
    // not the absence of one.
    const ordered = fillZeroDays(observed, sinceMs, beforeMs);
    const complete = ordered.filter(([day]) => day !== today);
    const partial = ordered.find(([day]) => day === today) || null;
    const scored = complete[complete.length - 1] || null;
    const baseline = complete.slice(0, -1).map(([, count]) => count);
    series.push({
      project,
      days: ordered.map(([day, count]) => ({ day, count, complete: day !== today })),
      total: ordered.reduce((sum, [, count]) => sum + count, 0),
      partial_day: partial ? { day: partial[0], count: partial[1], scored: false } : null,
      scored_day: scored ? scored[0] : null,
      scored_count: scored ? scored[1] : 0,
      // Ids drawn from the scored day only — the number the caller acts on is
      // the one that has to be checkable.
      scored_day_event_ids: scored
        ? (perProjectDayIds.get(project)?.get(scored[0]) || []).slice(0, request.sample)
        : [],
      ...zscore(scored ? scored[1] : 0, baseline),
    });
  }

  series.sort((a, b) => b.total - a.total);
  return {
    undated_dropped: undatedDropped,
    windowed_out: windowedOut,
    unattributed: { project: unattributedProject },
    projects_total: series.length,
    projects_truncated: Math.max(0, series.length - request.top),
    projects: series.slice(0, request.top),
  };
}

// A tempo series is one row per day, so an unbounded window would let the
// response grow with the age of the corpus. A year of daily counts is already
// far more than any caller reads; beyond that the series is clamped to the most
// recent span and says so, rather than being silently shortened.
const TEMPO_MAX_DAYS = 366;

// The standard rule of thumb for when a normal approximation to a count
// distribution becomes usable. Below this mean, a z-score computed on daily
// event counts reports magnitudes it cannot support.
const POISSON_NORMAL_MIN_MEAN = 10;

/**
 * Expand an observed day->count list into a dense daily series, inserting zeros
 * for days with no events. The span runs from the requested window start (or the
 * first observed day when the window is open-ended) to the last observed day.
 */
function fillZeroDays(observed, sinceMs, beforeMs) {
  if (observed.length === 0) return observed;
  const DAY_MS = 24 * 60 * 60 * 1000;
  const firstObserved = Date.parse(`${observed[0][0]}T00:00:00Z`);
  const lastObserved = Date.parse(`${observed[observed.length - 1][0]}T00:00:00Z`);
  // An open-ended window starts at the first day the project was actually seen.
  // Zero-filling back to the beginning of the corpus would describe the days
  // before a project existed as days it was idle.
  let start = sinceMs === null ? firstObserved : Math.max(sinceMs, firstObserved);
  const end = beforeMs === null ? lastObserved : Math.min(beforeMs, lastObserved);
  start = Math.floor(start / DAY_MS) * DAY_MS;
  if (end < start) return observed;
  if ((end - start) / DAY_MS + 1 > TEMPO_MAX_DAYS) {
    start = end - (TEMPO_MAX_DAYS - 1) * DAY_MS;
  }
  const counts = new Map(observed);
  const dense = [];
  for (let t = start; t <= end; t += DAY_MS) {
    const day = utcDay(t);
    dense.push([day, counts.get(day) || 0]);
  }
  return dense;
}

/**
 * A z-score is only meaningful with enough baseline to estimate spread, and a
 * zero-variance baseline makes it undefined rather than infinite. Both cases
 * return null with a stated reason: "not enough history to say" is a real
 * answer, and dressing it up as 0.0 would read as "perfectly ordinary".
 */
function zscore(value, baseline) {
  if (baseline.length < 3) {
    return { baseline_days: baseline.length, baseline_mean: null, z: null, z_status: 'insufficient_history' };
  }
  const mean = baseline.reduce((sum, n) => sum + n, 0) / baseline.length;
  const variance = baseline.reduce((sum, n) => sum + (n - mean) ** 2, 0) / baseline.length;
  const sd = Math.sqrt(variance);
  const rounded = Math.round(mean * 100) / 100;
  const nonzero = baseline.filter((n) => n > 0).length;
  if (sd === 0) {
    return {
      baseline_days: baseline.length,
      baseline_nonzero_days: nonzero,
      baseline_mean: rounded,
      baseline_sd: 0,
      z: null,
      z_status: 'zero_variance',
    };
  }
  return {
    baseline_days: baseline.length,
    baseline_nonzero_days: nonzero,
    baseline_mean: rounded,
    baseline_sd: Math.round(sd * 100) / 100,
    z: Math.round(((value - mean) / sd) * 100) / 100,
    // A z-score treats the baseline as roughly normal. Daily event counts are
    // not: they are Poisson-ish and heavily zero-inflated, and the normal
    // approximation to a count distribution only holds once the mean is around
    // ten or more. Below that the standard deviation is tiny and the score
    // explodes — real runs on this corpus produced z=44.9 against a baseline
    // mean of 2.33, and z=60.1 against 0.22. The arithmetic is right and the
    // number is useless: it invites reading 44.9 as far more anomalous than 4
    // when both only mean "this project was idle and then it wasn't".
    //
    // So the score is reported and the regime is labelled, rather than the
    // score being suppressed or silently rescaled. `sparse_baseline` means the
    // ordering is still directionally usable but the magnitude is not; `ok`
    // means the baseline can carry one.
    z_status: (mean < POISSON_NORMAL_MIN_MEAN || nonzero < 3) ? 'sparse_baseline' : 'ok',
  };
}

/**
 * delta — what was appended since the caller last looked.
 *
 * This is the verb a scheduled agent actually needs, and it is the one a time
 * window cannot express. The corpus is backfilled: `backfill-git-history.sh`,
 * `retro-index.sh`, and `catch-up-transcripts.sh` all append events dated
 * months in the past, so "everything with a timestamp after my last run" and
 * "everything that arrived since my last run" are different sets, and only the
 * second is what "what's new" means. Arrival order lives in the append-only
 * logs, not in the resident array, so this reads the log tails — bounded by how
 * much was appended, not by corpus size.
 */
export function delta(request, { corpusRoot = CORPUS_ROOT, logFiles = LOG_FILES } = {}) {
  const baseline = !request.cursor;
  const positions = baseline
    ? logPositions(logFiles)
    : decodeCursor(request.cursor, { corpusRoot });

  if (baseline) {
    // A first call establishes a position and claims nothing is new. The
    // alternative — replaying 127k events as "changes" — would be true only in
    // the most useless sense.
    return {
      cursor: encodeCursor({ corpusRoot, positions }),
      baseline: true,
      events: [],
      returned: 0,
      pending: {},
      stale: {},
      summary: emptySummary(),
    };
  }

  const matchesProject = projectMatcher(request.project);
  const { events, positions: next, stale, pending } = readAppended(positions, {
    budget: request.budget,
    logFiles,
  });

  // Project scope is applied after the read, not before: the cursor has to
  // advance past events the caller filtered out, or an agent watching one
  // project would re-read every unrelated event on every call forever.
  const scoped = events.filter((event) => matchesProject(event.project));

  // The event logs deliberately overlap: a hook writes one event to changelog
  // and again to its domain log. `readAllEvents` collapses that pair for the
  // resident corpus, but these rows come straight off the log tails, so without
  // the same collapse one arrival is reported as two — and a caller counting
  // "what happened since my last run" would double every hook-written event.
  // Keep the domain source label over `changelog`, matching readAllEvents.
  const byId = new Map();
  const unidentified = [];
  for (const event of scoped) {
    if (!isResolved(event.event_id)) { unidentified.push(event); continue; }
    const existing = byId.get(event.event_id);
    if (!existing) { byId.set(event.event_id, event); continue; }
    if (existing._source === 'changelog' && event._source !== 'changelog') {
      byId.set(event.event_id, { ...existing, ...event });
    }
  }
  const deduped = [...byId.values(), ...unidentified];
  const duplicatesCollapsed = scoped.length - deduped.length;

  return {
    cursor: encodeCursor({ corpusRoot, positions: next }),
    baseline: false,
    // A source flagged here contributed nothing and its position was
    // re-baselined. The caller's diff is incomplete for that source and needs
    // to know, rather than receiving a confident partial answer.
    stale,
    pending,
    // `read` counts raw log lines consumed; `returned` counts distinct events
    // after project scope and overlap collapse. They differ for ordinary
    // reasons, so both are reported rather than one being presented as the
    // arrival count.
    returned: deduped.length,
    read: events.length,
    scoped_out: events.length - scoped.length,
    duplicates_collapsed: duplicatesCollapsed,
    summary: summarize(deduped, request),
    events: deduped.map((event) => ({
      event_id: isResolved(event.event_id) ? event.event_id : null,
      source: event._source,
      timestamp: event.timestamp || null,
      project: isResolved(event.project) ? event.project : null,
      type: eventType(event),
      session_id: eventSession(event),
      summary: String(event.summary || event.description || event.note || '').slice(0, 300),
    })),
  };
}

function emptySummary() {
  return { by_source: [], by_project: [], by_type: [] };
}

function summarize(events, { top, sample }) {
  const bySource = new Map(); const sourceIds = new Map();
  const byProject = new Map(); const projectIds = new Map();
  const byType = new Map(); const typeIds = new Map();
  for (const event of events) {
    const id = isResolved(event.event_id) ? event.event_id : null;
    if (isResolved(event._source)) tally(bySource, sourceIds, event._source, id, sample);
    if (isResolved(event.project)) tally(byProject, projectIds, event.project, id, sample);
    const type = eventType(event);
    if (type) tally(byType, typeIds, type, id, sample);
  }
  return {
    by_source: bucketList(bySource, sourceIds, { top, sample }),
    by_project: bucketList(byProject, projectIds, { top, sample }),
    by_type: bucketList(byType, typeIds, { top, sample }),
  };
}

/**
 * Describe how a requested project scope resolved against the corpus.
 *
 * `status` is the field to read: `all` means no scope was requested, `resolved`
 * means the spec named at least one project that exists, and `unresolved` means
 * it named none — so a zero count is a scoping failure, not a quiet window.
 * The matched values are returned because the caller usually did not write
 * them: a family name is expected to admit its repositories, and seeing which
 * ones it actually admitted is how an over-broad or a too-narrow spec is
 * caught before its numbers are believed.
 */
function projectScope(events, spec) {
  if (!spec) return { requested: null, status: 'all', matched: [] };
  const matched = resolveProjectValues(
    (function* () { for (const event of events) yield event.project; })(),
    spec,
  );
  return {
    requested: spec,
    status: matched.length > 0 ? 'resolved' : 'unresolved',
    matched: matched.slice(0, 100),
    matched_count: matched.length,
  };
}

/**
 * Execute one facts request against the warm corpus.
 *
 * This never writes. `scripts/cartographer-search.sh` is the single writer of
 * served and access telemetry, and that boundary is what keeps a retry or a
 * fallback from double-counting a call — a facts endpoint that logged its own
 * activity would reintroduce exactly the double-write the recall contract was
 * shaped to prevent.
 */
export function executeFacts({ events, index }, rawRequest, options = {}) {
  const started = performance.now();
  const request = normalizeFactsRequest(rawRequest);
  const corpusRoot = options.corpusRoot || CORPUS_ROOT;

  if (request.corpus_root && request.corpus_root !== corpusRoot) {
    throw new FactsContractError(
      `this service indexes ${corpusRoot}, not ${request.corpus_root}`,
      409,
    );
  }

  const scanStarted = performance.now();
  let facts;
  if (request.verb === 'census') facts = census(events, request);
  else if (request.verb === 'tempo') facts = tempo(events, request);
  else facts = delta(request, { corpusRoot, logFiles: options.logFiles });
  const scanMs = performance.now() - scanStarted;

  return {
    contract_version: FACTS_CONTRACT_VERSION,
    backend: 'explorer',
    verb: request.verb,
    call_id: request.call_id,
    corpus_root: corpusRoot,
    // Ties the answer to a corpus state. Two facts carrying the same generation
    // were computed over the same events and can be compared; two carrying
    // different generations cannot, and a caller diffing them would be
    // measuring the index rather than the work.
    index_generation: options.indexGeneration ? options.indexGeneration() : null,
    corpus_events: events.length,
    indexed_docs: index?.docs?.size ?? null,
    window: { since: request.since || null, before: request.before || null },
    project: request.project || null,
    // Says whether the requested scope resolved to anything real. Without it,
    // "your spec named no project I know" and "that project was quiet" are the
    // same response: zero.
    project_scope: projectScope(events, request.project),
    facts,
    stages_ms: {
      scan: Math.round(scanMs * 100) / 100,
      total: Math.round((performance.now() - started) * 100) / 100,
    },
  };
}
