// The map's colors: the dark and the light palette, the rules that turn one into the other, and the names a person writes for them.

export type Palette = {
  ground: string
  raised: string
  line: string
  spoke: string
  bone: string
  ash: string
  dim: string
  accent: string
  hot: string
  red: string
  mem: string
  memHot: string
  /** The route between stations: as light as the words on a dark ground, a soft grey on a light one, where a thin dark line weighs much more. */
  trail: string
}

export const DARK: Palette = {
  ground: '#0a0c11',
  raised: '#12151c',
  line: '#272c36',
  spoke: '#1a1e27',
  bone: '#ebe6dc',
  ash: '#9ba1ab',
  dim: '#6b7280',
  accent: '#e1ac6e',
  hot: '#f0c595',
  red: '#e8654f',
  mem: '#62c7ba',
  memHot: '#a5e6dc',
  // One step away from `bone`, so that the light rules can give the route a color of its own.
  trail: '#ebe6dd',
}

export const LIGHT: Palette = {
  ground: '#f5f2ea',
  raised: '#ffffff',
  line: '#cfc9bc',
  spoke: '#e3ded2',
  bone: '#1f2228',
  ash: '#5f6570',
  dim: '#8b909a',
  accent: '#b8762a',
  hot: '#8f560f',
  red: '#c5402b',
  mem: '#1c8c81',
  memHot: '#136a62',
  trail: '#9c978b',
}

/**
 * For `auto`: the drawing is made in the dark palette, and these rules repaint it where the surface around it is light.
 * Every color on the map is one of the palette's, written as a plain attribute, so a rule per color reaches all of it;
 * a surface that drops the rules shows the dark map, whole.
 */
export const lightRules = (own: Partial<Palette> = {}): string =>
  `<style>@media (prefers-color-scheme: light){${(Object.keys(DARK) as (keyof Palette)[])
    // A color the person set stays as it is, and so does anything that shares its value with one.
    .filter(k => own[k] === undefined && !Object.values(own).includes(DARK[k]))
    .map(k => `[fill="${DARK[k]}"]{fill:${LIGHT[k]}}[stroke="${DARK[k]}"]{stroke:${LIGHT[k]}}`)
    .join('')}}</style>`

/** The names a person writes for the places of the palette. */
export const COLOR_NAMES: Record<string, keyof Palette> = {
  background: 'ground',
  node: 'raised',
  line: 'line',
  spoke: 'spoke',
  text: 'bone',
  label: 'ash',
  faint: 'dim',
  accent: 'accent',
  active: 'hot',
  error: 'red',
  memory: 'mem',
  memoryActive: 'memHot',
  route: 'trail',
}
