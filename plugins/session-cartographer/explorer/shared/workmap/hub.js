// The hub as one drawing from a full page down to a glyph. A candidate beside
// draw.js (lot-map's hub) and flow.js (its small forms), on the same actions.
//
// Four things differ from the hub it is compared with:
//
//   The route leads. It is the widest and brightest mark, each leg ends in an
//   arrowhead, and a leg keeps to the right of its direction of travel, so out
//   and back are two curves that close into a loop. On lot-map's hub they are
//   one curve drawn twice: of 260 frames of one session's route, 234 held a
//   pair in both directions. A leg made again is drawn once, with its count.
//
//   A stretch of the route starts with who woke the agent. A message from the
//   person is an arrow from You into the core, then an arrow from the core to
//   the first station. A background task reporting back, or the harness, enters
//   from Hooks, dashed. The person is never a stop on the way.
//
//   A station has the colour of its family (kinds.js) whether lit or not, so
//   the hub is the key to the ribbon drawn under it. Its light is brightness.
//
//   The context ring is a faint arc until the window is 70% full. Then it is
//   the map's grey with "NN% full" in the core, and its white from 90%. It is
//   never as wide as the newest leg, and never red: red means a call failed.
//
// The person's side is the top of the ring: You, and Your screen (what the
// person has open: their own Chrome, their tabs, their terminal). Those are
// squares; everything the agent uses is a circle. You is two-way: its spoke
// has a lane in (the person spoke) and a lane out (the agent told the person),
// so what the agent tells is not a station and not a stop on the route.

import { boardAt } from './board.js'
import { DARK } from './palette.js'
import { FAULT, KIND, familyOfStation } from './kinds.js'
import { STATIONS } from './setup.js'
import { mix } from './tint.js'

const W = 460
const H = 474
const CX = 230
const CY = 236
const RX = 176
const RY = 164
const NODE = 22
/** Wide enough for a model's name at 16 px on a map 400 px across. lot-map's core is 40. */
const CORE = 48
/** Where spokes and the route's first and last arrows meet the core: outside the context ring. */
const RIM = CORE + 10

/** The ring's places, clockwise from the top. `screen` closes the ring, so the person's side is one arc. */
export const HUB_ORDER = ['you', 'tells', 'model', 'memory', 'files', 'shell', 'web', 'browser', 'agents', 'skills', 'hooks', 'screen']
/**
 * The same ring with no place for what the agent tells the person. Every leg has a direction here, so one
 * station is enough: an arrow from You into the core is the person speaking, and an arrow from the core to
 * You is the agent telling. The two keep to their own sides of one spoke, like any out and back.
 */
export const HUB_ORDER_TWO_WAY = HUB_ORDER.filter(id => id !== 'tells')
const PERSON_SIDE = new Set(['you', 'tells', 'screen'])
const ICONS = { ...Object.fromEntries(STATIONS.map(s => [s.id, s.icon])), screen: 'M-8.5 -7h17v11h-17zM-4 8h8M0 4v4' }

/** Names are 16 px on screen. Under 400 px wide they would have to shrink, so they go. */
const LABEL_PX = 16
const NAMES_FROM = 400
// Under that, from this width up, a station has its running count and no name: one or two figures at 16 px fit beside a
// node where a name does not. Narrower still and three digits run into the next station.
const FIGURES_FROM = 280

export function hubLevel(size) {
  if (size >= NAMES_FROM) return 3
  if (size >= 96) return 2
  return 1
}

const angleOf = (i, n) => (i * 2 * Math.PI) / n
const onRing = (a, f = 1) => ({ x: CX + RX * f * Math.sin(a), y: CY - RY * f * Math.cos(a) })

/**
 * `tells` is `lane` (what the agent tells the person is the outward lane of You's own spoke: the reading the
 * owner chose on 2026-11-13) or `station` (it has a place of its own beside You, as on lot-map's hub and on
 * the first candidate; kept so the two can be drawn side by side).
 */
