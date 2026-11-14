// A session drawn as a head in profile: a second rendering of the same actions
// the hub-and-spoke map draws, meant to stay readable when it is shrunk.
//
// The hub puts every station on one ring, so "what the agent has" (a model,
// memory, skills, hooks) and "what it touches" (the person, files, the shell,
// the web) look like the same kind of thing. Here the skull is that boundary.
// Faculties sit inside it and the world reaches it through organs:
//
//   eye          Network, Browser, file reads      taking in
//   ear, mouth   the person: prompts in, replies and task updates out
//   hand         Shell, file edits                 acting
//   cortex       Model
//   hippocampus  Memory
//   cerebellum   Skills
//   brainstem    Hooks: they fire on an event, the model does not choose them
//   small heads  Subagents, and the calls they make
//
// Two encodings carry the flow, and both survive shrinking because neither is
// text or a fine line:
//
//   place   which region is lit. The anatomy never moves between sizes, so a
//           place learned at 460 px is the same place at 24 px.
//   hue     the direction of information. Cool is taking in, warm is putting
//           out, white is the model working. A glyph that glows cool is
//           reading; one that glows warm is changing things.
//
// A region's light is a leaky sum of its recent calls, exp(-age / tau), so one
// call is a flash and a burst is a sustained glow. That is a display choice,
// not a measurement: tau is chosen so a call stays visible for a few seconds.
//
// The mapping to anatomy is by function and is a mnemonic. It claims nothing
// about how a model works.

import { DARK } from './palette.js'
import { mix } from './tint.js'

export { mix }

export const PORTRAIT_FULL = { x: -34, y: 0, w: 594, h: 460 }
/** Below the labelled size the frame closes in on the head and the hand: there is nothing in the margins to show. */
export const PORTRAIT_TIGHT = { x: 62, y: 30, w: 420, h: 426 }

/** The size names are set at, in CSS pixels. A name is never drawn smaller. */
const LABEL_PX = 16
/** The widest a name may grow in drawing units before it no longer fits the margins. */
const LABEL_MAX_UNITS = 24

/**
 * 3: names and counts. 2: regions, tracts and moving pulses. 1: a lit silhouette.
 * Names appear only where they can be 16 px: under 396 px wide they would have to shrink, so they go.
 */
export function portraitLevel(size) {
  if (size >= (PORTRAIT_FULL.w * LABEL_PX) / LABEL_MAX_UNITS) return 3
  if (size >= 96) return 2
  return 1
}

/** A fast replay puts dozens of calls inside one pulse's travel time. Past three the tract is a dotted line, not a flow. */
const MAX_PULSES = 3

const REGION_IDS = ['cortex', 'hippocampus', 'cerebellum', 'brainstem', 'eye', 'ear', 'mouth', 'hand', 'peers']

/**
 * Where one action shows, and which way its information ran.
 * `part` names the count it adds to, since the eye and the hand each stand for several stations.
 */
export function regionOf(action) {
  // A subagent's call is another mind's work: it lights the small heads, not this head's organs.
  if (action.agentId !== undefined) return { region: 'peers', dir: 'out', part: 'calls' }
  const writes = action.op === 'edit' || action.op === 'write'
  switch (action.station) {
    case 'you':
      return action.from === 'inbound' ? { region: 'ear', dir: 'in', part: 'heard' } : { region: 'mouth', dir: 'out', part: 'told' }
    case 'model':
      return { region: 'cortex', dir: 'think', part: 'model' }
    case 'memory':
      return { region: 'hippocampus', dir: writes ? 'out' : 'in', part: 'memory' }
    case 'web':
      return { region: 'eye', dir: 'in', part: 'web' }
    case 'browser':
      return { region: 'eye', dir: 'in', part: 'browser' }
    case 'files':
      return action.op === 'read' || action.op === 'search' ? { region: 'eye', dir: 'in', part: 'reads' } : { region: 'hand', dir: 'out', part: 'edits' }
    case 'shell':
      return { region: 'hand', dir: 'out', part: 'shell' }
    case 'skills':
      return { region: 'cerebellum', dir: 'in', part: 'skills' }
    case 'hooks':
      return { region: 'brainstem', dir: 'reflex', part: 'hooks' }
    case 'agents':
      return { region: 'peers', dir: 'out', part: 'agents' }
    default:
      return { region: 'hand', dir: 'out', part: 'shell' }
  }
}

