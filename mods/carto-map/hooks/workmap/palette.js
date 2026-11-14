// The map's colors: the dark and the light palette, the rules that turn one into the other, and the names a person writes for them.

// Every color that letters or figures are drawn in clears 8:1 on the ground it sits on. lot-map's own palette did
// not: its station labels measured 7.53:1 and its counts 4.05:1 on the dark ground. The dark ground and node are
// the Explorer's page and surface, so the map sits in a view without a seam. Measured (ground / raised):
//
//   dark    bone #edf0f5 17.29 / 15.99   ash #b9c0cb 10.78 / 9.97   dim #aab1bd 9.15 / 8.46
//           hot  #f0c595 12.35 / 11.42   red #ffa2a6 10.32 / 9.54 (the fault badge letters its count in `ground` on `red`)
//   light   bone #1f2228 14.25 / 15.94   ash #444850  8.20 / 9.18   dim #45484d 8.21 / 9.18
//           hot  #673e0b  8.27 / 9.25    red #812a1c  8.23 / 9.20
//
// `accent`, `mem`, `line`, `spoke` and `trail` draw strokes and fills, never text, and are not held to that floor.
export const DARK = {
  ground: '#0a0a0f',
  raised: '#11151e',
  line: '#272c36',
  spoke: '#1a1e27',
  bone: '#edf0f5',
  ash: '#b9c0cb',
  dim: '#aab1bd',
  accent: '#e1ac6e',
  hot: '#f0c595',
  red: '#ffa2a6',
  mem: '#62c7ba',
  memHot: '#a5e6dc',
  // One step away from `bone`, so that the light rules can give the route a color of its own.
  trail: '#edf0f4',
}

export const LIGHT = {
  ground: '#f5f2ea',
  raised: '#ffffff',
  line: '#cfc9bc',
  spoke: '#e3ded2',
  bone: '#1f2228',
  ash: '#444850',
  dim: '#45484d',
  accent: '#b8762a',
  hot: '#673e0b',
  red: '#812a1c',
  mem: '#1c8c81',
  memHot: '#136a62',
  trail: '#9c978b',
}

/**
 * For `auto`: the drawing is made in the dark palette, and these rules repaint it where the surface around it is light.
 * Every color on the map is one of the palette's, written as a plain attribute, so a rule per color reaches all of it;
 * a surface that drops the rules shows the dark map, whole.
 */
export const lightRules = (own = {}) =>
  `<style>@media (prefers-color-scheme: light){${(Object.keys(DARK))
    // A color the person set stays as it is, and so does anything that shares its value with one.
    .filter(k => own[k] === undefined && !Object.values(own).includes(DARK[k]))
    .map(k => `[fill="${DARK[k]}"]{fill:${LIGHT[k]}}[stroke="${DARK[k]}"]{stroke:${LIGHT[k]}}`)
    .join('')}}</style>`

/** The names a person writes for the places of the palette. */
export const COLOR_NAMES = {
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
