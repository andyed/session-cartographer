/**
 * Text colours for the classic Explorer views: Timeline event feed, Sessions,
 * and Search. One definition, so a project reads the same hue on its badge
 * and its facet pill, and so every colour here is measured once.
 *
 * The categorical hues were One Dark's, drawn on a 13% tint of themselves.
 * On the keyboard-active search result that put a project badge at 4.6:1 and
 * a commit badge at 6.8:1; the neutral grey bucket (#5c6370) sat at 2.6:1.
 * Each hue here keeps its OKLCH hue angle with lightness raised until it
 * clears 9:1 on every ground a classic badge sits on, and badges are
 * outlined, never tinted, as AgentBadge is:
 *
 *                     page     card     list     active   hover
 *                     #0a0a0f  #0d1019  #030712  #151a23  #11151e
 *   red       #ffa2a6  10.32     9.95    10.52     9.15     9.54
 *   purple    #e99fff  10.22     9.86    10.42     9.07     9.45
 *   yellow    #e5c07b  11.43    11.03    11.66    10.14    10.57   (unchanged)
 *   cyan      #69c9d5  10.27     9.90    10.47     9.11     9.49
 *   blue      #77c1ff  10.21     9.85    10.41     9.06     9.44
 *   orange    #e8af7b  10.20     9.84    10.40     9.05     9.44
 *   green     #9cc77d  10.23     9.87    10.43     9.08     9.46
 *   pink      #fe9fba  10.24     9.87    10.43     9.08     9.46
 *   lavender  #c7adfe  10.19     9.83    10.39     9.04     9.42
 *   commit    #fea773  10.34     9.97    10.54     9.17     9.56
 *   push      #ffa29d  10.26     9.89    10.46     9.10     9.49
 *   NEUTRAL   #b9c0cb  10.78    10.40    10.99     9.57     9.97
 *   LINK      #93c5fd  10.95    10.56    11.17     9.72    10.13
 *
 * card = a session card (bg-gray-900/40 over the page); list = the event list
 * inside an open session card (bg-gray-950); active = the keyboard-active
 * search result (bg-gray-800/50 over the page); hover = a hovered group
 * header, which the timeline workspace paints --fw-surface.
 *
 * A selected facet pill is filled with its hue and lettered INK_ON_HUE, the
 * page colour, which reads at each hue's page ratio (10.19:1 at the lowest).
 *
 * NEUTRAL is also the `muted` text token in tailwind.config.js, which
 * replaced gray-400 (6.90:1 active) and gray-500 (3.62:1 active) in these
 * views, and AgentBadge's colour for an unrecognised agent. LINK is the
 * `link` token, which replaced blue-400 (6.89:1 active).
 *
 * The search combobox adds three grounds: the field (gray-900, #111827), its
 * suggestion list and co-term flyout (gray-800, #1f2937), and their active
 * rows (gray-700, #374151). `muted` is the placeholder colour (9.69:1) and the
 * flyout heading's (8.01:1). gray-800 is the lightest Tailwind gray `muted`
 * clears; on gray-700 it falls to 5.63:1, so the active rows are gray-100
 * (9.37:1) and each completion is set in bold rather than a second grey.
 *
 * These views never render on the Memory Desk's selected row (#153640).
 * Measured from computed styles on every ground above in
 * tests/browser/memory-entry.cjs.
 */

export const HUE = {
  red: '#ffa2a6',
  purple: '#e99fff',
  yellow: '#e5c07b',
  cyan: '#69c9d5',
  blue: '#77c1ff',
  orange: '#e8af7b',
  green: '#9cc77d',
  pink: '#fe9fba',
  lavender: '#c7adfe',
  commit: '#fea773',
  push: '#ffa29d',
};

export const NEUTRAL = '#b9c0cb';
export const LINK = '#93c5fd';
export const INK_ON_HUE = '#0a0a0f';

// Same order as the One Dark list it replaces, so every project keeps the
// hue it has always hashed to.
const PROJECT_HUES = [
  HUE.red, HUE.purple, HUE.yellow, HUE.cyan, HUE.blue,
  HUE.orange, HUE.green, HUE.pink, HUE.lavender, NEUTRAL,
];

export function projectColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash) + name.charCodeAt(i);
    hash |= 0;
  }
  return PROJECT_HUES[Math.abs(hash) % PROJECT_HUES.length];
}

// Diff shape quadrants (Tier 3 — COGNITIVE_ARCHITECTURE.md): the facet pill
// and the card's quadrant icon share these.
export const QUADRANT_HUES = {
  bootstrap: HUE.cyan,     // scaffolding, new + small
  construct: HUE.purple,   // new + big, design decisions
  surgical: HUE.green,     // small fixes, convergence
  rework: HUE.orange,      // big changes to existing files
};
