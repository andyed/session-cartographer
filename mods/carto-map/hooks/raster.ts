// The map as pixels, for a terminal that shows pictures but not SVG.
// It reads the drawing drawMap makes (a small, known part of SVG), works out where each animation stands
// at a given moment, and paints that moment into RGBA pixels. Nothing here touches the engine.
import { BOLD, FONTS } from './font'
import type { BitmapFont } from './font'

type Point = { x: number; y: number }

/** An Image takes at most this many bytes of pixels. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024

// ---- the drawing, read --------------------------------------------------------------------------

type Timing = { begin: number; dur: number; repeat: number; freeze: boolean }
type ValueAnimation = Timing & { kind: 'value'; attr: string; values: number[]; keyTimes: number[] | undefined }
type MotionAnimation = Timing & { kind: 'motion'; from: Point; to: Point }
type TurnAnimation = Timing & { kind: 'turn'; from: number[]; to: number[] }
type Animation = ValueAnimation | MotionAnimation | TurnAnimation

type Run = { text: string; fill: string | undefined }
type Sub = { points: Point[]; closed: boolean }
/** A group's own transform, and its turns, which take its place while they run, as in SVG. */
type Group = { matrix: Matrix; turns: Animation[] }

type Shape = {
  tag: 'rect' | 'ellipse' | 'circle' | 'line' | 'path' | 'text'
  attrs: Readonly<Record<string, string>>
  /** Its own animations, the latest to begin last: a later one overrides an earlier one, as in SVG. */
  animations: Animation[]
  /** The groups it sits in, innermost first. */
  groups: Group[]
  runs: Run[]
  /** A path's outline, read once. */
  subs?: Sub[]
}

export type Scene = {
  width: number
  height: number
  shapes: Shape[]
  /** What the reader met and cannot paint: an element, an attribute or a value. Empty for every drawing drawMap makes. */
  unknown: string[]
}

const PAINT = ['fill', 'stroke', 'stroke-width', 'opacity', 'stroke-dasharray', 'stroke-dashoffset', 'pathLength', 'stroke-linecap', 'stroke-linejoin', 'transform']
const KNOWN: Readonly<Record<string, readonly string[]>> = {
  svg: ['xmlns', 'role', 'viewBox', 'width', 'height'],
  g: ['transform'],
  style: [],
  rect: ['x', 'y', 'width', 'height', 'rx', ...PAINT],
  ellipse: ['cx', 'cy', 'rx', 'ry', ...PAINT],
  circle: ['cx', 'cy', 'r', ...PAINT],
  line: ['x1', 'y1', 'x2', 'y2', ...PAINT],
  path: ['d', ...PAINT],
  text: ['x', 'y', 'text-anchor', 'font-family', 'font-size', 'font-weight', 'letter-spacing', 'paint-order', ...PAINT],
  tspan: ['fill'],
  animate: ['attributeName', 'values', 'keyTimes', 'begin', 'dur', 'fill', 'repeatCount'],
  animateMotion: ['path', 'begin', 'dur', 'fill', 'repeatCount'],
  animateTransform: ['attributeName', 'type', 'from', 'to', 'begin', 'dur', 'fill', 'repeatCount'],
}
const ANIMATED = new Set(['opacity', 'r', 'stroke-dashoffset'])
const COLORED = ['fill', 'stroke']

const TOKEN = /<(\/?)([A-Za-z]+)((?:\s+[A-Za-z][\w:-]*="[^"]*")*)\s*(\/?)>|([^<]+)/g
const ATTRIBUTE = /([A-Za-z][\w:-]*)="([^"]*)"/g

const num = (v: string | undefined, fallback: number): number => {
  const n = v === undefined ? NaN : Number.parseFloat(v)
  return Number.isFinite(n) ? n : fallback
}
const numbers = (v: string | undefined): number[] => (v ?? '').split(/[\s,;]+/).filter(x => x !== '').map(x => Number.parseFloat(x)).filter(Number.isFinite)
const ms = (v: string | undefined): number => (v === undefined ? 0 : v.endsWith('ms') ? num(v, 0) : num(v, 0) * 1000)

function decode(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, name: string) => {
    const lower = name.toLowerCase()
    if (lower.startsWith('#x')) return String.fromCodePoint(Number.parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(Number.parseInt(lower.slice(1), 10))
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[lower] ?? ''
  })
}

function timing(attrs: Record<string, string>): Timing {
  const count = attrs.repeatCount
  return {
    begin: ms(attrs.begin),
    dur: Math.max(0, ms(attrs.dur)),
    repeat: count === 'indefinite' ? Infinity : count === undefined ? 1 : Math.max(0, num(count, 1)),
    freeze: attrs.fill === 'freeze',
  }
}

function animation(tag: string, attrs: Record<string, string>, flag: (what: string) => undefined): Animation | undefined {
  if (tag === 'animate') {
    const attr = attrs.attributeName ?? ''
    if (!ANIMATED.has(attr)) return flag(`animate ${attr}`)
    const keyTimes = attrs.keyTimes === undefined ? undefined : numbers(attrs.keyTimes)
    return { kind: 'value', attr, values: numbers(attrs.values), keyTimes, ...timing(attrs) }
  }
  if (tag === 'animateMotion') {
    const m = /^M\s*(-?[\d.]+)[\s,]+(-?[\d.]+)\s*L\s*(-?[\d.]+)[\s,]+(-?[\d.]+)$/.exec((attrs.path ?? '').trim())
    if (m === null) return flag(`animateMotion path ${attrs.path}`)
    const [x1, y1, x2, y2] = m.slice(1).map(Number) as [number, number, number, number]
    return { kind: 'motion', from: { x: x1, y: y1 }, to: { x: x2, y: y2 }, ...timing(attrs) }
  }
  if (attrs.type !== 'rotate' || attrs.attributeName !== 'transform') return flag(`animateTransform ${attrs.type}`)
  return { kind: 'turn', from: numbers(attrs.from), to: numbers(attrs.to), ...timing(attrs) }
}

