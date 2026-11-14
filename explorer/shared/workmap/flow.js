// The work of a session as stations that light and transitions that leave a trace,
// drawn small. Two layouts share it: the hub's ring, and a circuit board.
//
// The full-size hub (draw.js, lot-map's drawing) already shows the thing worth
// keeping: the route. It draws the last few stations the work went through as
// arcs, so a sequence and a handoff are on screen after they happen. What it
// lacks is a smaller form. Shrunk as a picture it turns into a faint ring.
//
// This module gives both layouts three levels of detail on fixed positions:
//
//   3  names and counts            (the hub uses draw.js here; the board draws its own)
//   2  stations, traces, the route
//   1  lit pads and the newest legs of the route
//
// The route is never dropped. At a glyph's size it is the last thing left.
//
// A station's light is a leaky sum of its recent calls, exp(-age / tau): one
// call is a flash, a burst is a glow. tau, the hold and the fade are display
// choices, given in session time so a replay at 60x looks like live.

import { boardAt } from './board.js'
import { legBetween, mapGeometry, routeOf } from './draw.js'
import { DARK } from './palette.js'
import { STATIONS } from './setup.js'
import { mix } from './tint.js'

const W = 460
const H = 430
/** Legs of the route kept on screen. lot-map keeps seven stops, so six legs. */
const STOPS = 7

/** Names are 16 px on screen. Under 400 px wide they would outgrow their boxes to stay that size, so they go. */
const LABEL_PX = 16
const NAMES_FROM = 400

export function flowLevel(size) {
  if (size >= NAMES_FROM) return 3
  if (size >= 96) return 2
  return 1
}

/** How long a leg of the route stays, in session time. Live, as on the hub: 40 s then a 20 s fade. A replay: 8 s on screen. */
export const holdFor = speed => (speed <= 1 ? 40_000 : 8_000 * speed)

/**
 * What the drawings need at one moment: each station's light, and the route.
 * `legs` are oldest first. `strength` runs 1 to 0 as a leg fades; `f` is how far the newest leg's
 * pulse has run, 0 to 1.
 */
export function flowState(actions, at, { tau = 4000, hold = 40_000, travel = 700 } = {}) {
  const stations = Object.fromEntries(STATIONS.map(s => [s.id, { count: 0, sum: 0, running: 0, faults: 0 }]))
  const horizon = tau * 8
  for (const a of actions) {
    if (!Number.isFinite(a.startedAt) || a.startedAt > at) continue
    const s = stations[a.station]
    if (s === undefined) continue
    s.count++
    const age = at - a.startedAt
    if (age < horizon) s.sum += Math.exp(-age / tau)
    const ended = a.endedAt !== undefined && a.endedAt <= at
    if (!ended) s.running++
    if (a.station === 'you' && a.from === 'inbound') for (const id in stations) stations[id].faults = 0
    else if (ended && (a.status === 'err' || a.status === 'block')) s.faults++
  }
  for (const s of Object.values(stations)) s.level = 1 - Math.exp(-(s.sum + (s.running > 0 ? 0.7 : 0)))

  const fade = hold / 2
  const stops = routeOf(boardAt(actions, at).entries, STOPS)
  const legs = []
  for (let k = 1; k < stops.length; k++) {
    const age = at - stops[k].at
    if (age >= hold + fade) continue
    legs.push({ from: stops[k - 1].station, to: stops[k].station, age, strength: age <= hold ? 1 : 1 - (age - hold) / fade })
  }
  const head = legs[legs.length - 1]
  if (head) head.f = Math.min(1, head.age / travel)
  return { at, stations, legs }
}

// ─── Layouts ────────────────────────────────────────────────────────────────

/** The hub's own places, so a station is where the full map has it. */
export function ringLayout(setup) {
  const g = mapGeometry(setup)
  return { kind: 'ring', width: g.width, height: g.height, core: { x: g.core.x, y: g.core.y, r: g.core.r }, stations: Object.fromEntries(g.stations.map(s => [s.id, { x: s.x, y: s.y, r: s.r }])), setup }
}

