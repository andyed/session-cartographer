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
export function projectDesk(data, { at = data.end, since = data.start, query = '', filter = 'all' } = {}) {
  const needle = query.trim().toLowerCase();
  const sessions = data.sessions.map(session => {
    const events = session.events.filter(e => e[0] <= at);
    const fresh = events.filter(e => e[0] > since);
    const files = (data.files[session.id] || []).filter(f => f.edits.some(e => e.t <= at));
    const notes = (session.notes || []).filter(n => n.t <= at).sort((a, b) => b.t - a.t);
    const outcomes = (session.outcomes || session.notes || []).filter(n => n.t > since && n.t <= at && /commit|wrapup/.test(n.type));
    const state = sessionWorkState(session, at);
    return { session, files, notes, outcomes, state, fresh, events };
  }).filter(row => row.events.length && (!needle || [row.session.title, row.session.fullTitle, ...Object.keys(row.session.projects || {}), ...row.files.map(f => f.path), ...row.notes.map(n => n.text)].join(' ').toLowerCase().includes(needle)))
    .sort((a, b) => (b.state.last || 0) - (a.state.last || 0) || a.session.id.localeCompare(b.session.id));
  const owners = new Map();
  for (const row of sessions) for (const file of row.files) {
    if (!owners.has(file.path)) owners.set(file.path, []);
    owners.get(file.path).push(row.session.id);
  }
  return {
    sessions: sessions.filter(row => filter === 'flight' ? row.state.id === 'flight' : filter === 'changed' ? row.fresh.length > 0 : true),
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