/** Reads a drawing made by drawMap. Anything it cannot paint lands in `unknown` and is otherwise left out. */
export function parseMap(svg: string): Scene {
  const scene: Scene = { width: 0, height: 0, shapes: [], unknown: [] }
  const flag = (what: string): undefined => {
    if (!scene.unknown.includes(what)) scene.unknown.push(what)
    return undefined
  }
  type Open = { tag: string; shape?: Shape; group?: Group; fill?: string }
  const stack: Open[] = []
  let inStyle = false

  for (const m of svg.matchAll(TOKEN)) {
    const [, closing, tag = '', rawAttrs = '', selfClosing, text] = m
    if (text !== undefined) {
      if (inStyle) continue
      const owner = [...stack].reverse().find(f => f.shape?.tag === 'text')?.shape
      const top = stack[stack.length - 1]
      if (owner !== undefined) owner.runs.push({ text: decode(text), fill: top?.tag === 'tspan' ? top.fill : undefined })
      continue
    }
    if (closing === '/') {
      if (tag === 'style') inStyle = false
      const at = stack.map(f => f.tag).lastIndexOf(tag)
      if (at >= 0) stack.length = at
      continue
    }

    const attrs: Record<string, string> = {}
    for (const [, name = '', value = ''] of rawAttrs.matchAll(ATTRIBUTE)) attrs[name] = value
    const known = KNOWN[tag]
    if (known === undefined) {
      flag(`<${tag}>`)
      continue
    }
    for (const name of Object.keys(attrs)) if (!known.includes(name)) flag(`${tag} ${name}`)
    // On an animation `fill` says whether it holds its last value, not a color.
    for (const name of tag.startsWith('animate') ? [] : COLORED) {
      const v = attrs[name]
      if (v !== undefined && v !== 'none' && colorOf(v) === undefined) flag(`${tag} ${name}=${v}`)
    }
    if (attrs.transform !== undefined && transformOf(attrs.transform) === undefined) flag(`transform ${attrs.transform}`)
    if (attrs['stroke-linecap'] !== undefined && !['butt', 'round'].includes(attrs['stroke-linecap'])) flag(`stroke-linecap ${attrs['stroke-linecap']}`)

    let pushed: Open | undefined
    switch (tag) {
      case 'svg': {
        const box = numbers(attrs.viewBox)
        scene.width = box[2] ?? num(attrs.width, 0)
        scene.height = box[3] ?? num(attrs.height, 0)
        pushed = { tag }
        break
      }
      case 'style':
        inStyle = selfClosing !== '/'
        break
      case 'g':
        pushed = { tag, group: { matrix: transformOf(attrs.transform) ?? IDENTITY, turns: [] } }
        break
      case 'tspan':
        pushed = { tag, ...(attrs.fill !== undefined ? { fill: attrs.fill } : {}) }
        break
      case 'animate':
      case 'animateMotion':
      case 'animateTransform': {
        const top = stack[stack.length - 1]
        const made = animation(tag, attrs, flag)
        if (made === undefined) break
        if (made.kind === 'turn') {
          if (top?.group !== undefined) top.group.turns.push(made)
          else flag('animateTransform outside a group')
        } else if (top?.shape !== undefined) top.shape.animations.push(made)
        else flag(`${tag} outside a shape`)
        break
      }
      default: {
        const shapeTag = tag as Shape['tag']
        if ((shapeTag === 'path' || shapeTag === 'ellipse') && (attrs.fill ?? 'black') !== 'none') flag(`${tag} filled`)
        if (shapeTag === 'text' && attrs.stroke !== undefined && attrs['paint-order'] !== 'stroke') flag('text stroked over its fill')
        const groups = stack.filter(f => f.group !== undefined).map(f => f.group as Group).reverse()
        const shape: Shape = { tag: shapeTag, attrs, animations: [], groups, runs: [] }
        if (shapeTag === 'path') shape.subs = pathOf(attrs.d ?? '', flag)
        scene.shapes.push(shape)
        pushed = { tag, shape }
      }
    }
    if (pushed !== undefined && selfClosing !== '/') stack.push(pushed)
  }
  // A later begin takes over from an earlier one; the sort keeps document order between equals.
  for (const shape of scene.shapes) shape.animations.sort((a, b) => a.begin - b.begin)
  return scene
}

// ---- outlines ------------------------------------------------------------------------------------

/** How finely curves are cut into straight pieces, in the drawing's own units. */
const STEP = 0.8

function cut(length: number): number {
  return Math.max(6, Math.min(96, Math.ceil(length / STEP)))
}

function arcTo(out: Point[], p0: Point, rxIn: number, ryIn: number, phiDeg: number, large: boolean, sweep: boolean, p1: Point): void {
  let rx = Math.abs(rxIn)
  let ry = Math.abs(ryIn)
  if (rx === 0 || ry === 0 || (p0.x === p1.x && p0.y === p1.y)) {
    out.push(p1)
    return
  }
  const phi = (phiDeg * Math.PI) / 180
  const cos = Math.cos(phi)
  const sin = Math.sin(phi)
  const dx = (p0.x - p1.x) / 2
  const dy = (p0.y - p1.y) / 2
  const x1 = cos * dx + sin * dy
  const y1 = -sin * dx + cos * dy
  const lambda = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry)
  if (lambda > 1) {
    rx *= Math.sqrt(lambda)
    ry *= Math.sqrt(lambda)
  }
  const top = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
  const bottom = rx * rx * y1 * y1 + ry * ry * x1 * x1
  let k = Math.sqrt(Math.max(0, top / bottom))
  if (large === sweep) k = -k
  const cxp = (k * rx * y1) / ry
  const cyp = (-k * ry * x1) / rx
  const cx = cos * cxp - sin * cyp + (p0.x + p1.x) / 2
  const cy = sin * cxp + cos * cyp + (p0.y + p1.y) / 2
  const angle = (ux: number, uy: number, vx: number, vy: number): number => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const start = angle(1, 0, (x1 - cxp) / rx, (y1 - cyp) / ry)
  let delta = angle((x1 - cxp) / rx, (y1 - cyp) / ry, (-x1 - cxp) / rx, (-y1 - cyp) / ry)
  if (!sweep && delta > 0) delta -= 2 * Math.PI
  else if (sweep && delta < 0) delta += 2 * Math.PI
  const n = cut(Math.abs(delta) * Math.max(rx, ry))
  for (let i = 1; i <= n; i++) {
    const a = start + (delta * i) / n
    const ex = rx * Math.cos(a)
    const ey = ry * Math.sin(a)
    out.push(i === n ? p1 : { x: cx + ex * cos - ey * sin, y: cy + ex * sin + ey * cos })
  }
}

function curveTo(out: Point[], pts: Point[]): void {
  let length = 0
  for (let i = 1; i < pts.length; i++) length += Math.hypot((pts[i] as Point).x - (pts[i - 1] as Point).x, (pts[i] as Point).y - (pts[i - 1] as Point).y)
  const n = cut(length)
  for (let i = 1; i <= n; i++) {
    const t = i / n
    const u = 1 - t
    if (pts.length === 3) {
      const [a, b, c] = pts as [Point, Point, Point]
      out.push({ x: u * u * a.x + 2 * u * t * b.x + t * t * c.x, y: u * u * a.y + 2 * u * t * b.y + t * t * c.y })
    } else {
      const [a, b, c, d] = pts as [Point, Point, Point, Point]
      out.push({
        x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
        y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
      })
    }
  }
}

const ARITY: Readonly<Record<string, number>> = { M: 2, L: 2, H: 1, V: 1, Q: 4, C: 6, S: 4, A: 7, Z: 0 }

