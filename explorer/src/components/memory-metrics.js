// One definition for overview, hover, comparison, and session drill-down.
export function sessionMetricsAt(session, at, files = []) {
  const events = session.events.filter(e => e[0] <= at);
  const counts = { activity: 0, edit: 0, research: 0, commit: 0, lifecycle: 0 };
  for (const e of events) counts[e[1]] = (counts[e[1]] || 0) + 1;
  const first = events[0]?.[0] ?? null;
  const last = events.at(-1)?.[0] ?? null;
  const activeEvents = events.filter(e => e[1] !== 'lifecycle');
  let activeMs = 0;
  for (let i = 1; i < activeEvents.length; i++) {
    const gap = activeEvents[i][0] - activeEvents[i - 1][0];
    if (gap <= 15 * 60000) activeMs += gap;
  }
  const base = session.metrics?.tokens || { status: 'missing', reason: 'Token usage was not recorded for this session.' };
  const tokens = { ...base };
  const series = (session.tokenSeries || []).filter(t => t.t <= at);
  tokens.capturedUntil = series.at(-1)?.t ?? null;
  if (!series.length && base.status !== 'missing') {
    tokens.status = 'missing';
    tokens.reason = 'No token usage record at the selected time.';
  }
  for (const key of ['output', 'input', 'cacheRead', 'cacheWrite', 'total']) {
    if (tokens.status === 'missing' || !Number.isFinite(base[key])) tokens[key] = null;
    else tokens[key] = series.reduce((sum, t) => sum + (Number.isFinite(t[key]) ? t[key] : 0), 0);
  }
  tokens.samples = series.length;
  return {
    counts, events, first, last,
    spanMs: first === null ? 0 : last - first,
    activeMs, tokens,
    fileCount: files.filter(f => f.edits.some(e => e.t <= at)).length,
    eventCount: events.length,
  };
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return 'Unrecorded';
  const minutes = Math.round(ms / 60000);
  if (ms > 0 && minutes === 0) return '<1m';
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}` : `${minutes}m`;
}

export function formatCount(value) {
  if (!Number.isFinite(value)) return 'Unrecorded';
  return new Intl.NumberFormat(undefined, { notation: value >= 10000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

// One fixed reference for the visible outcome list, independent of wall-clock
// refreshes and input ordering. Replay must not reveal later outcomes.
export function outcomeTimeline(outcomes = [], at = Infinity) {
  return outcomes.filter(note => Number.isFinite(note.t) && note.t <= at && /commit|wrapup/.test(note.type || ''))
    .slice().sort((a,b) => b.t-a.t);
}

export function formatTimeOffset(time, baseline) {
  const delta=time-baseline;
  if (!Number.isFinite(delta)) return '';
  if (delta===0) return '0m';
  const sign=delta<0?'−':'+';
  const minutes=Math.floor(Math.abs(delta)/60000);
  if (!minutes) return `${sign}<1m`;
  const hours=Math.floor(minutes/60), days=Math.floor(hours/24);
  return sign + [days && `${days}d`, hours%24 && `${hours%24}h`, minutes%60 && `${minutes%60}m`].filter(Boolean).join(' ');
}