// The board. The agent is the processor in the middle. What it has sits on the board as chips:
// the model, memory, skills (stored procedures) and hooks, which are interrupts in the plain sense:
// they fire on an event and the processor does not choose them. What it touches is on the edge as
// connectors, because a board's edge is where the world plugs in: the person, files, the shell,
// the network, the browser, and other boards (subagents).
const BOX = { w: 96, h: 46 }
const BOARD = { x: 14, y: 14, w: 432, h: 402 }
const CPU = { x: 230, y: 212, w: 92, h: 60 }
const PLACES = {
  you: { x: 230, y: 40, edge: 'top' },
  hooks: { x: 82, y: 112 },
  model: { x: 378, y: 112 },
  skills: { x: 82, y: 212 },
  memory: { x: 378, y: 212 },
  agents: { x: 62, y: 326, edge: 'left' },
  files: { x: 398, y: 326, edge: 'right' },
  browser: { x: 130, y: 390, edge: 'bottom' },
  web: { x: 230, y: 390, edge: 'bottom' },
  shell: { x: 330, y: 390, edge: 'bottom' },
}

export function boardLayout() {
  return { kind: 'board', width: W, height: H, core: { ...CPU }, stations: Object.fromEntries(Object.entries(PLACES).map(([id, p]) => [id, { ...p, ...BOX }])) }
}

/**
 * Where a control lies over each drawn station of a layout, as CSS percentages, like the hub's.
 * A board's target is its component; a ring's takes in the node and the name under it.
 */
export function flowBoxes(layout, present) {
  const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`
  return Object.entries(layout.stations)
    .filter(([id]) => present.has(id))
    .map(([id, s]) => {
      const [w, h] = layout.kind === 'board' ? [s.w, s.h] : [84, s.r * 2 + 44]
      const top = layout.kind === 'board' ? s.y - h / 2 : s.y - s.r - 6
      return { id, left: pct(s.x - w / 2, layout.width), top: pct(top, layout.height), width: pct(w, layout.width), height: pct(h, layout.height) }
    })
}

export function flowCoreBox(layout) {
  const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`
  const { core } = layout
  const [w, h] = layout.kind === 'board' ? [core.w + 8, core.h + 8] : [core.r * 2 + 12, core.r * 2 + 12]
  return { left: pct(core.x - w / 2, layout.width), top: pct(core.y - h / 2, layout.height), width: pct(w, layout.width), height: pct(h, layout.height) }
}

// ─── Routing on the board ───────────────────────────────────────────────────
//
// A transition runs on its own trace: out of one component, onto a lane of the bus that rings the
// processor, round the shorter way, and off to the other. Each leg of the route takes its own lane,
// so six legs are six parallel traces and no two share copper. The newest takes the inside lane.

// The bus hugs the processor: its outermost lane stays clear of every chip, so a lane is never read as a chip's own trace.
const LANE0 = 11
const LANE_STEP = 6

const n1 = v => Math.round(v * 10) / 10

function laneBox(lane) {
  const hx = CPU.w / 2 + LANE0 + lane * LANE_STEP
  const hy = CPU.h / 2 + LANE0 + lane * LANE_STEP
  return { x0: CPU.x - hx, x1: CPU.x + hx, y0: CPU.y - hy, y1: CPU.y + hy }
}

/** The stub from a component to its lane: straight when it faces a side of the bus, one bend when it sits off a corner. */
function stub(place, box, lane) {
  // Parallel stubs from one component sit side by side, like the lanes they join.
  const off = (lane - 2.5) * 3
  const inX = place.x >= box.x0 && place.x <= box.x1
  const inY = place.y >= box.y0 && place.y <= box.y1
  if (inX) {
    const x = Math.max(box.x0, Math.min(box.x1, place.x + off))
    return [[x, place.y], [x, place.y < box.y0 ? box.y0 : box.y1]]
  }
  if (inY) {
    const y = Math.max(box.y0, Math.min(box.y1, place.y + off))
    return [[place.x, y], [place.x < box.x0 ? box.x0 : box.x1, y]]
  }
  const qx = place.x < box.x0 ? box.x0 : box.x1
  const qy = place.y < box.y0 ? box.y0 : box.y1
  // Off a corner: along first, then in, joining the bus at its corner.
  return [[place.x, place.y + off], [qx, place.y + off], [qx, qy]]
}

/** A point on the bus as a distance clockwise from its top-left corner. */
function along(box, [x, y]) {
  const w = box.x1 - box.x0
  const h = box.y1 - box.y0
  if (y === box.y0) return x - box.x0
  if (x === box.x1) return w + (y - box.y0)
  if (y === box.y1) return w + h + (box.x1 - x)
  return 2 * w + h + (box.y1 - y)
}