/** A path's `d` as straight pieces: M L H V Q C S A Z, absolute and relative. */
function pathOf(d: string, flag: (what: string) => void): Sub[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? []
  const subs: Sub[] = []
  let current: Sub | undefined
  let at: Point = { x: 0, y: 0 }
  let start: Point = at
  let control: Point | undefined
  let i = 0
  let command = ''
  const take = (): number => Number(tokens[i++])
  while (i < tokens.length) {
    const token = tokens[i] as string
    if (/[a-zA-Z]/.test(token)) {
      command = token
      i++
      if (ARITY[command.toUpperCase()] === undefined) {
        flag(`path command ${command}`)
        return subs
      }
    } else if (command === '') {
      flag('path without a command')
      return subs
    }
    const upper = command.toUpperCase()
    const rel = command !== upper
    if (upper === 'Z') {
      if (current !== undefined) current.closed = true
      at = start
      current = undefined
      control = undefined
      continue
    }
    if (i + (ARITY[upper] as number) > tokens.length) break
    const ox = rel ? at.x : 0
    const oy = rel ? at.y : 0
    if (upper === 'M') {
      at = { x: ox + take(), y: oy + take() }
      start = at
      current = { points: [at], closed: false }
      subs.push(current)
      control = undefined
      command = rel ? 'l' : 'L'
      continue
    }
    if (current === undefined) {
      current = { points: [at], closed: false }
      subs.push(current)
    }
    const pts = current.points
    let nextControl: Point | undefined
    switch (upper) {
      case 'L':
        at = { x: ox + take(), y: oy + take() }
        pts.push(at)
        break
      case 'H':
        at = { x: ox + take(), y: at.y }
        pts.push(at)
        break
      case 'V':
        at = { x: at.x, y: oy + take() }
        pts.push(at)
        break
      case 'Q': {
        const c: Point = { x: ox + take(), y: oy + take() }
        const end: Point = { x: ox + take(), y: oy + take() }
        curveTo(pts, [at, c, end])
        at = end
        break
      }
      case 'C': {
        const c1: Point = { x: ox + take(), y: oy + take() }
        const c2: Point = { x: ox + take(), y: oy + take() }
        const end: Point = { x: ox + take(), y: oy + take() }
        curveTo(pts, [at, c1, c2, end])
        nextControl = c2
        at = end
        break
      }
      case 'S': {
        const c1: Point = control === undefined ? at : { x: 2 * at.x - control.x, y: 2 * at.y - control.y }
        const c2: Point = { x: ox + take(), y: oy + take() }
        const end: Point = { x: ox + take(), y: oy + take() }
        curveTo(pts, [at, c1, c2, end])
        nextControl = c2
        at = end
        break
      }
      case 'A': {
        const rx = take()
        const ry = take()
        const phi = take()
        const large = take() !== 0
        const sweep = take() !== 0
        const end: Point = { x: ox + take(), y: oy + take() }
        arcTo(pts, at, rx, ry, phi, large, sweep, end)
        at = end
        break
      }
    }
    control = nextControl
  }
  return subs
}

function ellipseOf(cx: number, cy: number, rx: number, ry: number): Sub {
  // As SVG has it: from three o'clock, the way the angle grows, which on a screen is clockwise.
  const n = Math.max(24, Math.min(360, Math.ceil((2 * Math.PI * Math.max(rx, ry)) / STEP)))
  const points: Point[] = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    points.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) })
  }
  return { points, closed: true }
}

const lengthOf = (sub: Sub): number => {
  let length = 0
  const pts = sub.closed ? [...sub.points, sub.points[0] as Point] : sub.points
  for (let i = 1; i < pts.length; i++) length += Math.hypot((pts[i] as Point).x - (pts[i - 1] as Point).x, (pts[i] as Point).y - (pts[i - 1] as Point).y)
  return length
}

/** The dashes of a dash pattern along each piece, as open pieces of their own. */
function dashed(subs: readonly Sub[], pattern: readonly number[], offset: number): Sub[] {
  const array = pattern.length % 2 === 1 ? [...pattern, ...pattern] : [...pattern]
  const period = array.reduce((a, b) => a + b, 0)
  if (array.length === 0 || period <= 0 || array.some(v => v < 0)) return [...subs]
  const out: Sub[] = []
  for (const sub of subs) {
    const pts = sub.closed ? [...sub.points, sub.points[0] as Point] : sub.points
    let phase = ((offset % period) + period) % period
    let index = 0
    while (phase >= (array[index] as number)) {
      phase -= array[index] as number
      index = (index + 1) % array.length
    }
    let left = (array[index] as number) - phase
    let isOn = index % 2 === 0
    let piece: Point[] | undefined = isOn ? [pts[0] as Point] : undefined
    let pieceLength = 0
    const close = (): void => {
      if (piece !== undefined && piece.length > 1 && pieceLength > 1e-3) out.push({ points: piece, closed: false })
      piece = undefined
      pieceLength = 0
    }
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1] as Point
      const b = pts[k] as Point
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      let done = 0
      while (length - done > left) {
        done += left
        const q: Point = { x: a.x + ((b.x - a.x) * done) / length, y: a.y + ((b.y - a.y) * done) / length }
        if (isOn) {
          piece?.push(q)
          pieceLength += left
          close()
        } else {
          piece = [q]
        }
        isOn = !isOn
        index = (index + 1) % array.length
        left = array[index] as number
      }
      left -= length - done
      if (isOn && piece !== undefined) {
        piece.push(b)
        pieceLength += length - done
      }
    }
    close()
  }
  return out
}

// ---- time ----------------------------------------------------------------------------------------

/** How far into its pass an animation is at `t`, 0 to 1; undefined when it does not apply. */
function progress(a: Timing, t: number): number | undefined {
  if (t < a.begin) return undefined
  const local = t - a.begin
  const total = a.repeat * a.dur
  if (local >= total || a.dur === 0) return a.freeze || a.dur === 0 ? 1 : undefined
  return (local % a.dur) / a.dur
}

function interpolate(values: readonly number[], keyTimes: readonly number[] | undefined, p: number): number {
  if (values.length === 0) return 0
  if (values.length === 1) return values[0] as number
  const n = values.length - 1
  if (keyTimes !== undefined && keyTimes.length === values.length) {
    for (let i = 0; i < n; i++) {
      const k0 = keyTimes[i] as number
      const k1 = keyTimes[i + 1] as number
      if (p <= k1 || i === n - 1) {
        const f = k1 > k0 ? Math.min(1, Math.max(0, (p - k0) / (k1 - k0))) : 1
        return (values[i] as number) + ((values[i + 1] as number) - (values[i] as number)) * f
      }
    }
  }
  const at = Math.min(p * n, n)
  const i = Math.min(Math.floor(at), n - 1)
  return (values[i] as number) + ((values[i + 1] as number) - (values[i] as number)) * (at - i)
}