/**
 * The portrait's state at one moment of a session.
 * `tau` and `travel` are in session time: a replay at 60x passes them 60 times longer, so a call
 * glows for the same few seconds on screen whatever the speed.
 */
export function portraitState(actions, at, { tau = 4000, travel = 900 } = {}) {
  const regions = Object.fromEntries(REGION_IDS.map(id => [id, { count: 0, parts: {}, act: { in: 0, out: 0, think: 0, reflex: 0 }, running: 0, faults: 0, pulses: [] }]))
  const horizon = tau * 8
  let total = 0
  for (const a of actions) {
    if (!Number.isFinite(a.startedAt) || a.startedAt > at) continue
    const { region, dir, part } = regionOf(a)
    const r = regions[region]
    r.count++
    r.parts[part] = (r.parts[part] ?? 0) + 1
    total++
    const age = at - a.startedAt
    if (age < horizon) r.act[dir] += Math.exp(-age / tau)
    // Actions are in time order, so the newest come last; a tract shows the three newest and the cortex one ring.
    if (age < travel) {
      r.pulses.push({ dir, f: age / travel })
      if (r.pulses.length > (region === 'cortex' ? 1 : MAX_PULSES)) r.pulses.shift()
    }
    const ended = a.endedAt !== undefined && a.endedAt <= at
    if (!ended) r.running++
    // Faults are counted since the person's last message, as on the hub.
    if (a.station === 'you' && a.from === 'inbound') for (const id of REGION_IDS) regions[id].faults = 0
    else if (ended && (a.status === 'err' || a.status === 'block')) r.faults++
  }
  for (const r of Object.values(regions)) {
    const sum = r.act.in + r.act.out + r.act.think + r.act.reflex + (r.running > 0 ? 0.7 : 0)
    // Saturating: ten calls in a second are not ten times brighter than one.
    r.level = 1 - Math.exp(-sum)
    r.dir = r.running > 0 && sum < 0.75 ? dominant(r.act, 'out') : dominant(r.act, 'think')
  }
  return { at, total, regions }
}

function dominant(act, fallback) {
  let best = fallback
  let most = 0
  for (const [dir, v] of Object.entries(act)) {
    if (v > most) {
      most = v
      best = dir
    }
  }
  return best
}

// ─── Geometry ───────────────────────────────────────────────────────────────
//
// One set of coordinates for every size. Only stroke weight and what is drawn
// change with the level.

