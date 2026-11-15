// Colour arithmetic shared by the drawings. Every value a drawing uses is an explicit hex:
// nothing leans on opacity to make a colour.

const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))

/** A colour between two, `t` of the way from `a` to `b`. */
export function mix(a, b, t) {
  const [x, y] = [rgb(a), rgb(b)]
  const k = Math.max(0, Math.min(1, t))
  return `#${x.map((v, i) => Math.round(v + (y[i] - v) * k).toString(16).padStart(2, '0')).join('')}`
}
