// Evidence-based work states, shared by the desk and its tests. A recent event
// is an observation, never a claim about a process or an approval queue.
export const RECENT_MS = 15 * 60 * 1000;
export function sessionWorkState(session, at) {
  const events = session.events.filter(e => e[0] <= at);
  const last = events.at(-1)?.[0] ?? null;
  const stop = [...(session.notes || []), ...(session.outcomes || [])]
    .filter(n => n.t <= at && /session_end|sessionend|agent_stop|wrapup/.test(n.type || ''))
    .sort((a, b) => b.t - a.t)[0];
  if (stop && (last === null || stop.t >= last)) return { id: 'settled', label: 'Handoff recorded', last };
  if (last !== null && at - last <= RECENT_MS) return { id: 'flight', label: 'Recently active', last };
  return { id: 'quiet', label: 'Quiet', last };
}
function matchesQuery(session, files, notes, needle) {
  return !needle || [session.title, session.fullTitle, ...Object.keys(session.projects || {}), ...files.map(file => file.path), ...notes.map(note => note.text)].join(' ').toLowerCase().includes(needle);
}

/** One search scope for the desk and every chart. Keep source order and facts;
 * query changes only membership, never the source snapshot or primary brush. */
export function filterMemoryByQuery(data, { query = '', at = data.end } = {}) {
  const needle = query.trim().toLowerCase();
  if (!needle) return data;
  const sessions = data.sessions.filter(session => session.events.some(event => event[0] <= at) && matchesQuery(
    session,
    (data.files[session.id] || []).filter(file => file.edits.some(edit => edit.t <= at)),
    (session.notes || []).filter(note => note.t <= at).sort((a, b) => b.t - a.t),
    needle,
  ));
  const groups = new Set(sessions.map(session => session.group));
  return {
    ...data, sessions,
    groups: (data.groups || []).filter(group => groups.has(group)),
    files: Object.fromEntries(sessions.map(session => [session.id, data.files[session.id] || []])),
    total: sessions.reduce((total, session) => total + session.events.length, 0),
    unattributed: 0,
  };
}
export const isDocument = path => /\.(?:md|markdown|mdown)$/i.test(path);

/** One row per path across every thread that touched it, newest thread first.
 *  The trail is recorded per session, but a reader looks for a document, and the
 *  same TODO.md recurs in a dozen threads a week. Documents sort ahead of code;
 *  `kind: 'md'` keeps only documents. At this depth the query narrows files as
 *  well as threads: a thread that matched by path contributes only the matching
 *  paths, while one that matched by title or note contributes all of its files. */
export function groupArtifacts(rows, { at, needle = '', kind = 'all' } = {}) {
  const groups = new Map();
  for (const row of rows) {
    const pathMatched = needle ? row.files.some(file => file.path.toLowerCase().includes(needle)) : false;
    for (const file of row.files) {
      if (kind === 'md' && !isDocument(file.path)) continue;
      if (pathMatched && !file.path.toLowerCase().includes(needle)) continue;
      const last = file.edits.reduce((latest, edit) => edit.t <= at && edit.t > latest ? edit.t : latest, 0);
      if (!last) continue;
      if (!groups.has(file.path)) groups.set(file.path, { id: file.path, path: file.path, name: file.name || file.path.split('/').at(-1), isDoc: isDocument(file.path), last: 0, threads: [] });
      const group = groups.get(file.path);
      group.threads.push({ session: row.session, file, last });
      group.last = Math.max(group.last, last);
    }
  }
  for (const group of groups.values()) group.threads.sort((a, b) => b.last - a.last || a.session.id.localeCompare(b.session.id));
  return [...groups.values()].sort((a, b) => (kind === 'all' && a.isDoc !== b.isDoc ? (a.isDoc ? -1 : 1) : 0) || b.last - a.last || a.path.localeCompare(b.path));
}

export function projectDesk(data, { at = data.end, since = data.start, query = '', filter = 'all', kind = 'all' } = {}) {
  const needle = query.trim().toLowerCase();
  const sessions = data.sessions.map(session => {
    const events = session.events.filter(e => e[0] <= at);
    const fresh = events.filter(e => e[0] > since);
    const files = (data.files[session.id] || []).filter(f => f.edits.some(e => e.t <= at));
    const notes = (session.notes || []).filter(n => n.t <= at).sort((a, b) => b.t - a.t);
    const outcomes = (session.outcomes || session.notes || []).filter(n => n.t > since && n.t <= at && /commit|wrapup/.test(n.type));
    const state = sessionWorkState(session, at);
    return { session, files, notes, outcomes, state, fresh, events };
  }).filter(row => row.events.length && matchesQuery(row.session, row.files, row.notes, needle))
    .sort((a, b) => (b.state.last || 0) - (a.state.last || 0) || a.session.id.localeCompare(b.session.id));
  const owners = new Map();
  for (const row of sessions) for (const file of row.files) {
    if (!owners.has(file.path)) owners.set(file.path, []);
    owners.get(file.path).push(row.session.id);
  }
  const visible = sessions.filter(row => filter === 'flight' ? row.state.id === 'flight' : filter === 'changed' ? row.fresh.length > 0 : true);
  return {
    sessions: visible,
    artifacts: groupArtifacts(visible, { at, needle, kind }),
    all: sessions,
    owners,
    outcomes: sessions.flatMap(row => row.outcomes.map(note => ({ session: row.session, note }))).sort((a, b) => b.note.t - a.note.t),
    commits: sessions.reduce((n, row) => n + row.fresh.filter(e => e[1] === 'commit').length, 0),
    changed: sessions.filter(row => row.fresh.length).length,
  };
}
export function resumeCommand(session) {
  if (!/^[\w-]{1,256}$/.test(session.id)) return null;
  const command = session.provider === 'codex' ? `codex resume ${session.id}` : session.provider === 'claude' ? `claude --resume ${session.id}` : null;
  if (!command) return null;
  const cwd = session.cwd;
  const quote = value => `'${value.replace(/'/g, `'\\''`)}'`;
  return typeof cwd === 'string' && cwd.startsWith('/') && !/[\x00-\x1f]/.test(cwd) ? `cd ${quote(cwd)} && ${command}` : command;
}
