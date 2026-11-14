// The ribbon: the last calls of a session in one row, oldest to newest, each a
// cell in its family's colour (kinds.js). It is the form of the sequence that
// survives shrinking: the hub's route keeps the last few handoffs as pairs, and
// below about 64 px wide its legs are a pixel apart; a row of cells is still a
// row of cells at 24 px.
//
// One row means colour is the only cue to the kind of work. Shape carries the
// rest, so that nothing else rests on colour:
//
//   full height, the map's white   the person spoke: a turn begins
//   full height, grey, narrow      something else woke the agent (a task, the harness)
//   full height, red               the call failed
//   three fifths                   a call of the main loop
//   a third, on the floor          beside the main loop: a subagent's call, or a
//                                  report that rode along with other work
//
// The tape (flow.js) is the same calls at full size with a lane per station,
// where place says the kind as well.

import { DARK } from './palette.js'
import { FAULT, KIND, familyOf } from './kinds.js'

/**
 * The last `n` calls up to a moment, oldest first. The model is left out, as it is from the route and the tape:
 * it sits between every two calls. `model` picks the colour model: `place` or `head`.
 */
export function ribbonOf(actions, at, n = 60, model = 'place') {
  const cells = []
  for (let i = actions.length - 1; i >= 0 && cells.length < n; i--) {
    const a = actions[i]
    if (a.startedAt > at || a.station === 'model') continue
    const ended = a.endedAt !== undefined && a.endedAt <= at
    const arrived = a.from === 'inbound' && (a.station === 'you' || a.wake !== undefined)
    cells.push({
      station: a.station,
      family: familyOf(a, model),
      kind: arrived ? (a.wake === undefined ? 'person' : 'wake') : 'call',
      fault: ended && (a.status === 'err' || a.status === 'block'),
      running: !ended,
      beside: a.agentId !== undefined || a.aside === true,
      changes: a.op === 'edit' || a.op === 'write',
    })
  }
  return cells.reverse()
}

/** A cell's width and the gap after it, in CSS pixels, for a ribbon of a given height. */
export function ribbonCell(height) {
  const w = Math.max(3, Math.min(10, Math.round(height * 0.4)))
  return { w, gap: w >= 5 ? 2 : 1 }
}

/** How many calls a ribbon of this size holds. */
export function ribbonCapacity(width, height) {
  const { w, gap } = ribbonCell(height)
  return Math.max(1, Math.floor((width + gap) / (w + gap)))
}

/**
 * The ribbon as one SVG string, drawn at CSS pixels: `width` by `height`. The newest call is at the right
 * edge and a short ribbon fills from the right, so "now" never moves.
 */
export function drawRibbon(cells, { width = 320, height = 20, palette = DARK } = {}) {
  const p = palette
  const { w, gap } = ribbonCell(height)
  const shown = cells.slice(-ribbonCapacity(width, height))
  const out = [`<rect width="${width}" height="${height}" fill="${p.ground}"/>`]
  const callH = Math.max(3, Math.round(height * 0.6))
  const besideH = Math.max(2, Math.round(height * 0.3))
  const floor = height - Math.round((height - callH) / 2)
  shown.forEach((c, k) => {
    const x = width - (shown.length - k) * (w + gap) + gap
    if (c.kind === 'person') return out.push(`<rect x="${x}" y="0" width="${w}" height="${height}" fill="${KIND.you}"/>`)
    if (c.kind === 'wake') {
      const narrow = Math.max(1, Math.round(w / 2))
      return out.push(`<rect x="${x + Math.floor((w - narrow) / 2)}" y="0" width="${narrow}" height="${height}" fill="${KIND.own}"/>`)
    }
    if (c.fault) return out.push(`<rect x="${x}" y="0" width="${w}" height="${height}" fill="${FAULT}"/>`)
    const h = c.beside ? besideH : callH
    const colour = KIND[c.family]
    // A call still running is an outline, where a cell is wide enough to have an inside.
    if (c.running && w >= 5) return out.push(`<rect x="${x + 0.75}" y="${floor - h + 0.75}" width="${w - 1.5}" height="${h - 1.5}" fill="none" stroke="${colour}" stroke-width="1.5"/>`)
    return out.push(`<rect x="${x}" y="${floor - h}" width="${w}" height="${h}" fill="${colour}"/>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${out.join('')}</svg>`
}

/**
 * Of the handoffs in a run of cells, how many show as a change of colour. A handoff is a change of station,
 * or at Files a change between reading and changing a file. One between two kinds of one family is
 * invisible in a one-row ribbon; this counts how much of the sequence each colour model costs.
 */
export function coloursShown(cells) {
  const fine = c => (c.station === 'files' ? `files:${c.changes ? 'change' : 'read'}` : c.station)
  let handoffs = 0
  let seen = 0
  const calls = cells.filter(c => c.kind === 'call' && !c.beside)
  for (let i = 1; i < calls.length; i++) {
    if (fine(calls[i]) === fine(calls[i - 1])) continue
    handoffs++
    if (calls[i].family !== calls[i - 1].family) seen++
  }
  return { handoffs, seen }
}