/** An animated attribute's value at `t`: its own value until an animation applies, then the latest animation's. */
export function valueAt(shape: Shape, attr: string, base: number, t: number): number {
  let v = base
  for (const a of shape.animations) {
    if (a.kind !== 'value' || a.attr !== attr) continue
    const p = progress(a, t)
    if (p !== undefined) v = interpolate(a.values, a.keyTimes, p)
  }
  return v
}

/** The quickest the map is painted again, in ms: thirty frames a second. */
export const FASTEST_MS = 33

/** How long after a drawing is made its endless animations move smoothly while something runs: the core's breath, and the beat and the hands of what runs. */
export const ENDLESS_FOR_MS = 600_000
/** After that, the frame interval while something still runs: a task left for hours paints little. */
const ENDLESS_LATER_MS = 5000

/** How often the endless animations of a drawing `t` ms old may get a frame: only while something runs, freely for ten minutes, then every 5 s. */
export function endlessEvery(t: number, isBusy: boolean): number | undefined {
  if (!isBusy) return undefined
  return t < ENDLESS_FOR_MS ? FASTEST_MS : ENDLESS_LATER_MS
}

/** How often an animation of this length wants a frame: thirty a second for a pulse, a glow or a breath; rarely for the clock hands. */
const everyFor = (dur: number): number => (dur <= 10_000 ? FASTEST_MS : Math.min(10_000, Math.max(1000, dur / 60)))

/** How long until the drawing next looks different, in ms, or undefined if it never will. Endless animations count only given `endlessEvery`. */
export function nextChangeIn(scene: Scene, t: number, endlessEvery?: number): number | undefined {
  let soonest = Infinity
  for (const shape of scene.shapes) {
    for (const a of [...shape.animations, ...shape.groups.flatMap(g => g.turns)]) {
      const isEndless = a.repeat === Infinity
      if (isEndless && endlessEvery === undefined) continue
      if (t < a.begin) soonest = Math.min(soonest, a.begin - t)
      else if (t < a.begin + a.repeat * a.dur) soonest = Math.min(soonest, isEndless ? Math.max(endlessEvery ?? 0, everyFor(a.dur)) : everyFor(a.dur))
    }
  }
  return soonest === Infinity ? undefined : Math.max(FASTEST_MS, soonest)
}

// ---- paint ---------------------------------------------------------------------------------------

type Rgb = [number, number, number]

function colorOf(v: string | undefined): Rgb | undefined {
  const hex = /^#(?:([0-9a-f]{3})|([0-9a-f]{6}))$/i.exec(v ?? '')
  if (hex === null) return undefined
  const full = hex[1] !== undefined ? [...hex[1]].map(c => c + c).join('') : (hex[2] as string)
  return [Number.parseInt(full.slice(0, 2), 16), Number.parseInt(full.slice(2, 4), 16), Number.parseInt(full.slice(4, 6), 16)]
}

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function rotation(degrees: number, cx: number, cy: number): Matrix {
  const a = (degrees * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  return [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]
}

function transformOf(v: string | undefined): Matrix | undefined {
  let m = IDENTITY
  if (v === undefined) return m
  const rest = v.replace(/(translate|rotate)\(([^)]*)\)/g, (_, kind: string, args: string) => {
    const n = numbers(args)
    const next: Matrix = kind === 'translate' ? [1, 0, 0, 1, n[0] ?? 0, n[1] ?? 0] : rotation(n[0] ?? 0, n[1] ?? 0, n[2] ?? 0)
    m = [
      m[0] * next[0] + m[2] * next[1],
      m[1] * next[0] + m[3] * next[1],
      m[0] * next[2] + m[2] * next[3],
      m[1] * next[2] + m[3] * next[3],
      m[0] * next[4] + m[2] * next[5] + m[4],
      m[1] * next[4] + m[3] * next[5] + m[5],
    ]
    return ''
  })
  return rest.trim() === '' ? m : undefined
}

class Canvas {
  readonly width: number
  readonly height: number
  readonly rgba: Uint8ClampedArray
  /** Coverage of the shape being painted, 0 to 1, composited and cleared once the shape is whole. */
  readonly mask: Float32Array
  private x0 = 0
  private y0 = 0
  private x1 = -1
  private y1 = -1

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    this.rgba = new Uint8ClampedArray(width * height * 4)
    this.mask = new Float32Array(width * height)
  }

  /** Widens the area the mask covers and answers the part of the box that lies on the canvas. */
  touch(xa: number, ya: number, xb: number, yb: number): [number, number, number, number] {
    const x0 = Math.max(0, Math.floor(xa))
    const y0 = Math.max(0, Math.floor(ya))
    const x1 = Math.min(this.width - 1, Math.ceil(xb))
    const y1 = Math.min(this.height - 1, Math.ceil(yb))
    if (x0 <= x1 && y0 <= y1) {
      if (this.x1 < this.x0) [this.x0, this.y0, this.x1, this.y1] = [x0, y0, x1, y1]
      else {
        this.x0 = Math.min(this.x0, x0)
        this.y0 = Math.min(this.y0, y0)
        this.x1 = Math.max(this.x1, x1)
        this.y1 = Math.max(this.y1, y1)
      }
    }
    return [x0, y0, x1, y1]
  }

  /** Lays one color over the canvas through the mask, then clears the mask. */
  composite([r, g, b]: Rgb, opacity: number): void {
    const { mask, rgba, width } = this
    for (let y = this.y0; y <= this.y1; y++) {
      for (let x = this.x0; x <= this.x1; x++) {
        const i = y * width + x
        const c = mask[i] as number
        if (c <= 0) continue
        mask[i] = 0
        blend(rgba, i * 4, r, g, b, c * opacity)
      }
    }
    this.x1 = this.x0 - 1
    this.y1 = this.y0 - 1
  }
}

/** Source over, with straight alpha, so that a map without its ground keeps clean edges. */
function blend(rgba: Uint8ClampedArray, j: number, r: number, g: number, b: number, a: number): void {
  if (a <= 0) return
  const da = (rgba[j + 3] as number) / 255
  const keep = da * (1 - a)
  const oa = a + keep
  rgba[j] = (r * a + (rgba[j] as number) * keep) / oa
  rgba[j + 1] = (g * a + (rgba[j + 1] as number) * keep) / oa
  rgba[j + 2] = (b * a + (rgba[j + 2] as number) * keep) / oa
  rgba[j + 3] = oa * 255
}

function fillDisk(cv: Canvas, cx: number, cy: number, r: number): void {
  const [x0, y0, x1, y1] = cv.touch(cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1)
  const { mask, width } = cv
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = Math.min(1, r + 0.5 - Math.hypot(x + 0.5 - cx, y + 0.5 - cy))
      const i = y * width + x
      if (c > (mask[i] as number)) mask[i] = c
    }
  }
}

