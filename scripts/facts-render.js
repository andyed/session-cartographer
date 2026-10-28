/**
 * Text rendering for facts responses.
 *
 * Shared by the facts CLI (cartographer-facts.js) and the MCP server
 * (cartographer-mcp.js), so an agent reading a census through either one reads
 * the same table. A second renderer would drift from this one the way the six
 * inline sentinel checks drifted before scripts/sentinels.js existed.
 *
 * Pure functions over a validated facts response; no I/O.
 */

function num(value) {
  return Number(value ?? 0).toLocaleString('en-US');
}

function clip(value, max) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * A bucket table, counts right-aligned against the widest count in the table.
 *
 * The sample ids are printed rather than summarized because they are the whole
 * reason the engine attaches them: a count you cannot check is a count you have
 * to trust, and these feed straight into `cartographer-search.sh --get`.
 */
function table(label, rows, { max = 20 } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) return `  ${label}: none\n`;
  const visible = rows.slice(0, max);
  const nameWidth = Math.min(40, Math.max(label.length, ...visible.map((r) => String(r.name).length)));
  const countWidth = Math.max(5, ...visible.map((r) => num(r.count).length));
  let out = `  ${label.padEnd(nameWidth)}  ${'count'.padStart(countWidth)}  sample event_ids\n`;
  for (const row of visible) {
    const ids = Array.isArray(row.event_ids) ? row.event_ids.filter(Boolean).join(' ') : '';
    out += `  ${clip(row.name, nameWidth).padEnd(nameWidth)}  ${num(row.count).padStart(countWidth)}  ${ids}\n`;
  }
  if (rows.length > visible.length) out += `  … ${rows.length - visible.length} more bucket(s)\n`;
  return out;
}

function pairs(object) {
  const entries = Object.entries(object || {});
  if (entries.length === 0) return 'none';
  return entries.map(([key, value]) => `${key}=${num(value)}`).join('  ');
}

function header(response, transport) {
  const window = response.window || {};
  let out = `facts ${response.verb} · ${num(response.corpus_events)} events resident`
    + ` · ${response.stages_ms.total.toFixed(1)} ms (${transport})\n`;
  out += `  corpus ${response.corpus_root}  generation ${response.index_generation || 'unknown'}\n`;
  if (window.since || window.before || response.project) {
    out += `  window ${window.since || 'corpus start'} → ${window.before || 'now'}`
      + `${response.project ? `  project ${clip(response.project, 80)}` : ''}\n`;
  }
  return `${out}\n`;
}

function renderCensus(facts) {
  const span = facts.span || {};
  let out = `${num(facts.events)} events · ${num(facts.sessions?.resolved)} sessions`
    + ` · ${num(facts.commits?.length)} git events\n`;
  out += `  span        ${span.oldest || '—'} → ${span.newest || '—'}\n`;
  // Reported, never folded into a bucket: an "unknown" project is truthy and
  // equal to itself, so counting it as a project manufactures one phantom that
  // reads as the busiest thing in the corpus.
  out += `  unattributed ${pairs(facts.unattributed)}\n`;
  out += `  dropped     windowed_out=${num(facts.windowed_out)}  undated=${num(facts.undated_dropped)}\n\n`;
  out += table('by_project', facts.by_project);
  out += '\n';
  out += table('by_type', facts.by_type);
  out += '\n';
  out += table('by_source', facts.by_source);
  out += '\n';
  out += table('by_provider', facts.by_provider);
  const commits = facts.commits || [];
  out += `\n  commits (${num(commits.length)})\n`;
  for (const commit of commits.slice(0, 25)) {
    out += `  ${(commit.timestamp || '?').padEnd(26)} ${clip(commit.project || '—', 24).padEnd(24)}`
      + ` ${clip(commit.summary, 90)}\n`;
  }
  if (commits.length > 25) out += `  … ${commits.length - 25} more\n`;
  return out;
}

function renderTempo(facts) {
  const projects = facts.projects || [];
  let out = `${num(projects.length)} project(s) · undated dropped ${num(facts.undated_dropped)}\n\n`;
  if (projects.length === 0) return `${out}  (no dated, project-attributed events in this window)\n`;
  const nameWidth = Math.min(36, Math.max(7, ...projects.map((p) => String(p.project).length)));
  out += `  ${'project'.padEnd(nameWidth)}  ${'total'.padStart(7)}  ${'scored_day'.padEnd(10)}`
    + `  ${'count'.padStart(6)}  ${'baseline'.padStart(9)}  ${'z'.padStart(7)}  status                partial_day\n`;
  for (const p of projects) {
    // The current UTC day is still being written, so it is shown and explicitly
    // never scored — comparing two hours of a day against 24-hour days reads as
    // a collapse in activity for every project, every time.
    const partial = p.partial_day
      ? `${p.partial_day.day}:${num(p.partial_day.count)} (unscored)`
      : '—';
    out += `  ${clip(p.project, nameWidth).padEnd(nameWidth)}`
      + `  ${num(p.total).padStart(7)}`
      + `  ${(p.scored_day || '—').padEnd(10)}`
      + `  ${num(p.scored_count).padStart(6)}`
      + `  ${(p.baseline_mean === null ? '—' : p.baseline_mean.toFixed(2)).padStart(9)}`
      + `  ${(p.z === null ? '—' : p.z.toFixed(2)).padStart(7)}`
      + `  ${String(p.z_status).padEnd(20)}  ${partial}\n`;
  }
  return out;
}

function renderDelta(facts) {
  let out = '';
  // Stale first and unmissable. A stale source contributed nothing and had its
  // position re-baselined, so the caller's diff is incomplete for that source —
  // a fact that is worthless if it scrolls past under the event list.
  const stale = Object.entries(facts.stale || {});
  if (stale.length > 0) {
    out += `!! STALE SOURCES — this diff is INCOMPLETE for: ${stale.map(([s, why]) => `${s} (${why})`).join(', ')}\n`;
    out += '!! Those logs were rewritten or truncated under the cursor; their positions were re-baselined.\n\n';
  }
  if (facts.baseline) {
    out += 'baseline call · 0 events · cursor established\n';
    out += '  A first call records a position; it does not replay the corpus as "changes".\n';
  } else {
    out += `${num(facts.returned)} returned · ${num(facts.read)} read · pending ${pairs(facts.pending)}\n`;
  }
  out += `  cursor ${facts.cursor}\n`;
  if (!facts.baseline) {
    const summary = facts.summary || {};
    out += '\n';
    out += table('by_source', summary.by_source);
    out += '\n';
    out += table('by_project', summary.by_project);
    out += '\n';
    out += table('by_type', summary.by_type);
    out += '\n';
    for (const event of facts.events || []) {
      out += `[${event.timestamp || '?'}] [${event.source}] ${event.event_id || '(no event_id)'}\n`;
      out += `  ${clip(event.summary, 200)}\n`;
      if (event.project) out += `  project: ${event.project}\n`;
      if (event.type) out += `  type: ${event.type}\n`;
      if (event.session_id) out += `  session: ${event.session_id}\n`;
      out += '\n';
    }
  }
  return out;
}

export function renderText(response, transport) {
  let out = header(response, transport);
  if (response.verb === 'census') out += renderCensus(response.facts);
  else if (response.verb === 'tempo') out += renderTempo(response.facts);
  else out += renderDelta(response.facts);
  out += `\n(call_id: ${response.call_id})\n`;
  return out;
}