export function hubLayout({ tells = 'lane' } = {}) {
  const order = tells === 'lane' ? HUB_ORDER_TWO_WAY : HUB_ORDER
  return {
    kind: 'hub',
    width: W,
    height: H,
    tells,
    order,
    core: { x: CX, y: CY, r: CORE },
    stations: Object.fromEntries(order.map((id, i) => [id, { ...onRing(angleOf(i, order.length)), r: NODE, i }])),
  }
}

/**
 * Where a control lies over each drawn station, as CSS percentages of the map, so it scales with the picture.
 * The box takes in the node and the two lines of its name, which stand above a station in the top of the ring
 * and below any other: all three read as one target, and it is never under 40 px across from 420 px of map up.
 */
export function hubBoxes(layout, present) {
  const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`
  const twoWay = layout.tells === 'lane'
  // Narrower than the widest name and as tall as two lines of it: wide enough to press, clear of the next station.
  const NAMES = 34
  const WIDE = 72
  return layout.order
    .filter(id => present.has(id) || (twoWay && id === 'you' && present.has('tells')))
    .map(id => {
      const s = layout.stations[id]
      const above = s.y < layout.core.y - 20
      const top = above ? s.y - s.r - 6 - NAMES : s.y - s.r - 6
      return { id, left: pct(s.x - WIDE / 2, layout.width), top: pct(Math.max(0, top), layout.height), width: pct(WIDE, layout.width), height: pct(s.r * 2 + 12 + NAMES, layout.height) }
    })
}

export function hubCoreBox(layout) {
  const pct = (v, of) => `${((v / of) * 100).toFixed(3)}%`
  const r = layout.core.r + 8
  return { left: pct(layout.core.x - r, layout.width), top: pct(layout.core.y - r, layout.height), width: pct(r * 2, layout.width), height: pct(r * 2, layout.height) }
}

// ─── State ──────────────────────────────────────────────────────────────────

/**
 * The moves of the main loop, oldest first: who woke it, where it went first, and each change of station after.
 * The model is left out, as it sits between every two calls, and so is a report that rode beside other work.
 * `made` is when a move was first made; `at` moves on while work goes on at the station it led to.
 */
export function movesOf(entries, { tells = 'lane' } = {}) {
  const moves = []
  let last
  let fresh = false
  for (const e of entries) {
    if (e.from === 'agents' || e.agentId !== undefined || e.station === 'model' || e.aside === true) continue
    if (tells === 'lane' && e.station === 'tells') {
      // The agent tells the person: out along You's spoke. It is not a place the work went, so the station the
      // work was at is still where the next leg starts, and a stretch still waits for its first call.
      const before = moves[moves.length - 1]
      if (before !== undefined && before.kind === 'tell') before.at = e.startedAt
      else moves.push({ from: 'core', to: 'you', at: e.startedAt, made: e.startedAt, kind: 'tell' })
      continue
    }
    if (e.from === 'inbound' && (e.station === 'you' || e.wake !== undefined)) {
      moves.push({ from: e.wake === undefined ? 'you' : 'hooks', to: 'core', at: e.startedAt, made: e.startedAt, kind: 'wake', by: e.wake ?? 'person' })
      fresh = true
      continue
    }
    if (fresh) moves.push({ from: 'core', to: e.station, at: e.startedAt, made: e.startedAt, kind: 'start' })
    else if (last !== undefined && last !== e.station) moves.push({ from: last, to: e.station, at: e.startedAt, made: e.startedAt, kind: 'leg' })
    // More work at the same station keeps the leg that led there fresh.
    else if (moves.length > 0 && moves[moves.length - 1].to === e.station) moves[moves.length - 1].at = e.startedAt
    fresh = false
    last = e.station
  }
  return moves
}

/**
 * What the hub draws at one moment: each station's light, and the route as legs, oldest first.
 * A leg made more than once inside the window is one leg with `n`. `strength` runs 1 to 0 as it fades;
 * `f` is how far the newest leg's pulse has run. Times are session time: a replay passes them longer.
 * `totals` are counts per station kept elsewhere, for a view that holds only the newest of a session's calls.
 */
export function hubState(actions, at, { tau = 4000, hold = 40_000, travel = 700, keep = 7, context, tells = 'lane', totals } = {}) {
  const stations = Object.fromEntries((tells === 'lane' ? HUB_ORDER_TWO_WAY : HUB_ORDER).map(id => [id, { count: 0, sum: 0, running: 0, faults: 0 }]))
  if (tells === 'lane') stations.you.told = 0
  const horizon = tau * 8
  let model
  for (const a of actions) {
    if (!Number.isFinite(a.startedAt) || a.startedAt > at) continue
    // The model the main loop last ran on: a recorded step is labelled with its short name.
    if (a.station === 'model' && a.agentId === undefined && typeof a.label === 'string' && a.label !== '') model = a.label
    // Two-way: what the agent told the person lights You and is counted there, apart from what the person said.
    const told = tells === 'lane' && a.station === 'tells'
    const s = stations[told ? 'you' : a.station]
    if (s === undefined) continue
    if (told) s.told++
    else s.count++
    const age = at - a.startedAt
    if (age < horizon) s.sum += Math.exp(-age / tau)
    const ended = a.endedAt !== undefined && a.endedAt <= at
    if (!ended) s.running++
    if (a.station === 'you' && a.from === 'inbound') for (const id in stations) stations[id].faults = 0
    else if (ended && (a.status === 'err' || a.status === 'block')) s.faults++
  }
  for (const s of Object.values(stations)) s.level = 1 - Math.exp(-(s.sum + (s.running > 0 ? 0.7 : 0)))
  // A live view keeps the last calls and a running count per station: the counts drawn are those, not a count of
  // the calls it still holds. `tells` among them is what the agent told, drawn under You when You is two-way.
  if (totals) {
    for (const [id, n] of Object.entries(totals)) {
      if (tells === 'lane' && id === 'tells') stations.you.told = n
      else if (stations[id] !== undefined) stations[id].count = n
    }
  }

  const fade = hold / 2
  const recent = movesOf(boardAt(actions, at).entries, { tells }).slice(-keep).filter(m => at - m.at < hold + fade)
  const byPair = new Map()
  for (const m of recent) {
    const key = `${m.from}>${m.to}`
    const seen = byPair.get(key)
    // Kept in the order of its newest making: delete, then set again.
    if (seen) byPair.delete(key)
    byPair.set(key, { ...m, n: (seen?.n ?? 0) + 1 })
  }
  const legs = [...byPair.values()].map(m => {
    const age = at - m.at
    return { from: m.from, to: m.to, kind: m.kind, by: m.by, n: m.n, age, strength: age <= hold ? 1 : 1 - (age - hold) / fade }
  })
  const head = legs[legs.length - 1]
  if (head) head.f = Math.min(1, head.age / travel)
  return { at, stations, legs, made: recent.length, ...(Number.isFinite(context) ? { context } : {}), ...(model !== undefined ? { model } : {}) }
}

// ─── Geometry ───────────────────────────────────────────────────────────────

/** How far from the core a leg bends, by how many places apart its ends are: clear of the core, clear of the ring. */
const BEND = [0.5, 0.5, 0.42, 0.45, 0.55, 0.72, 0.9]
/** How far a leg stands to the right of the straight way, so out and back never share a curve. */
const KEEP_RIGHT = 20
const SPOKE_LANE = 6

const n1 = v => Math.round(v * 10) / 10
const toward = (from, to, r) => {
  const d = Math.hypot(to.x - from.x, to.y - from.y) || 1
  return { x: from.x + ((to.x - from.x) * r) / d, y: from.y + ((to.y - from.y) * r) / d }
}
/** To the right of travel, with y running down the screen. */
const rightOf = (a, b) => {
  const d = Math.hypot(b.x - a.x, b.y - a.y) || 1
  return { x: -(b.y - a.y) / d, y: (b.x - a.x) / d }
}

/**
 * One leg of the route: where it starts, the point it bends round, and where its arrow lands.
 * A leg to or from the core runs beside the station's spoke; any other curves through the room inside the ring.
 */
export function hubLeg(layout, leg) {
  const core = layout.core
  if (leg.from === 'core' || leg.to === 'core') {
    const station = layout.stations[leg.from === 'core' ? leg.to : leg.from]
    const [a, b] = leg.from === 'core' ? [toward(core, station, RIM), toward(station, core, station.r + 3)] : [toward(station, core, station.r + 3), toward(core, station, RIM)]
    const side = rightOf(a, b)
    const p0 = { x: a.x + side.x * SPOKE_LANE, y: a.y + side.y * SPOKE_LANE }
    const p2 = { x: b.x + side.x * SPOKE_LANE, y: b.y + side.y * SPOKE_LANE }
    return { p0, p1: { x: (p0.x + p2.x) / 2, y: (p0.y + p2.y) / 2 }, p2 }
  }
  const from = layout.stations[leg.from]
  const to = layout.stations[leg.to]
  const n = layout.order.length
  let steps = (((to.i - from.i) % n) + n) % n
  if (steps > n / 2) steps -= n
  const through = onRing(angleOf(from.i + steps / 2, n), BEND[Math.round(Math.abs(steps))] ?? 0.5)
  const side = rightOf(from, to)
  const p1 = { x: through.x + side.x * KEEP_RIGHT, y: through.y + side.y * KEEP_RIGHT }
  return { p0: toward(from, p1, from.r + 3), p1, p2: toward(to, p1, to.r + 3) }
}

const curveAt = ({ p0, p1, p2 }, t) => {
  const u = 1 - t
  return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x, y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y }
}

/** The leg as a stroke that stops short of its end, and the arrowhead that finishes it. */
function arrow(curve, length, half) {
  const { p0, p1, p2 } = curve
  const back = toward(p2, p1, length)
  const side = rightOf(p1, p2)
  const head = `M${n1(p2.x)} ${n1(p2.y)}L${n1(back.x + side.x * half)} ${n1(back.y + side.y * half)}L${n1(back.x - side.x * half)} ${n1(back.y - side.y * half)}Z`
  // The stroke ends inside the head, so its round cap never shows past the tip.
  const stop = toward(p2, p1, length * 0.7)
  return { d: `M${n1(p0.x)} ${n1(p0.y)}Q${n1(p1.x)} ${n1(p1.y)} ${n1(stop.x)} ${n1(stop.y)}`, head }
}

/** How wide a letter of the core's text is taken to be, as a share of its size: on the wide side, so a line that passes fits. */
const CORE_CHAR = 0.54

/** A name in two lines, broken at the space or hyphen nearest its middle; null when it has neither. */
function breakInTwo(text) {
  let best = -1
  for (let i = 1; i < text.length - 1; i++) {
    if ((text[i] === ' ' || text[i] === '-') && (best < 0 || Math.abs(i - text.length / 2) < Math.abs(best - text.length / 2))) best = i
  }
  if (best < 0) return null
  return [text.slice(0, text[best] === '-' ? best + 1 : best), text.slice(best + 1)]
}

// ─── Drawing ────────────────────────────────────────────────────────────────

const FONT = "font-family=\"ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif\""
const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

/**
 * The route's stroke at each level, in CSS pixels, in three steps a reader can tell apart: the newest leg, the two
 * before it, and the rest. Seven legs on seven widths were a quarter of a pixel apart. Spokes are 1 to 2 px.
 */
export const ROUTE_PX = { 3: [3.6, 2.6, 1.8], 2: [2.8, 2, 1.5], 1: [2.2, 1.6, 1.5] }
/** How much of the route's white each step has. */
const ROUTE_TONE = [1, 0.72, 0.42]
/** The step of a leg: 0 for the newest, 1 for the two before it, 2 for the rest. */
const stepOf = fromNewest => (fromNewest === 0 ? 0 : fromNewest <= 2 ? 1 : 2)
/** The context window's two thresholds, in percent: where the ring stops being quiet, and where it gets its heaviest stroke. */
export const CONTEXT_NEAR = 70
export const CONTEXT_FULL = 90

/**
 * The hub as one SVG string. `size` is the width it is shown at in CSS pixels.
 * `present` are the stations the session used at all: the others keep their places and get no ink.
 * `pressed` is the station a page is listing, if any. `model` is the name the core says; left out, it is the
 * model of the state's last main-loop step.
 */
export function drawHub(state, { layout = hubLayout(), size = W, palette = DARK, names = {}, coreName = '', model = state.model ?? '', present, motion = 'full', pressed = '', accent = '#72e6ef' } = {}) {
  const p = palette
  const level = hubLevel(size)
  const unit = layout.width / size
  const px = v => n1(v * unit)
  const out = []
  const twoWay = layout.tells === 'lane'
  // A place this layout does not have gets no ink, whatever the state names: a state made for the other reading of
  // Tells you draws without its legs to it instead of failing.
  const used = id => id === 'core' || (layout.stations[id] !== undefined && (present ? present.has(id) || (twoWay && id === 'you' && present.has('tells')) : (state.stations[id]?.count ?? 0) > 0))
  const hueOf = id => KIND[familyOfStation(id)]

  out.push(`<rect width="${layout.width}" height="${layout.height}" fill="${p.ground}"/>`)

  // Standing connections: what can talk to the core. Worn in with use, in the station's colour, and never above 2 px.
  if (level >= 2) {
    for (const id of layout.order) {
      if (!used(id)) continue
      const s = layout.stations[id]
      const worn = Math.min(1, Math.log2(1 + state.stations[id].count) / 7)
      const a = toward(layout.core, s, RIM)
      const b = toward(s, layout.core, s.r)
      if (twoWay && id === 'you') {
        // You's spoke is two standing lanes, each with a small head that says which way it runs: in, and out.
        for (const lane of [{ from: 'you', to: 'core' }, { from: 'core', to: 'you' }]) {
          const { d, head } = arrow(hubLeg(layout, lane), px(5), px(2.4))
          out.push(`<path class="lane" d="${d}" fill="none" stroke="${p.line}" stroke-width="${px(1.2)}" stroke-linecap="round"/><path class="lane" d="${head}" fill="${p.line}"/>`)
        }
        continue
      }
      // The agent reaches into what the person has open; that line is dashed, like no other spoke.
      const dash = id === 'screen' ? ` stroke-dasharray="${px(2)} ${px(4)}"` : ''
      out.push(`<line x1="${n1(a.x)}" y1="${n1(a.y)}" x2="${n1(b.x)}" y2="${n1(b.y)}" stroke="${mix(p.spoke, hueOf(id), 0.45 * worn)}" stroke-width="${px(1 + worn)}" stroke-linecap="round"${dash}/>`)
    }
  }

  // The context window: quiet until it nears its limit.
  const full = state.context === undefined ? undefined : Math.max(0, Math.min(100, Math.round(state.context)))
  const near = full !== undefined && full >= CONTEXT_NEAR
  // Near its limit the ring is the map's grey, and at the second threshold its white: never as wide as the newest leg.
  const ringHue = full !== undefined && full >= CONTEXT_FULL ? p.bone : near ? p.ash : mix(p.line, p.ash, 0.4)
  if (full !== undefined && (level >= 2 || near)) {
    const ring = `cx="${layout.core.x}" cy="${layout.core.y}" r="${CORE + 5}" fill="none"`
    const width = full >= CONTEXT_FULL ? 3 : near ? 2.2 : 1.4
    if (level >= 2) out.push(`<circle ${ring} stroke="${p.spoke}" stroke-width="${px(1.2)}"/>`)
    out.push(`<circle ${ring} stroke="${ringHue}" stroke-width="${px(width)}" pathLength="100" stroke-dasharray="${full} 100" transform="rotate(-90 ${layout.core.x} ${layout.core.y})"/>`)
  }

  // The route. The newest leg is widest and brightest, and every leg says which way it went.
  const legs = (level === 1 ? state.legs.slice(-3) : state.legs).filter(leg => used(leg.from) && used(leg.to))
  const counts = []
  legs.forEach((leg, i) => {
    const isHead = i === legs.length - 1
    const step = stepOf(legs.length - 1 - i)
    const curve = hubLeg(layout, leg)
    // A wake that nobody typed is the map's grey, dashed; everything else is the route's white.
    const unasked = leg.kind === 'wake' && leg.by !== 'person'
    const colour = mix(p.ground, unasked ? p.ash : p.trail, ROUTE_TONE[step] * leg.strength)
    const width = ROUTE_PX[level][step] + (leg.n > 1 && level < 3 ? 0.6 : 0)
    const length = Math.max(px(width * 2.6), level === 3 ? 11 : 0)
    const { d, head } = arrow(curve, length, length * 0.42)
    // Each leg is cased in the ground's colour, and legs are drawn oldest first: where two cross, the newer one
    // passes over with a dark edge on either side, so a crossing is never one white patch with four ways out.
    if (level >= 2) out.push(`<path class="casing" d="${d}" fill="none" stroke="${p.ground}" stroke-width="${px(width + 3)}" stroke-linecap="butt"/><path class="casing" d="${head}" fill="${p.ground}" stroke="${p.ground}" stroke-width="${px(2.4)}" stroke-linejoin="round"/>`)
    out.push(`<path d="${d}" fill="none" stroke="${colour}" stroke-width="${px(width)}" stroke-linecap="round"${unasked ? ` stroke-dasharray="${px(width * 1.6)} ${px(width * 1.8)}"` : ''}/>`)
    // At a glyph's size only the newest leg has room for its head.
    if (level > 1 || isHead) out.push(`<path d="${head}" fill="${colour}"/>`)
    if (isHead && motion === 'full' && leg.f !== undefined && leg.f < 1 && level >= 2) {
      const at = curveAt(curve, leg.f)
      out.push(`<circle cx="${n1(at.x)}" cy="${n1(at.y)}" r="${px(3.6)}" fill="${p.bone}" stroke="${p.ground}" stroke-width="${px(1)}"/>`)
    }
    if (leg.n > 1 && level === 3) counts.push({ at: curveAt(curve, 0.5), n: leg.n, colour })
  })

  // The core.
  const coreLevel = Math.max(...Object.values(state.stations).map(s => s.level), 0)
  const coreR = level === 1 ? CORE * 0.55 : CORE
  out.push(`<circle cx="${layout.core.x}" cy="${layout.core.y}" r="${n1(coreR)}" fill="${p.raised}" stroke="${level === 1 && near ? ringHue : mix(p.line, p.bone, 0.3 + 0.5 * coreLevel)}" stroke-width="${px(level === 1 ? 2.2 : 1.6)}"/>`)
  const font = n1(LABEL_PX * unit)
  // What the core says, at 16 px: the model first, since which model is at work is the thing to know, and under it the
  // agent's name or, once the window nears its limit, how full it is. Where both lines do not fit the model keeps its
  // place and the second line goes; a name too long for one line is broken in two. A short name fits the core from
  // about 280 px of map up, where the stations have no room for theirs; where nothing fits, the core says nothing.
  if (level === 3 || (level === 2 && size >= 240 && model !== '')) {
    const under = near ? `${full}% full` : level === 3 ? coreName : ''
    const tries = []
    if (model !== '') {
      // In order: both lines; the model alone on one line; the model broken in two.
      if (under !== '') tries.push([model, under])
      tries.push([model])
      const cut = breakInTwo(model)
      if (cut) tries.push(cut)
    }
    if (under !== '') tries.push([under])
    const lead = font * 1.12
    const fits = lines =>
      lines.every((line, k) => {
        const reach = Math.abs((k - (lines.length - 1) / 2) * lead) + font * 0.5
        return reach < CORE && line.length * font * CORE_CHAR <= 2 * Math.sqrt(CORE * CORE - reach * reach) - 4
      })
    const lines = tries.find(fits) ?? []
    lines.forEach((line, k) => {
      const y = layout.core.y + (k - (lines.length - 1) / 2) * lead + font * 0.34
      const isModel = model !== '' && line !== under
      const weight = isModel || (near && full >= CONTEXT_FULL) ? 700 : 500
      out.push(`<text x="${layout.core.x}" y="${n1(y)}" text-anchor="middle" ${FONT} font-size="${font}" font-weight="${weight}" fill="${isModel || near ? p.bone : p.ash}">${esc(line)}</text>`)
    })
  }

  // The stations.
  for (const id of layout.order) {
    if (!used(id)) continue
    const s = layout.stations[id]
    const st = state.stations[id]
    const hue = hueOf(id)
    const square = PERSON_SIDE.has(id)
    const fault = st.faults > 0
    const lit = st.level > 0.02
    const shape = (r, attrs) =>
      square
        ? `<rect x="${n1(s.x - r)}" y="${n1(s.y - r)}" width="${n1(r * 2)}" height="${n1(r * 2)}" rx="${n1(r * 0.28)}" ${attrs}/>`
        : `<circle cx="${n1(s.x)}" cy="${n1(s.y)}" r="${n1(r)}" ${attrs}/>`
    if (level === 1) {
      // At a glyph's size a station is a pad in its own colour: half strength at rest, whole and larger when lit.
      const r = Math.max(s.r * 0.8, px(2.2)) * (lit ? 1.25 : 1)
      // The person's side is white, and a lit white pad would outshine the route's newest leg: it stops short of that.
      out.push(shape(r, `fill="${fault ? FAULT : lit ? (square ? mix(p.ground, hue, 0.72) : hue) : mix(p.ground, hue, 0.5)}"`))
      continue
    }
    if (st.running > 0) out.push(shape(s.r + 5, `class="running" fill="none" stroke="${hue}" stroke-width="${px(1.4)}"`))
    // The station whose calls are listed beside the map wears a ring in the page's own accent, round the node alone:
    // a box round the node and its name would cut through a name wider than the box.
    if (id === pressed) out.push(shape(s.r + 8, `class="pressed" fill="none" stroke="${accent}" stroke-width="${px(2)}"`))
    // A lit station is never brighter than the route: its fill stops at just over half its colour, and its edge is the whole of it.
    // The two neutral families are the lightest colours on the map, so their fill stops sooner still.
    const neutral = hue === KIND.you || hue === KIND.own
    const fill = lit ? mix(p.raised, hue, neutral ? 0.08 + 0.2 * st.level : 0.12 + 0.44 * st.level) : p.raised
    out.push(shape(s.r, `fill="${fill}" stroke="${fault ? FAULT : mix(p.line, hue, 0.6 + 0.4 * st.level)}" stroke-width="${px(fault ? 2.4 : lit ? 2.2 : 1.6)}"`))
    if (unit <= 2.3) {
      const tone = lit ? p.bone : p.ash
      out.push(`<path d="${ICONS[id]}" transform="translate(${n1(s.x)} ${n1(s.y)})" fill="none" stroke="${tone}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)
    }
    if (fault && level === 2) out.push(`<circle class="fault" cx="${n1(s.x + s.r * 0.72)}" cy="${n1(s.y - s.r * 0.72)}" r="${n1(Math.max(6, px(3)))}" fill="${FAULT}" stroke="${p.ground}" stroke-width="${px(1.2)}"/>`)
    // Names and figures stand outside the ring, so the room inside it is the route's alone.
    const above = s.y < layout.core.y - 20
    const rim = `paint-order="stroke" stroke="${p.ground}" stroke-width="${n1(font * 0.3)}" stroke-linejoin="round"`
    if (level === 2 && size >= FIGURES_FROM) {
      // Too narrow for names: the count alone, which is what accumulates as a session runs. You's two counts stand
      // beside their lanes as they do with names, without the words: the lane's arrow says which is which.
      if (st.told === undefined) {
        if (st.count > 0) out.push(`<text class="count" x="${n1(s.x)}" y="${n1(above ? s.y - s.r - 10 : s.y + s.r + 8 + font * 0.82)}" text-anchor="middle" ${FONT} font-size="${font}" font-weight="500" ${rim} fill="${lit ? p.bone : p.ash}">${st.count}</text>`)
      } else {
        for (const [lane, n] of [[{ from: 'you', to: 'core' }, st.count], [{ from: 'core', to: 'you' }, st.told]]) {
          if (!(n > 0)) continue
          const curve = hubLeg(layout, lane)
          const side = rightOf(curve.p0, curve.p2)
          const anchor = side.x < -0.3 ? 'end' : side.x > 0.3 ? 'start' : 'middle'
          out.push(`<text class="count" x="${n1(curve.p1.x + side.x * 9)}" y="${n1(curve.p1.y + side.y * 9 + font * 0.34)}" text-anchor="${anchor}" ${FONT} font-size="${font}" font-weight="500" ${rim} fill="${p.ash}">${n}</text>`)
        }
      }
    }
    if (level === 3) {
      const nameY = above ? s.y - s.r - 10 - font * 1.15 : s.y + s.r + 8 + font * 0.82
      const name = names[id] ?? id
      // A station nothing has happened at yet has its name and no figure: "0" under ten names is ten marks that say nothing.
      const said = st.told === undefined ? (st.count > 0 ? String(st.count) : '') : ''
      const figures = `${said}${fault ? `<tspan class="fault" fill="${FAULT}">${said === '' ? '' : ' · '}${st.faults} failed</tspan>` : ''}`
      const halfWidth = (Math.max(name.length, said.length + (fault ? 11 : 0)) * font * 0.56) / 2
      const x = n1(Math.max(4 + halfWidth, Math.min(layout.width - 4 - halfWidth, s.x)))
      // With no figure under it a name above its station sits on the line next to the node, where the figure would have been.
      const y = above && figures === '' ? nameY + font * 1.15 : nameY
      out.push(`<text x="${x}" y="${n1(y)}" text-anchor="middle" ${FONT} font-size="${font}" font-weight="600" ${rim} fill="${lit ? p.bone : p.ash}">${esc(name)}</text>`)
      if (figures !== '') out.push(`<text x="${x}" y="${n1(nameY + font * 1.15)}" text-anchor="middle" ${FONT} font-size="${font}" font-weight="500" ${rim} fill="${p.ash}">${figures}</text>`)
      // Two-way, You has two counts, and each stands beside its own lane: what the person said by the lane in, what
      // the agent told by the lane out. One line of both under the name ran into the names of the stations next to it.
      if (st.told !== undefined && st.count + st.told > 0) {
        for (const [lane, text] of [[{ from: 'you', to: 'core' }, `${st.count} said`], [{ from: 'core', to: 'you' }, `${st.told} told`]]) {
          const curve = hubLeg(layout, lane)
          const side = rightOf(curve.p0, curve.p2)
          const at = { x: curve.p1.x + side.x * 9, y: curve.p1.y + side.y * 9 }
          const anchor = side.x < -0.3 ? 'end' : side.x > 0.3 ? 'start' : 'middle'
          out.push(`<text x="${n1(at.x)}" y="${n1(at.y + font * 0.34)}" text-anchor="${anchor}" ${FONT} font-size="${font}" font-weight="500" ${rim} fill="${p.ash}">${text}</text>`)
        }
      }
    }
  }

  // How many times a leg was made, on the leg, over everything else.
  for (const c of counts) {
    out.push(`<text x="${n1(c.at.x)}" y="${n1(c.at.y + font * 0.34)}" text-anchor="middle" ${FONT} font-size="${font}" font-weight="700" paint-order="stroke" stroke="${p.ground}" stroke-width="${n1(font * 0.36)}" stroke-linejoin="round" fill="${p.bone}">×${c.n}</text>`)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width}" height="${layout.height}">${out.join('')}</svg>`
}