function strokeRing(cv: Canvas, cx: number, cy: number, r: number, half: number): void {
  const reach = r + half + 1
  const [x0, y0, x1, y1] = cv.touch(cx - reach, cy - reach, cx + reach, cy + reach)
  const { mask, width } = cv
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = Math.min(1, half + 0.5 - Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r))
      const i = y * width + x
      if (c > (mask[i] as number)) mask[i] = c
    }
  }
}

function fillRoundRect(cv: Canvas, x: number, y: number, w: number, h: number, radius: number): void {
  const [x0, y0, x1, y1] = cv.touch(x - 1, y - 1, x + w + 1, y + h + 1)
  const { mask, width } = cv
  const rr = Math.min(radius, w / 2, h / 2)
  const cx = x + w / 2
  const cy = y + h / 2
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const qx = Math.abs(px + 0.5 - cx) - (w / 2 - rr)
      const qy = Math.abs(py + 0.5 - cy) - (h / 2 - rr)
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rr
      const c = Math.min(1, 0.5 - d)
      const i = py * width + px
      if (c > (mask[i] as number)) mask[i] = c
    }
  }
}

/** One straight piece of a stroke: a round end where `roundA`/`roundB` say (a cap or a join), else a flat one. */
function strokeSegment(cv: Canvas, ax: number, ay: number, bx: number, by: number, half: number, roundA: boolean, roundB: boolean): void {
  const pad = half + 1
  const [x0, y0, x1, y1] = cv.touch(Math.min(ax, bx) - pad, Math.min(ay, by) - pad, Math.max(ax, bx) + pad, Math.max(ay, by) + pad)
  const { mask, width } = cv
  const dx = bx - ax
  const dy = by - ay
  const length = Math.hypot(dx, dy)
  const ux = length > 0 ? dx / length : 1
  const uy = length > 0 ? dy / length : 0
  const reach = half + 0.5
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5
      const rx = px - ax
      const ry = py - ay
      const along = rx * ux + ry * uy
      let c: number
      if (along < 0 && roundA) c = reach - Math.hypot(rx, ry)
      else if (along > length && roundB) c = reach - Math.hypot(px - bx, py - by)
      else {
        c = reach - Math.abs(rx * uy - ry * ux)
        if (!roundA) c = Math.min(c, along + 0.5)
        if (!roundB) c = Math.min(c, length - along + 0.5)
      }
      if (c <= 0) continue
      const i = y * width + x
      if (c > 1) c = 1
      if (c > (mask[i] as number)) mask[i] = c
    }
  }
}

function strokeSubs(cv: Canvas, subs: readonly Sub[], half: number, roundCaps: boolean): void {
  for (const sub of subs) {
    const pts = sub.closed ? [...sub.points, sub.points[0] as Point] : sub.points
    if (pts.length === 1) {
      const p = pts[0] as Point
      if (roundCaps) strokeSegment(cv, p.x, p.y, p.x, p.y, half, true, true)
      continue
    }
    const last = pts.length - 2
    for (let k = 0; k <= last; k++) {
      const a = pts[k] as Point
      const b = pts[k + 1] as Point
      strokeSegment(cv, a.x, a.y, b.x, b.y, half, k > 0 || sub.closed || roundCaps, k < last || sub.closed || roundCaps)
    }
  }
}

/** Where a point of the shape lands on the canvas at `t`: its transform, its flight, the groups it sits in, then the scale. */
function placer(shape: Shape, t: number, scale: number): (p: Point) => Point {
  const m = transformOf(shape.attrs.transform) ?? IDENTITY
  let mx = 0
  let my = 0
  for (const a of shape.animations) {
    if (a.kind !== 'motion') continue
    const p = progress(a, t)
    if (p === undefined) continue
    mx = a.from.x + (a.to.x - a.from.x) * p
    my = a.from.y + (a.to.y - a.from.y) * p
  }
  // Each group, innermost first: its turn while one runs, else its own transform.
  const around = shape.groups.map(g => turnOf(g.turns, t) ?? g.matrix)
  return p => {
    let x = m[0] * p.x + m[2] * p.y + m[4] + mx
    let y = m[1] * p.x + m[3] * p.y + m[5] + my
    for (const g of around) {
      const gx = g[0] * x + g[2] * y + g[4]
      y = g[1] * x + g[3] * y + g[5]
      x = gx
    }
    return { x: x * scale, y: y * scale }
  }
}

/** The rotation a group's turns give it at `t`, the last running one winning; undefined while none runs. */
function turnOf(turns: readonly Animation[], t: number): Matrix | undefined {
  let turn: Matrix | undefined
  for (const a of turns) {
    if (a.kind !== 'turn') continue
    const p = progress(a, t)
    if (p === undefined) continue
    const lerp = (k: number): number => (a.from[k] ?? 0) + ((a.to[k] ?? a.from[k] ?? 0) - (a.from[k] ?? 0)) * p
    turn = rotation(lerp(0), lerp(1), lerp(2))
  }
  return turn
}

function paintShape(cv: Canvas, shape: Shape, t: number, scale: number): void {
  const a = shape.attrs
  const opacity = Math.min(1, Math.max(0, valueAt(shape, 'opacity', num(a.opacity, 1), t)))
  if (opacity < 0.004) return
  const place = placer(shape, t, scale)
  if (shape.tag === 'text') {
    paintText(cv, shape, place, scale, opacity)
    return
  }
  const fill = shape.tag === 'line' ? undefined : colorOf(a.fill ?? '#000000')
  const stroke = colorOf(a.stroke)
  const half = (num(a['stroke-width'], 1) * scale) / 2

  if (shape.tag === 'rect') {
    if (fill === undefined) return
    const at = place({ x: num(a.x, 0), y: num(a.y, 0) })
    fillRoundRect(cv, at.x, at.y, num(a.width, 0) * scale, num(a.height, 0) * scale, num(a.rx, 0) * scale)
    cv.composite(fill, opacity)
    return
  }

  let outline: Sub[]
  if (shape.tag === 'circle') {
    const r = Math.max(0, valueAt(shape, 'r', num(a.r, 0), t))
    const c = { x: num(a.cx, 0), y: num(a.cy, 0) }
    const at = place(c)
    if (fill !== undefined) {
      fillDisk(cv, at.x, at.y, r * scale)
      cv.composite(fill, opacity)
    }
    if (stroke === undefined) return
    if (a['stroke-dasharray'] === undefined) {
      strokeRing(cv, at.x, at.y, r * scale, half)
      cv.composite(stroke, opacity)
      return
    }
    outline = [ellipseOf(c.x, c.y, r, r)]
  } else if (shape.tag === 'ellipse') {
    if (stroke === undefined) return
    outline = [ellipseOf(num(a.cx, 0), num(a.cy, 0), num(a.rx, 0), num(a.ry, 0))]
  } else if (shape.tag === 'line') {
    if (stroke === undefined) return
    outline = [{ points: [{ x: num(a.x1, 0), y: num(a.y1, 0) }, { x: num(a.x2, 0), y: num(a.y2, 0) }], closed: false }]
  } else {
    if (stroke === undefined) return
    outline = shape.subs ?? []
  }

  const pattern = numbers(a['stroke-dasharray'])
  if (pattern.length > 0) {
    // A pattern written against pathLength is stretched to the outline's real length.
    const real = outline.reduce((sum, sub) => sum + lengthOf(sub), 0)
    const k = a.pathLength !== undefined && num(a.pathLength, 0) > 0 && real > 0 ? real / num(a.pathLength, 1) : 1
    outline = dashed(outline, pattern.map(v => v * k), valueAt(shape, 'stroke-dashoffset', num(a['stroke-dashoffset'], 0), t) * k)
  }
  const placed = outline.map(sub => ({ points: sub.points.map(place), closed: sub.closed }))
  strokeSubs(cv, placed, half, a['stroke-linecap'] === 'round')
  cv.composite(stroke, opacity)
}