function busWalk(box, a, b) {
  const w = box.x1 - box.x0
  const h = box.y1 - box.y0
  const total = 2 * (w + h)
  const corners = [[0, [box.x0, box.y0]], [w, [box.x1, box.y0]], [w + h, [box.x1, box.y1]], [2 * w + h, [box.x0, box.y1]]]
  const [sa, sb] = [along(box, a), along(box, b)]
  const cw = (((sb - sa) % total) + total) % total
  const clockwise = cw <= total - cw
  const span = clockwise ? cw : total - cw
  const passed = corners
    .map(([s, p]) => [clockwise ? (((s - sa) % total) + total) % total : (((sa - s) % total) + total) % total, p])
    .filter(([d]) => d > 0 && d < span)
    .sort((x, y) => x[0] - y[0])
  return passed.map(([, p]) => p)
}

/** The points of one leg on the board, from the first component to the second. */
export function boardRoute(layout, fromId, toId, lane) {
  const box = laneBox(lane)
  const out = stub(layout.stations[fromId], box, lane)
  const back = stub(layout.stations[toId], box, lane)
  return [...out, ...busWalk(box, out[out.length - 1], back[back.length - 1]), ...back.reverse()]
}

const polyline = points => points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${n1(x)} ${n1(y)}`).join('')

/** The point a fraction `f` of the way along a run of straight segments. */
function pointOn(points, f) {
  const lengths = points.slice(1).map(([x, y], i) => Math.hypot(x - points[i][0], y - points[i][1]))
  let left = lengths.reduce((a, b) => a + b, 0) * Math.max(0, Math.min(1, f))
  for (let i = 0; i < lengths.length; i++) {
    if (left <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] === 0 ? 0 : left / lengths[i]
      return [points[i][0] + (points[i + 1][0] - points[i][0]) * t, points[i][1] + (points[i + 1][1] - points[i][1]) * t]
    }
    left -= lengths[i]
  }
  return points[points.length - 1]
}

/** One leg as a path, its far end, and a point along it, in either layout. */
function legGeometry(layout, leg, lane) {
  if (layout.kind === 'board') {
    const points = boardRoute(layout, leg.from, leg.to, lane)
    return { d: polyline(points), end: points[points.length - 1], at: f => pointOn(points, f) }
  }
  const { path, end } = legBetween(layout.setup, leg.from, leg.to)
  // "M ax ay Q bx by ex ey": the hub's own curve, read back for the pulse.
  const [ax, ay, bx, by, ex, ey] = path.match(/-?[\d.]+/g).map(Number)
  const at = f => {
    const u = 1 - f
    return [u * u * ax + 2 * u * f * bx + f * f * ex, u * u * ay + 2 * u * f * by + f * f * ey]
  }
  return { d: path, end: [end.x, end.y], at }
}

// ─── Drawing ────────────────────────────────────────────────────────────────

const FONT = "font-family=\"ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif\""
const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/** The trace from a component to the processor: the board's spoke. */
function coreTrace(place) {
  const x = Math.max(CPU.x - CPU.w / 2, Math.min(CPU.x + CPU.w / 2, place.x))
  const y = Math.max(CPU.y - CPU.h / 2, Math.min(CPU.y + CPU.h / 2, place.y))
  if (x === place.x || y === place.y) return [[place.x, place.y], [x, y]]
  return [[place.x, place.y], [x, place.y], [x, y]]
}

/**
 * The flow as one SVG string. `size` is the width it is shown at in CSS pixels.
 * `present` are the stations the session used at all: the others keep their places and get no ink.
 */
export function drawFlow(state, { layout, size = W, palette = DARK, names = {}, coreName = '', model = '', present, motion = 'full' } = {}) {
  const p = palette
  const level = flowLevel(size)
  const unit = layout.width / size
  const px = v => n1(v * unit)
  const isBoard = layout.kind === 'board'
  const out = []
  const used = id => (present ? present.has(id) : state.stations[id].count > 0)

  const lit = id => {
    const s = state.stations[id]
    // Memory keeps its own colour, as on the hub; everything else lights in the hub's amber.
    const hue = id === 'memory' ? p.memHot : p.hot
    return { level: s.level, hue, fault: s.faults > 0, running: s.running > 0 }
  }
  const fillOf = l => (l.level > 0.02 ? mix(p.raised, l.hue, 0.16 + 0.84 * l.level) : p.raised)
  const edgeOf = l => (l.fault ? p.red : l.level > 0.02 ? mix(p.line, l.hue, 0.4 + 0.6 * l.level) : p.line)

  out.push(`<rect width="${layout.width}" height="${layout.height}" fill="${p.ground}"/>`)

  if (isBoard) {
    out.push(`<rect x="${BOARD.x}" y="${BOARD.y}" width="${BOARD.w}" height="${BOARD.h}" rx="10" fill="${mix(p.ground, p.raised, 0.45)}" stroke="${p.line}" stroke-width="${px(level === 1 ? 2.2 : 1.4)}"/>`)
  }

  // Standing connections: spokes on the ring, copper on the board. They say what can talk to the
  // processor; the route says what did.
  if (level >= 2) {
    for (const [id, place] of Object.entries(layout.stations)) {
      if (!used(id)) continue
      const l = lit(id)
      // On the ring a spoke lights with its station, as on the full hub. On the board the copper stays dim:
      // the component already shows its own light, and lit copper under the route would bury it.
      const colour = !isBoard && l.level > 0.05 ? mix(p.spoke, l.hue, 0.7 * l.level) : isBoard ? mix(p.spoke, p.line, 0.5) : p.spoke
      const d = isBoard ? polyline(coreTrace(place)) : `M${n1(place.x)} ${n1(place.y)}L${layout.core.x} ${layout.core.y}`
      out.push(`<path d="${d}" fill="none" stroke="${colour}" stroke-width="${px(1.4)}" stroke-linejoin="round"/>`)
    }
  }

  // The route: every leg on its own lane, the newest brightest and inmost.
  const legs = level === 1 ? state.legs.slice(-3) : state.legs
  legs.forEach((leg, i) => {
    if (!used(leg.from) || !used(leg.to)) return
    const isHead = i === legs.length - 1
    const lane = legs.length - 1 - i
    const rank = legs.length === 1 ? 1 : i / (legs.length - 1)
    const g = legGeometry(layout, leg, lane)
    const colour = mix(p.ground, p.trail, (0.3 + 0.7 * rank) * leg.strength)
    const width = level === 1 ? (isHead ? 2.4 : 1.6) : isHead ? 2.2 : 1.3
    out.push(`<path d="${g.d}" fill="none" stroke="${colour}" stroke-width="${px(width)}" stroke-linecap="round" stroke-linejoin="round"/>`)
    if (isHead) {
      // Where the route arrived, and the pulse still on its way there.
      out.push(`<circle cx="${n1(g.end[0])}" cy="${n1(g.end[1])}" r="${px(level === 1 ? 2.6 : 3)}" fill="${mix(p.ground, p.trail, leg.strength)}"/>`)
      if (motion === 'full' && leg.f !== undefined && leg.f < 1 && level >= 2) {
        const [x, y] = g.at(leg.f)
        out.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="${px(3.6)}" fill="${p.hot}" stroke="${p.ground}" stroke-width="${px(1)}"/>`)
      }
    }
  })

  // The processor.
  const coreLevel = Math.max(...Object.values(state.stations).map(s => s.level), 0)
  const coreEdge = mix(p.line, p.bone, 0.3 + 0.5 * coreLevel)
  if (isBoard) {
    const c = layout.core
    out.push(`<rect x="${c.x - c.w / 2}" y="${c.y - c.h / 2}" width="${c.w}" height="${c.h}" rx="6" fill="${p.raised}" stroke="${coreEdge}" stroke-width="${px(level === 1 ? 2.4 : 1.6)}"/>`)
    if (level === 3) {
      const font = n1(Math.max(LABEL_PX, LABEL_PX * unit))
      out.push(`<text x="${c.x}" y="${c.y - 4}" text-anchor="middle" ${FONT} font-size="${font}" font-weight="700" letter-spacing="1" fill="${p.bone}">${esc(coreName)}</text>`)
      if (model) out.push(`<text x="${c.x}" y="${n1(c.y - 4 + font * 1.25)}" text-anchor="middle" ${FONT} font-size="${font}" font-weight="500" fill="${p.ash}">${esc(model)}</text>`)
    }
  } else {
    const r = level === 1 ? layout.core.r * 0.5 : layout.core.r * 0.72
    out.push(`<circle cx="${layout.core.x}" cy="${layout.core.y}" r="${n1(r)}" fill="${p.raised}" stroke="${coreEdge}" stroke-width="${px(level === 1 ? 2.4 : 1.6)}"/>`)
  }

  // The stations.
  for (const s of STATIONS) {
    const id = s.id
    if (!used(id)) continue
    const place = layout.stations[id]
    const l = lit(id)
    if (level === 1 && l.level < 0.06 && !l.fault) {
      // At a glyph's size an idle station is a pad: its place, and no more ink than that.
      const r = Math.max(isBoard ? 9 : 8, px(1.2))
      out.push(isBoard ? `<rect x="${n1(place.x - r * 1.6)}" y="${n1(place.y - r)}" width="${n1(r * 3.2)}" height="${n1(r * 2)}" rx="3" fill="${p.line}"/>` : `<circle cx="${n1(place.x)}" cy="${n1(place.y)}" r="${n1(r)}" fill="${p.line}"/>`)
      continue
    }
    const stroke = px(level === 1 ? 2.2 : 1.6)
    if (isBoard) {
      const [w, h] = level === 1 ? [place.w * 0.78, place.h * 0.86] : [place.w, place.h]
      out.push(`<rect x="${n1(place.x - w / 2)}" y="${n1(place.y - h / 2)}" width="${n1(w)}" height="${n1(h)}" rx="5" fill="${fillOf(l)}" stroke="${edgeOf(l)}" stroke-width="${level === 3 ? px(2.6) : stroke}"/>`)
      // A connector shows its outward side: the edge of the board is where the world plugs in.
      if (place.edge && level >= 2) {
        const bar = { top: [place.x - w / 2 + 8, place.y - h / 2, w - 16, 5], bottom: [place.x - w / 2 + 8, place.y + h / 2 - 5, w - 16, 5], left: [place.x - w / 2, place.y - h / 2 + 8, 5, h - 16], right: [place.x + w / 2 - 5, place.y - h / 2 + 8, 5, h - 16] }[place.edge]
        out.push(`<rect x="${n1(bar[0])}" y="${n1(bar[1])}" width="${bar[2]}" height="${bar[3]}" fill="${edgeOf(l)}"/>`)
      }
    } else {
      const r = level === 1 ? Math.max(place.r * 0.78, px(2.4)) : place.r
      out.push(`<circle cx="${n1(place.x)}" cy="${n1(place.y)}" r="${n1(r)}" fill="${fillOf(l)}" stroke="${edgeOf(l)}" stroke-width="${stroke}"/>`)
    }
    if (l.fault) {
      const [dx, dy] = isBoard ? [place.w / 2 - 6, -place.h / 2 + 6] : [place.r * 0.7, -place.r * 0.7]
      out.push(`<circle cx="${n1(place.x + dx)}" cy="${n1(place.y + dy)}" r="${n1(Math.max(7, px(3.2)))}" fill="${p.red}" stroke="${p.ground}" stroke-width="${px(1.2)}"/>`)
    }
    if (level === 3 && isBoard) {
      const font = n1(Math.max(LABEL_PX, LABEL_PX * unit))
      // A name never sits on a mid-tone, where no ink holds 8:1. The component's edge carries the continuous
      // light; the panel under the name is one of three grounds: unlit, faintly tinted, or fully lit with dark ink.
      const bright = l.level > 0.55
      const ink = bright ? p.ground : p.bone
      const sub = bright ? p.ground : l.level > 0.02 ? p.bone : p.ash
      const ground = bright ? mix(p.raised, l.hue, 0.92) : l.level > 0.02 ? mix(p.raised, l.hue, 0.1) : p.raised
      out.push(`<rect x="${n1(place.x - place.w / 2 + 1.5)}" y="${n1(place.y - place.h / 2 + 1.5)}" width="${place.w - 3}" height="${place.h - 3}" rx="4" fill="${ground}"/>`)
      out.push(`<text x="${place.x}" y="${n1(place.y - 2)}" text-anchor="middle" ${FONT} font-size="${font}" font-weight="600" fill="${ink}">${esc(names[id] ?? id)}</text>`)
      out.push(`<text x="${place.x}" y="${n1(place.y - 2 + font * 1.15)}" text-anchor="middle" ${FONT} font-size="${font}" font-weight="500" fill="${sub}">${state.stations[id].count}</text>`)
    } else if (level === 2 && unit <= 2.3) {
      // Room for the hub's own glyph, so a station is recognised without its name.
      const tone = l.level > 0.55 ? p.ground : l.level > 0.05 ? p.bone : p.ash
      out.push(`<path d="${s.icon}" transform="translate(${n1(place.x)} ${n1(place.y)})" fill="none" stroke="${tone}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}">${out.join('')}</svg>`
}

// ─── The tape ───────────────────────────────────────────────────────────────
//
// The route shows the last few handoffs as pairs. The tape shows order exactly: the last calls
// left to right, each in its station's lane, joined by a line. A loop between two stations is a
// sawtooth between two lanes. A subagent's calls are hollow and joined by their own dashed line.

const TAPE_LANE = 24
const TAPE_GUTTER = 92

/** The last `n` calls up to a moment, oldest first. The model is left out, as it is from the route: it sits between every two calls. */
export function tapeOf(actions, at, n = 60) {
  const rows = []
  for (let i = actions.length - 1; i >= 0 && rows.length < n; i--) {
    const a = actions[i]
    if (a.startedAt > at || a.station === 'model') continue
    const ended = a.endedAt !== undefined && a.endedAt <= at
    rows.push({ station: a.station, agentId: a.agentId, status: ended ? a.status : 'run', startedAt: a.startedAt })
  }
  return rows.reverse()
}

/** The lanes a tape draws, in the hub's order: the ones named, or else the stations its rows touch. */
const tapeLanes = (rows, lanes) => STATIONS.map(s => s.id).filter(id => (lanes ? lanes.includes(id) : rows.some(r => r.station === id)))

export function tapeHeight(rows, lanes) {
  return Math.max(1, tapeLanes(rows, lanes).length) * TAPE_LANE + 10
}

/**
 * `lanes` fixes which stations get a lane. Give it the session's stations and the tape keeps its
 * height while it plays; leave it out and only the lanes in view are drawn.
 */
export function drawTape(rows, { width = W, palette = DARK, names = {}, capacity = 60, lanes: fixed } = {}) {
  const p = palette
  const lanes = tapeLanes(rows, fixed)
  const height = tapeHeight(rows, fixed)
  const out = [`<rect width="${width}" height="${height}" fill="${p.ground}"/>`]
  const yOf = id => 5 + lanes.indexOf(id) * TAPE_LANE + TAPE_LANE / 2
  // Newest at the right edge, one step per call. A short tape fills from the right, so "now" never moves.
  const step = (width - TAPE_GUTTER - 10) / Math.max(1, capacity - 1)
  const xOf = i => width - 8 - (rows.length - 1 - i) * step

  for (const id of lanes) {
    out.push(`<line x1="${TAPE_GUTTER}" y1="${yOf(id)}" x2="${width - 4}" y2="${yOf(id)}" stroke="${p.spoke}" stroke-width="1"/>`)
    out.push(`<text x="${TAPE_GUTTER - 10}" y="${yOf(id) + 5.5}" text-anchor="end" ${FONT} font-size="16" font-weight="500" fill="${p.ash}">${esc(names[id] ?? id)}</text>`)
  }

  const main = rows.map((r, i) => [r, i]).filter(([r]) => r.agentId === undefined)
  if (main.length > 1) out.push(`<path d="${polyline(main.map(([r, i]) => [xOf(i), yOf(r.station)]))}" fill="none" stroke="${mix(p.ground, p.trail, 0.55)}" stroke-width="1.3" stroke-linejoin="round"/>`)
  const agents = new Map()
  rows.forEach((r, i) => {
    if (r.agentId === undefined) return
    if (!agents.has(r.agentId)) agents.set(r.agentId, [])
    agents.get(r.agentId).push([xOf(i), yOf(r.station)])
  })
  for (const points of agents.values()) {
    if (points.length > 1) out.push(`<path d="${polyline(points)}" fill="none" stroke="${mix(p.ground, p.hot, 0.6)}" stroke-width="1.2" stroke-dasharray="3 3" stroke-linejoin="round"/>`)
  }

  rows.forEach((r, i) => {
    const colour = r.status === 'err' || r.status === 'block' ? p.red : r.station === 'memory' ? p.memHot : p.hot
    const [x, y] = [n1(xOf(i)), yOf(r.station)]
    if (r.agentId !== undefined || r.status === 'run') out.push(`<circle cx="${x}" cy="${y}" r="3.4" fill="${p.ground}" stroke="${colour}" stroke-width="1.6"/>`)
    else out.push(`<circle cx="${x}" cy="${y}" r="3.2" fill="${colour}"/>`)
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">${out.join('')}</svg>`
}