const HEAD = 'M206 452 L192 372 C150 352 96 302 88 222 C80 112 170 48 266 50 C332 52 378 96 384 160 L378 206 L404 262 L378 272 L384 292 L374 304 L382 318 C384 350 360 372 322 372 C300 372 296 402 300 452 Z'
const CORTEX = 'M120 214 C98 150 140 82 230 74 C310 68 358 112 356 160 C354 186 332 200 300 204 C286 250 222 260 192 238 C160 248 128 240 120 214 Z'
const SULCI = ['M168 112 C196 132 196 168 176 196', 'M232 86 C246 122 238 160 252 190', 'M300 96 C292 126 310 150 300 184']
const CEREBELLUM = 'M112 270 C112 248 150 240 176 252 C196 262 196 290 172 298 C146 306 114 296 112 270 Z'
const FOLIA = ['M124 262 C146 256 170 260 186 270', 'M120 276 C146 270 172 274 188 284', 'M128 290 C148 286 166 288 178 294']
const STEM = { d: 'M200 246 C204 300 214 348 228 402', w: 15 }
const HIPPO = { d: 'M236 198 C266 186 292 204 280 226 C272 240 250 236 250 222', w: 10 }
const EYE = 'M326 230 Q346 214 366 230 Q346 246 326 230 Z'
const PUPIL = { x: 348, y: 230, r: 6 }
const EAR = { d: 'M252 286 C278 276 286 306 270 322 C262 330 252 324 256 310', w: 7 }
const MOUTH = { d: 'M350 306 L378 304', w: 7 }
const HAND = 'M392 416 C386 396 398 382 410 388 L414 366 C416 358 426 360 426 368 L427 360 C428 351 439 352 439 361 L440 366 C441 358 451 359 451 368 L451 392 C458 384 468 390 462 400 L446 432 C440 444 404 446 396 432 Z'
const PEER = (x, y) => `M${x - 9} ${y + 16} L${x - 8} ${y + 6} C${x - 16} ${y} ${x - 14} ${y - 14} ${x} ${y - 14} C${x + 12} ${y - 14} ${x + 14} ${y - 2} ${x + 9} ${y + 2} L${x + 13} ${y + 8} L${x + 8} ${y + 9} C${x + 8} ${y + 14} ${x + 4} ${y + 15} ${x + 2} ${y + 16} Z`
const PEERS = [[438, 74], [470, 60], [502, 74]]

// The model answers on nearly every step, so at full strength its light would be on all the time and
// drown the organs, which are what change. It is held to half.
const GAIN = { cortex: 0.5 }
// Large regions carry their own light; a halo behind them only spills past the skull.
const NO_HALO = new Set(['cortex', 'cerebellum', 'brainstem'])

// At a glyph's size the three small heads are one spot, pulled in so the tight frame does not cut it.
const GLYPH_CENTERS = { peers: [446, 72, 18] }

// Where a region's light sits and how far it spreads, for the small sizes.
const CENTERS = {
  cortex: [238, 150, 96],
  hippocampus: [264, 212, 26],
  cerebellum: [152, 272, 40],
  brainstem: [214, 330, 28],
  eye: [346, 230, 26],
  ear: [268, 302, 24],
  mouth: [366, 305, 22],
  hand: [426, 404, 40],
  peers: [470, 70, 40],
}

// One cubic per tract, as [from, c1, c2, to]: the way information runs for an inward call.
// An outward call runs the same tract the other way.
const TRACTS = {
  eye: [[326, 230], [290, 232], [196, 228], [132, 190]],
  ear: [[262, 290], [262, 268], [256, 250], [250, 236]],
  mouth: [[312, 198], [322, 240], [336, 280], [352, 304]],
  hand: [[228, 402], [286, 446], [356, 446], [396, 420]],
  hippocampus: [[262, 196], [262, 180], [250, 160], [240, 140]],
  cerebellum: [[176, 254], [192, 244], [204, 236], [214, 222]],
  brainstem: [[214, 330], [208, 300], [204, 270], [204, 240]],
  peers: [[330, 104], [372, 84], [402, 76], [432, 76]],
}
// Tracts drawn outward: a pulse on them leaves the cortex.
const OUTWARD = new Set(['mouth', 'hand', 'peers'])

const tractPath = ([p, a, b, q]) => `M${p[0]} ${p[1]} C${a[0]} ${a[1]} ${b[0]} ${b[1]} ${q[0]} ${q[1]}`

function onTract([p, a, b, q], t) {
  const u = 1 - t
  const k = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t]
  return [k[0] * p[0] + k[1] * a[0] + k[2] * b[0] + k[3] * q[0], k[0] * p[1] + k[1] * a[1] + k[2] * b[1] + k[3] * q[1]]
}

// ─── Colour ─────────────────────────────────────────────────────────────────