// ---- words -----------------------------------------------------------------------------------------

type Glyphs = { font: BitmapFont; bytes: Uint8Array; perRow: number; index: Map<number, number> }
const glyphCache = new Map<BitmapFont, Glyphs>()

function glyphsOf(font: BitmapFont): Glyphs {
  let glyphs = glyphCache.get(font)
  if (glyphs === undefined) {
    const index = new Map<number, number>()
    let k = 0
    for (const ch of font.chars) index.set(ch.codePointAt(0) as number, k++)
    glyphs = { font, bytes: fromBase64(font.bits), perRow: Math.ceil(font.width / 8), index }
    glyphCache.set(font, glyphs)
  }
  return glyphs
}

/** Whether a character has a glyph of its own in every size; one that has not is drawn as an empty box. */
export function hasGlyph(ch: string): boolean {
  const cp = ch.codePointAt(0) as number
  return FONTS.every(f => glyphsOf(f).index.has(cp))
}

/** One pixel of a glyph; `g` -1 is the empty box that stands for a character the font does not have. */
function bit(glyphs: Glyphs, g: number, x: number, y: number): number {
  const { width, height, ascent } = glyphs.font
  if (x < 0 || y < 0 || x >= width || y >= height) return 0
  if (g < 0) {
    const top = Math.max(1, height - ascent - 1)
    return ((x === 1 || x === width - 2) && y >= top && y <= ascent) || ((y === top || y === ascent) && x >= 1 && x <= width - 2) ? 1 : 0
  }
  return ((glyphs.bytes[(g * height + y) * glyphs.perRow + (x >> 3)] as number) >> (7 - (x & 7))) & 1
}

/** The bitmap size nearest the wanted pixel height, drawn as it is when that is near enough and scaled otherwise. */
function fontFor(px: number): { glyphs: Glyphs; k: number } {
  let best = FONTS[0] as BitmapFont
  for (const f of FONTS) if (Math.abs(f.height - px) < Math.abs(best.height - px)) best = f
  return { glyphs: glyphsOf(best), k: Math.abs(best.height - px) <= 1.5 ? 1 : px / best.height }
}

/** A glyph's coverage over the box at (gx, gy), scaled by k: each canvas pixel takes the share of glyph pixels under it. */
function stamp(glyphs: Glyphs, g: number, gx: number, gy: number, k: number, ink: Float32Array, owner: Uint16Array, bw: number, bh: number, who: number): void {
  const { width, height } = glyphs.font
  const x0 = Math.max(0, Math.floor(gx))
  const y0 = Math.max(0, Math.floor(gy))
  const x1 = Math.min(bw, Math.ceil(gx + width * k))
  const y1 = Math.min(bh, Math.ceil(gy + height * k))
  for (let ty = y0; ty < y1; ty++) {
    const v0 = (ty - gy) / k
    const v1 = (ty + 1 - gy) / k
    for (let tx = x0; tx < x1; tx++) {
      const u0 = (tx - gx) / k
      const u1 = (tx + 1 - gx) / k
      let sum = 0
      for (let sy = Math.floor(v0); sy < v1; sy++) {
        const oy = Math.min(v1, sy + 1) - Math.max(v0, sy)
        if (oy <= 0) continue
        for (let sx = Math.floor(u0); sx < u1; sx++) {
          const ox = Math.min(u1, sx + 1) - Math.max(u0, sx)
          if (ox > 0 && bit(glyphs, g, sx, sy) === 1) sum += ox * oy
        }
      }
      const c = sum / ((u1 - u0) * (v1 - v0))
      const i = ty * bw + tx
      if (c > (ink[i] as number)) {
        ink[i] = Math.min(1, c)
        owner[i] = who
      }
    }
  }
}

function paintText(cv: Canvas, shape: Shape, place: (p: Point) => Point, scale: number, opacity: number): void {
  const a = shape.attrs
  const base = colorOf(a.fill ?? '#000000')
  const chars: { cp: number; fill: Rgb | undefined }[] = []
  for (const run of shape.runs) {
    const fill = run.fill !== undefined ? colorOf(run.fill) : base
    for (const ch of run.text) chars.push({ cp: ch.codePointAt(0) as number, fill })
  }
  if (chars.length === 0) return

  const { glyphs, k } = fontFor(num(a['font-size'], 16) * scale)
  const isBold = a['font-weight'] === 'bold' || num(a['font-weight'], 400) >= 600
  const boldFont = isBold ? BOLD.find(f => f.height === glyphs.font.height) : undefined
  const bold = boldFont === undefined ? undefined : glyphsOf(boldFont)
  const spacing = num(a['letter-spacing'], 0) * scale
  const advance = glyphs.font.width * k
  const total = chars.length * advance + (chars.length - 1) * spacing
  const at = place({ x: num(a.x, 0), y: num(a.y, 0) })
  const anchor = a['text-anchor'] ?? 'start'
  const left = at.x - (anchor === 'middle' ? total / 2 : anchor === 'end' ? total : 0)
  const top = at.y - glyphs.font.ascent * k
  const rim = a['paint-order'] === 'stroke' && colorOf(a.stroke) !== undefined ? (num(a['stroke-width'], 1) * scale) / 2 : 0

  const pad = Math.ceil(rim) + 2
  const ox = Math.floor(left) - pad
  const oy = Math.floor(top) - pad
  const bw = Math.ceil(total) + 2 * pad + 3
  const bh = Math.ceil(glyphs.font.height * k) + 2 * pad + 2
  const ink = new Float32Array(bw * bh)
  const owner = new Uint16Array(bw * bh)
  chars.forEach((ch, i) => {
    let gx = left + i * (advance + spacing) - ox
    let gy = top - oy
    if (k === 1) {
      gx = Math.round(gx)
      gy = Math.round(gy)
    }
    const own = bold?.index.get(ch.cp)
    if (bold !== undefined && own !== undefined) stamp(bold, own, gx, gy, k, ink, owner, bw, bh, i)
    else {
      const g = glyphs.index.get(ch.cp) ?? -1
      stamp(glyphs, g, gx, gy, k, ink, owner, bw, bh, i)
      // A weight the bitmaps do not have is struck twice, a pixel apart.
      if (isBold) stamp(glyphs, g, gx + 1, gy, k, ink, owner, bw, bh, i)
    }
  })

  const tint = (cover: Float32Array, colorAt: (i: number) => Rgb | undefined): void => {
    for (let y = 0; y < bh; y++) {
      const cy = oy + y
      if (cy < 0 || cy >= cv.height) continue
      for (let x = 0; x < bw; x++) {
        const cx = ox + x
        if (cx < 0 || cx >= cv.width) continue
        const i = y * bw + x
        const c = cover[i] as number
        if (c <= 0) continue
        const color = colorAt(i)
        if (color !== undefined) blend(cv.rgba, (cy * cv.width + cx) * 4, color[0], color[1], color[2], c * opacity)
      }
    }
  }
  // The rim goes under the words, in the ground's color, so a line passing behind them never strikes them through.
  if (rim > 0) {
    const halo = dilate(ink, bw, bh, rim)
    const color = colorOf(a.stroke)
    tint(halo, () => color)
  }
  tint(ink, i => chars[owner[i] as number]?.fill)
}

