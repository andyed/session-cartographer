// Folds a recorded session's actions into the Board that drawMap and the feed read.
//
// lot-map grows its board one live event at a time and drops it when the session
// ends. A recorded session already holds every event, so the same board can be
// folded for any moment: the end of the session, or a point a replay scrubs to.

/** Rows the feed keeps, as in lot-map: the map's totals come from `counts`, not from these. */
const KEEP = 80

const isFault = status => status === 'err' || status === 'block'

/**
 * @param actions  time-ordered: { station, label, from, startedAt, endedAt?, status, agentId?, mark? }
 * @param at       the moment to fold up to, in epoch ms; Infinity folds the whole session
 * @param extra    board fields the actions do not carry (model, context)
 */
export function boardAt(actions, at = Infinity, extra = {}) {
  const entries = []
  const counts = {}
  let faults = {}
  let n = 0

  for (const a of actions) {
    if (!Number.isFinite(a.startedAt) || a.startedAt > at) continue
    // A call that had not answered by `at` was still running then.
    const ended = a.endedAt !== undefined && a.endedAt <= at
    const status = ended ? a.status : 'run'
    entries.push({
      id: `a${n++}`,
      station: a.station,
      label: a.label,
      from: a.from ?? 'core',
      startedAt: a.startedAt,
      status,
      ...(ended ? { endedAt: a.endedAt } : {}),
      ...(a.agentId !== undefined ? { agentId: a.agentId } : {}),
      ...(a.mark !== undefined ? { mark: a.mark } : {}),
      ...(a.aside === true ? { aside: true } : {}),
      ...(a.wake !== undefined ? { wake: a.wake } : {}),
    })
    counts[a.station] = (counts[a.station] ?? 0) + 1
    // Faults are counted since the person's last message, so a new message clears them.
    if (a.station === 'you' && a.from === 'inbound') faults = {}
    else if (ended && isFault(status)) faults[a.station] = (faults[a.station] ?? 0) + 1
  }

  return { entries: entries.slice(-KEEP), counts, faults, agents: agentsAt(actions, at), ...extra }
}

/** Subagents whose own calls straddle `at`: started work before it and had not finished. */
function agentsAt(actions, at) {
  if (!Number.isFinite(at)) return []
  const span = new Map()
  for (const a of actions) {
    if (a.agentId === undefined) continue
    const s = span.get(a.agentId) ?? { first: Infinity, last: -Infinity }
    s.first = Math.min(s.first, a.startedAt)
    s.last = Math.max(s.last, a.endedAt ?? a.startedAt)
    span.set(a.agentId, s)
  }
  return [...span].filter(([, s]) => s.first <= at && at <= s.last).map(([id]) => id)
}

/** Per-station totals for a whole session, with faults, for a coverage report. */
export function tally(actions) {
  const out = {}
  for (const a of actions) {
    const row = (out[a.station] ??= { calls: 0, faults: 0, fromAgents: 0 })
    row.calls++
    if (isFault(a.status)) row.faults++
    if (a.agentId !== undefined) row.fromAgents++
  }
  return out
}

/** The minute with the most actions starting in it: a frame worth looking at. */
export function busiestMoment(actions, windowMs = 60_000) {
  let best = { at: actions.at(-1)?.startedAt ?? 0, n: 0 }
  let lo = 0
  for (let hi = 0; hi < actions.length; hi++) {
    while (actions[hi].startedAt - actions[lo].startedAt > windowMs) lo++
    if (hi - lo + 1 > best.n) best = { at: actions[hi].startedAt, n: hi - lo + 1 }
  }
  return best
}