/** Cool takes in, warm puts out, white is the model, and a reflex is the cool of an input it did not ask for. */
function hueOf(dir, p) {
  if (dir === 'in') return p.memHot
  if (dir === 'out') return p.hot
  if (dir === 'reflex') return p.mem
  return p.bone
}

const n1 = v => Math.round(v * 10) / 10
const esc = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// ─── Labels (level 3 only) ──────────────────────────────────────────────────

const FONT = "font-family=\"ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif\""

/** The names beside each region. A part with no calls is left out; a region with none gets no label at all. */
function labelsFor(state, names) {
  const r = state.regions
  const line = (id, parts) => parts.filter(([key]) => (r[id].parts[key] ?? 0) > 0).map(([key, name]) => `${name} ${r[id].parts[key]}`)
  return [
    { id: 'cortex', x: 236, y: 30, anchor: 'middle', lines: line('cortex', [['model', names.model]]) },
    // No name is set over the cortex: its ground runs from near-black to mid-grey, and no one text colour holds 8:1 on both.
    { id: 'hippocampus', x: 78, y: 214, anchor: 'end', lines: line('hippocampus', [['memory', names.memory]]), lead: [82, 209, 234, 209], over: true },
    { id: 'cerebellum', x: 78, y: 268, anchor: 'end', lines: line('cerebellum', [['skills', names.skills]]), lead: [82, 270, 110, 270] },
    { id: 'brainstem', x: 170, y: 420, anchor: 'end', lines: line('brainstem', [['hooks', names.hooks]]), lead: [174, 414, 214, 372] },
    { id: 'eye', x: 420, y: 206, anchor: 'start', lines: line('eye', [['web', names.web], ['browser', names.browser], ['reads', 'Reads']]), lead: [414, 222, 372, 230] },
    { id: 'you', x: 420, y: 300, anchor: 'start', lines: [[r.ear.count && `${r.ear.count} in`, r.mouth.count && `${r.mouth.count} out`].filter(Boolean).join(' · ')].filter(Boolean).map(text => `${names.you} ${text}`), lead: [414, 300, 384, 304] },
    { id: 'hand', x: 478, y: 398, anchor: 'start', lines: line('hand', [['shell', names.shell], ['edits', 'Edits']]) },
    { id: 'peers', x: 420, y: 118, anchor: 'start', lines: line('peers', [['agents', names.agents], ['calls', 'Calls']]) },
  ].filter(label => label.lines.length > 0)
}

// ─── Drawing ────────────────────────────────────────────────────────────────

/**
 * The portrait as one SVG string.
 * `size` is the width it will be shown at in CSS pixels; it picks the level of detail and the stroke weight.
 * `clock` is display time in ms, for the slow breathing of a call still running.
 */