function dilate(ink: Float32Array, bw: number, bh: number, r: number): Float32Array {
  const out = new Float32Array(ink.length)
  const reach = Math.ceil(r + 0.5)
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const c = ink[y * bw + x] as number
      if (c < 0.02) continue
      for (let dy = -reach; dy <= reach; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= bh) continue
        for (let dx = -reach; dx <= reach; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= bw) continue
          const w = Math.min(1, r + 0.5 - Math.hypot(dx, dy))
          if (w <= 0) continue
          const j = yy * bw + xx
          const v = c * w
          if (v > (out[j] as number)) out[j] = v
        }
      }
    }
  }
  return out
}

// ---- frames ----------------------------------------------------------------------------------------

export type Frame = { width: number; height: number; rgba: Uint8Array }

let canvas: Canvas | undefined

/** The largest scale at which the drawing still fits an Image, never above `wanted`. */
export function scaleFor(scene: Scene, wanted: number): number {
  const area = Math.max(1, scene.width * scene.height * 4)
  return Math.min(wanted, Math.floor(Math.sqrt(MAX_IMAGE_BYTES / area) * 100) / 100)
}

/** A run of still shapes painted once, kept as the stretches of each row it covers. */
type Layer = {
  /** Each covered stretch as its first pixel's index and its length, row by row. */
  spans: Int32Array
  /** The stretches' RGBA, one after another. */
  pixels: Uint8ClampedArray
}

/**
 * How a drawing is painted frame after frame. Most of what it draws never moves and costs most of the painting;
 * that is painted once, here, and each frame lays it down between the shapes that move.
 */
type Plan = {
  scene: Scene
  scale: number
  /** The still shapes the drawing begins with, its whole picture so far: copied in, not laid down. */
  base: Uint8ClampedArray | undefined
  steps: ({ layer: Layer } | { shapes: Shape[] })[]
}

let plan: Plan | undefined

const isStill = (shape: Shape): boolean => shape.animations.length === 0 && shape.groups.every(g => g.turns.length === 0)

function layerOf(rgba: Uint8ClampedArray, width: number): Layer {
  const spans: number[] = []
  let covered = 0
  for (let row = 0; row < rgba.length / 4; row += width) {
    for (let x = 0; x < width; ) {
      while (x < width && rgba[(row + x) * 4 + 3] === 0) x++
      const start = x
      while (x < width && rgba[(row + x) * 4 + 3] !== 0) x++
      if (x > start) {
        spans.push(row + start, x - start)
        covered += x - start
      }
    }
  }
  const pixels = new Uint8ClampedArray(covered * 4)
  let o = 0
  for (let k = 0; k < spans.length; k += 2) {
    const from = (spans[k] as number) * 4
    const n = (spans[k + 1] as number) * 4
    pixels.set(rgba.subarray(from, from + n), o)
    o += n
  }
  return { spans: Int32Array.from(spans), pixels }
}

function lay(rgba: Uint8ClampedArray, { spans, pixels }: Layer): void {
  let o = 0
  for (let k = 0; k < spans.length; k += 2) {
    let j = (spans[k] as number) * 4
    const end = j + (spans[k + 1] as number) * 4
    for (; j < end; j += 4, o += 4) {
      const a = pixels[o + 3] as number
      if (a === 255) {
        rgba[j] = pixels[o] as number
        rgba[j + 1] = pixels[o + 1] as number
        rgba[j + 2] = pixels[o + 2] as number
        rgba[j + 3] = 255
      } else blend(rgba, j, pixels[o] as number, pixels[o + 1] as number, pixels[o + 2] as number, a / 255)
    }
  }
}

function planFor(scene: Scene, scale: number, cv: Canvas): Plan {
  const runs: { isStill: boolean; shapes: Shape[] }[] = []
  for (const shape of scene.shapes) {
    const last = runs[runs.length - 1]
    if (last !== undefined && last.isStill === isStill(shape)) last.shapes.push(shape)
    else runs.push({ isStill: isStill(shape), shapes: [shape] })
  }
  const next: Plan = { scene, scale, base: undefined, steps: [] }
  for (const [k, run] of runs.entries()) {
    if (!run.isStill) {
      next.steps.push({ shapes: run.shapes })
      continue
    }
    cv.rgba.fill(0)
    for (const shape of run.shapes) paintShape(cv, shape, 0, scale)
    if (k === 0) next.base = cv.rgba.slice()
    else next.steps.push({ layer: layerOf(cv.rgba, cv.width) })
  }
  return next
}

/**
 * The drawing as it looks `t` ms after it was made, at `scale` pixels to its unit.
 * The frame's pixels are reused by the next paint: send or copy them first.
 */
export function paint(scene: Scene, t: number, scale: number): Frame {
  const width = Math.max(1, Math.round(scene.width * scale))
  const height = Math.max(1, Math.round(scene.height * scale))
  if (canvas === undefined || canvas.width !== width || canvas.height !== height) canvas = new Canvas(width, height)
  if (plan === undefined || plan.scene !== scene || plan.scale !== scale) plan = planFor(scene, scale, canvas)
  if (plan.base !== undefined) canvas.rgba.set(plan.base)
  else canvas.rgba.fill(0)
  for (const step of plan.steps) {
    if ('layer' in step) lay(canvas.rgba, step.layer)
    else for (const shape of step.shapes) paintShape(canvas, shape, t, scale)
  }
  return { width, height, rgba: new Uint8Array(canvas.rgba.buffer, canvas.rgba.byteOffset, canvas.rgba.byteLength) }
}

export type ImageBytes = { png: string } | { rgba: string; width: number; height: number }

/** A frame as an Image takes it: a PNG, some ten times smaller on the map's flat colours, or the raw pixels if that is not smaller. */
export function imageSource(frame: Frame): ImageBytes {
  const file = toPng(frame)
  return file.length < Math.min(frame.rgba.length, MAX_IMAGE_BYTES)
    ? { png: toBase64(file) }
    : { rgba: toBase64(frame.rgba), width: frame.width, height: frame.height }
}

// ---- PNG, deflated here: the environment has no zlib -----------------------------------------------
//
// One block of deflate's fixed codes, with repeats looked for a whole pixel at a time, in two places only:
// the pixel to the left and the one a row up. The map is flat colour around soft edges, so that finds most
// of what a full search would, in a few milliseconds a frame.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]
/** How far back deflate may reach. */
const WINDOW = 32_768

function reversed(value: number, bits: number): number {
  let r = 0
  for (let i = 0; i < bits; i++, value >>= 1) r = (r << 1) | (value & 1)
  return r
}

/** Each literal and length symbol's fixed code, bit-reversed as deflate sends it, and its length in bits. */
const LITERAL_CODE = new Uint16Array(288)
const LITERAL_BITS = new Uint8Array(288)
for (let s = 0; s < 288; s++) {
  const [code, bits] = s < 144 ? [0x30 + s, 8] : s < 256 ? [0x190 + s - 144, 9] : s < 280 ? [s - 256, 7] : [0xc0 + s - 280, 8]
  LITERAL_CODE[s] = reversed(code, bits)
  LITERAL_BITS[s] = bits
}

/** The length code of each match length from 3 to 258. */
const LENGTH_CODE = new Uint8Array(259)
for (let c = 0; c < LENGTH_BASE.length; c++) {
  const end = c === LENGTH_BASE.length - 1 ? 259 : (LENGTH_BASE[c + 1] as number)
  for (let l = LENGTH_BASE[c] as number; l < end; l++) LENGTH_CODE[l] = c
}

/** Bits written least significant first, as deflate packs them. */
class Bits {
  bytes = new Uint8Array(1 << 16)
  length = 0
  private acc = 0
  private count = 0

  put(value: number, bits: number): void {
    this.acc |= value << this.count
    this.count += bits
    while (this.count >= 8) {
      if (this.length === this.bytes.length) {
        const grown = new Uint8Array(this.bytes.length * 2)
        grown.set(this.bytes)
        this.bytes = grown
      }
      this.bytes[this.length++] = this.acc & 255
      this.acc >>>= 8
      this.count -= 8
    }
  }

  /** The bytes, the last one padded out. */
  done(): Uint8Array {
    if (this.count > 0) this.put(0, 8 - this.count)
    return this.bytes.subarray(0, this.length)
  }
}

/** A repeat `d` bytes back as deflate sends it: its code, bit-reversed, then its extra bits. */
function distanceOf(d: number): { code: number; extra: number; bits: number } {
  let c = 0
  while (c < DISTANCE_BASE.length - 1 && (DISTANCE_BASE[c + 1] as number) <= d) c++
  return { code: reversed(c, 5), extra: d - (DISTANCE_BASE[c] as number), bits: DISTANCE_EXTRA[c] as number }
}

/** The frame's rows, each behind its filter byte (0, none), deflated in one block of fixed codes. */
function deflate({ width, height, rgba }: Frame): Uint8Array {
  // A frame from `paint` starts on a four-byte boundary, so its pixels can be compared whole.
  const pixels = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height)
  const row = width * 4 + 1
  const left = distanceOf(4)
  const up = distanceOf(row)
  const out = new Bits()
  const symbol = (s: number): void => out.put(LITERAL_CODE[s] as number, LITERAL_BITS[s] as number)
  out.put(1, 1) // the last block
  out.put(1, 2) // of fixed codes
  for (let y = 0; y < height; y++) {
    symbol(0) // the row's filter byte
    const start = y * width
    const end = start + width
    for (let p = start; p < end; ) {
      // At most 64 pixels, as many whole pixels as deflate's longest repeat holds, and never past the row's end.
      const most = Math.min(64, end - p)
      let l = 0
      if (p > start) while (l < most && pixels[p + l] === pixels[p + l - 1]) l++
      let u = 0
      if (y > 0 && row <= WINDOW && l < most) while (u < most && pixels[p + u] === pixels[p + u - width]) u++
      if (l === 0 && u === 0) {
        for (let j = p * 4; j < p * 4 + 4; j++) symbol(rgba[j] as number)
        p++
        continue
      }
      const n = Math.max(l, u)
      const back = l >= u ? left : up
      const c = LENGTH_CODE[n * 4] as number
      symbol(257 + c)
      out.put(n * 4 - (LENGTH_BASE[c] as number), LENGTH_EXTRA[c] as number)
      out.put(back.code, 5)
      out.put(back.extra, back.bits)
      p += n
    }
  }
  symbol(256) // the block's end
  return out.done()
}

const CRC_TABLE = new Uint32Array(256)
for (let n = 0; n < 256; n++) {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c >>> 0
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = (CRC_TABLE[(c ^ (bytes[i] as number)) & 255] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** zlib's checksum of the frame's rows as the PNG holds them, each behind its filter byte. */
function adler32({ width, rgba }: Frame): number {
  let a = 1
  let b = 0
  // Reduced a row at a time: JavaScript's numbers hold the sums exactly for far longer than a row.
  for (let start = 0; start < rgba.length; start += width * 4) {
    b += a // the filter byte, 0
    for (let i = start; i < start + width * 4; i++) {
      a += rgba[i] as number
      b += a
    }
    a %= 65521
    b %= 65521
  }
  return ((b << 16) | a) >>> 0
}

/** The frame as a whole PNG file: RGBA at eight bits a channel, rows unfiltered. */
function toPng(frame: Frame): Uint8Array {
  const { width, height } = frame
  const deflated = deflate(frame)

  const chunks: Uint8Array[] = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])]
  const chunk = (type: string, data: Uint8Array): void => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    for (let k = 0; k < 4; k++) out[4 + k] = type.charCodeAt(k)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    chunks.push(out)
  }
  const header = new Uint8Array(13)
  const headerView = new DataView(header.buffer)
  headerView.setUint32(0, width)
  headerView.setUint32(4, height)
  header.set([8, 6, 0, 0, 0], 8) // 8 bits a channel, RGBA, deflate, filtered by row, not interlaced
  chunk('IHDR', header)
  const z = new Uint8Array(deflated.length + 6)
  z.set([0x78, 0x01]) // zlib: deflate with a 32K window, no dictionary
  z.set(deflated, 2)
  new DataView(z.buffer).setUint32(2 + deflated.length, adler32(frame))
  chunk('IDAT', z)
  chunk('IEND', new Uint8Array(0))

  const file = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let at = 0
  for (const c of chunks) {
    file.set(c, at)
    at += c.length
  }
  return file
}

// ---- base64 ---------------------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

export const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), c => c.charCodeAt(0))