export function drawPortrait(state, { size = 460, palette = DARK, names = {}, clock = 0, motion = 'full' } = {}) {
  const p = palette
  const level = portraitLevel(size)
  const box = level === 3 ? PORTRAIT_FULL : PORTRAIT_TIGHT
  // Strokes are set in drawing units, so a line stays about `px` CSS pixels wide at any size.
  const unit = box.w / size
  const px = v => n1(v * unit)
  const r = state.regions
  const out = []

  const breath = motion === 'full' ? 0.5 + 0.5 * Math.sin(clock / 420) : 1
  const lit = id => {
    const region = r[id]
    const level01 = (region.running > 0 ? Math.max(region.level, 0.55 + 0.25 * breath) : region.level) * (GAIN[id] ?? 1)
    return { level: level01, hue: hueOf(region.dir, p), used: region.count > 0, fault: region.faults > 0 }
  }
  // A region the session never used is drawn in the head's own colour with the faintest edge: its place is kept, its ink is not spent.
  const fillOf = l => (l.level > 0.02 ? mix(p.raised, l.hue, 0.18 + 0.82 * l.level) : l.used ? mix(p.raised, p.ash, 0.2) : p.raised)
  const edgeOf = l => (l.fault ? p.red : l.level > 0.02 ? mix(p.line, l.hue, 0.35 + 0.65 * l.level) : l.used ? p.line : p.spoke)

  // A soft light under an active region. At a glyph's size this, not the outline, is what is seen.
  const halo = id => {
    const l = lit(id)
    if (l.level < 0.06) return
    const [cx, cy, rad] = (level === 1 && GLYPH_CENTERS[id]) || CENTERS[id]
    if (level === 1) {
      // At a glyph's size the organ itself is a pixel or two: its light is drawn as a spot no smaller than 3 px across.
      if (id === 'cortex') return
      out.push(`<circle cx="${cx}" cy="${cy}" r="${n1(Math.max(rad * 1.2, px(3.2)))}" fill="${l.hue}" fill-opacity="${n1(0.45 + 0.5 * l.level)}"/>`)
    } else if (!NO_HALO.has(id)) {
      out.push(`<circle cx="${cx}" cy="${cy}" r="${n1(rad * (0.95 + 0.3 * l.level))}" fill="${l.hue}" fill-opacity="${n1(0.1 + 0.18 * l.level)}"/>`)
    }
  }
  // Below the glyph threshold an idle organ is clutter: only the head, the cortex and what is lit are drawn.
  const drawn = id => level > 1 || id === 'cortex' || lit(id).level >= 0.06
  const shape = (id, d, weight = 1.6) => {
    if (!drawn(id)) return
    const l = lit(id)
    out.push(`<path d="${d}" fill="${fillOf(l)}" stroke="${edgeOf(l)}" stroke-width="${px(weight)}" stroke-linejoin="round"/>`)
  }
  const stroke = (id, { d, w }) => {
    if (!drawn(id)) return
    const l = lit(id)
    const width = Math.max(w, px(level === 1 ? 5 : 3))
    out.push(`<path d="${d}" fill="none" stroke="${edgeOf(l)}" stroke-width="${n1(width + px(2.4))}" stroke-linecap="round"/>`)
    out.push(`<path d="${d}" fill="none" stroke="${fillOf(l)}" stroke-width="${n1(width)}" stroke-linecap="round"/>`)
  }

  out.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${p.ground}"/>`)

  // The head: the boundary between what the agent has and what it touches.
  out.push(`<path d="${HEAD}" fill="${p.raised}" stroke="${p.line}" stroke-width="${px(level === 1 ? 2.4 : 1.6)}" stroke-linejoin="round"/>`)

  for (const id of REGION_IDS) halo(id)

  // Tracts: the paths information takes. Too fine to mean anything at a glyph's size.
  if (level >= 2) {
    for (const [id, tract] of Object.entries(TRACTS)) {
      const l = lit(id)
      if (!l.used) continue
      out.push(`<path d="${tractPath(tract)}" fill="none" stroke="${l.level > 0.05 ? mix(p.line, l.hue, 0.5 * l.level) : p.line}" stroke-width="${px(1.4)}" stroke-dasharray="${px(2)} ${px(5)}" stroke-linecap="round"/>`)
    }
  }

  stroke('brainstem', STEM)
  shape('cerebellum', CEREBELLUM)
  shape('cortex', CORTEX)
  if (level === 3) {
    for (const d of [...SULCI, ...FOLIA]) out.push(`<path d="${d}" fill="none" stroke="${p.line}" stroke-width="${px(1.2)}" stroke-linecap="round"/>`)
  }
  stroke('hippocampus', HIPPO)
  shape('eye', EYE)
  if (drawn('eye')) {
    const l = lit('eye')
    out.push(`<circle cx="${PUPIL.x}" cy="${PUPIL.y}" r="${n1(Math.max(PUPIL.r, px(2.5)))}" fill="${l.level > 0.02 ? p.ground : l.used ? p.line : p.spoke}"/>`)
  }
  stroke('ear', EAR)
  stroke('mouth', MOUTH)
  shape('hand', HAND)

  // Subagents: one small head each for the first three; the count says the rest.
  const peers = lit('peers')
  if (peers.used && drawn('peers')) {
    const shown = level === 1 ? 1 : Math.min(PEERS.length, Math.max(1, r.peers.parts.agents ?? 1))
    for (const [x, y] of PEERS.slice(0, shown)) {
      out.push(`<path d="${PEER(x, y)}" fill="${fillOf(peers)}" stroke="${edgeOf(peers)}" stroke-width="${px(1.6)}" stroke-linejoin="round"/>`)
    }
  }

  // A fault since the person's last message: a red mark on the region, large enough to survive shrinking.
  for (const id of REGION_IDS) {
    if (r[id].faults === 0) continue
    const [cx, cy, rad] = CENTERS[id]
    out.push(`<circle cx="${n1(cx + rad * 0.55)}" cy="${n1(cy - rad * 0.55)}" r="${n1(Math.max(7, px(3.5)))}" fill="${p.red}" stroke="${p.ground}" stroke-width="${px(1.2)}"/>`)
  }

  // Calls in flight: a dot running its tract, inward or outward. The model's own work is a ring opening in the cortex.
  if (level >= 2 && motion === 'full') {
    for (const [id, tract] of Object.entries(TRACTS)) {
      for (const pulse of r[id].pulses) {
        const outward = pulse.dir === 'out'
        const t = OUTWARD.has(id) === outward ? pulse.f : 1 - pulse.f
        const [x, y] = onTract(tract, t)
        out.push(`<circle cx="${n1(x)}" cy="${n1(y)}" r="${px(4)}" fill="${hueOf(pulse.dir, p)}" stroke="${p.ground}" stroke-width="${px(1)}"/>`)
      }
    }
    for (const pulse of r.cortex.pulses) {
      const [cx, cy, rad] = CENTERS.cortex
      out.push(`<circle cx="${cx}" cy="${cy}" r="${n1(10 + rad * 0.7 * pulse.f)}" fill="none" stroke="${mix(p.bone, p.raised, pulse.f)}" stroke-width="${px(1.6)}"/>`)
    }
  }

  if (level === 3) {
    for (const label of labelsFor(state, names)) {
      const region = label.id === 'you' ? (r.mouth.level > r.ear.level ? lit('mouth') : lit('ear')) : lit(label.id)
      if (label.lead) {
        const d = `M${label.lead[0]} ${label.lead[1]} L${label.lead[2]} ${label.lead[3]}`
        // A leader that crosses the cortex has to show on a lit one: a dark casing under a light line.
        if (label.over) out.push(`<path d="${d}" stroke="${p.ground}" stroke-width="3.6"/>`)
        out.push(`<path d="${d}" stroke="${label.over ? p.ash : p.line}" stroke-width="1.2"/>`)
      }
      // Set in drawing units so that the name is 16 px on screen at this size.
      const font = n1(Math.max(LABEL_PX, LABEL_PX * unit))
      label.lines.forEach((text, i) => {
        // Names are read, so they take a text colour that holds 8:1 on either ground whatever the region is doing.
        const ink = region.level > 0.25 ? p.bone : p.ash
        out.push(`<text x="${label.x}" y="${n1(label.y + i * font * 1.3)}" text-anchor="${label.anchor}" ${FONT} font-size="${font}" font-weight="${region.level > 0.25 ? 600 : 500}" fill="${ink}">${esc(text)}</text>`)
      })
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box.x} ${box.y} ${box.w} ${box.h}" width="${box.w}" height="${box.h}">${out.join('')}</svg>`
}

/** The frame's aspect at a size, so a page can reserve the space before the picture arrives. */
export function portraitAspect(size) {
  const box = portraitLevel(size) === 3 ? PORTRAIT_FULL : PORTRAIT_TIGHT
  return box.w / box.h
}
